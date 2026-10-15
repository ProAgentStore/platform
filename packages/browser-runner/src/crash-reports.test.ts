/**
 * #1087 — the runtime's crashes survive the process, and its store survives a crash.
 *
 * Process failures are REAL processes: a child that throws and rejects, and the runtime's own
 * entrypoint (`index.ts`) started on a port that is already taken. Interrupted writes and corrupt
 * files are the files a crash actually leaves: a stray temp file beside a good one, bytes that do
 * not parse. Everything is read back from disk.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CrashLog, MAX_QUARANTINED, MAX_REPORTS, crashReport, describeError, writeJsonAtomic } from "./crash-reports.js";
import { MAX_EVENTS, RunnerStore } from "./store.js";
import { startRunnerServer } from "./server.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TSX = createRequire(import.meta.url).resolve("tsx/cli");

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pags-crash-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = () => join(dir, "crash-reports.json");
const onDisk = () => JSON.parse(readFileSync(file(), "utf-8")) as { reports: Array<Record<string, unknown>>; dropped: number };
const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
	new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve) => {
		const child = spawn(process.execPath, [TSX, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (d) => (stderr += d));
		const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal, stderr });
		});
	});

describe("a crashing process leaves a durable, sanitized record (#1087)", () => {
	it("an uncaught exception and an unhandled rejection — stack, cause, build and account — survive the process", async () => {
		const script = join(mkdtempSync(join(tmpdir(), "pags-crash-script-")), "crash.ts");
		writeFileSync(
			script,
			`import { CrashLog, installCrashHandlers } from ${JSON.stringify(join(HERE, "crash-reports.ts"))};
const base = { source: "runtime" as const, build: "0.4.999", account: "acct1234" };
installCrashHandlers(new CrashLog(process.argv[2], base), base);
void Promise.reject(new Error("rejected with Bearer abcdefghijklmnopqrstuvwxyz"));
setTimeout(() => { throw new TypeError("boom", { cause: new Error("the root cause") }); }, 20);
setTimeout(() => process.exit(7), 300);
`,
		);
		const { code } = await run([script, file()]);
		expect(code).toBe(7); // the handlers recorded, and did not stop the process
		const { reports } = onDisk();
		expect(reports.map((r) => r.kind).sort()).toEqual(["uncaught_exception", "unhandled_rejection"]);
		const uncaught = reports.find((r) => r.kind === "uncaught_exception");
		expect(uncaught).toMatchObject({ source: "runtime", build: "0.4.999", account: "acct1234", message: "TypeError: boom", cause: "Error: the root cause" });
		expect(String(uncaught?.stack)).toMatch(/TypeError: boom/);
		expect(JSON.stringify(reports)).not.toContain("abcdefghijklmnopqrstuvwxyz");
		rmSync(dirname(script), { recursive: true, force: true });
	});

	it("the runtime's own entrypoint, unable to bind its port, records a startup failure and EXITS — it used to hang", async () => {
		const busy: Server = createServer();
		await new Promise<void>((r) => busy.listen(0, "127.0.0.1", r));
		const port = (busy.address() as { port: number }).port;
		try {
			const { code, stderr } = await run([join(HERE, "index.ts"), "--port", String(port), "--data-dir", dir, "--token", "t"], {
				PAGS_RUNNER_BUILD: "0.4.998",
				PAGS_RUNNER_ACCOUNT: "acct5678",
				PAGS_INSTANCE_ID: "inst-9",
			});
			expect(code).toBe(1);
			expect(stderr).toMatch(/could not start \(listen\)/);
			expect(onDisk().reports).toContainEqual(expect.objectContaining({ kind: "startup_failure", route: "listen", build: "0.4.998", account: "acct5678", instanceId: "inst-9", message: expect.stringMatching(/EADDRINUSE/) }));
		} finally {
			busy.close();
		}
	}, 40_000);

	it("a request that fails on the runtime's side is recorded with its route and correlation — a caller's bad input is not", async () => {
		const started = await startRunnerServer({ host: "127.0.0.1", port: 0, dataDir: dir, token: "secret", instanceId: "inst-1", headless: true });
		try {
			started.runner.store.listTasks = () => {
				throw new Error("disk went away token=supersecretvalue");
			};
			const headers = { Authorization: "Bearer secret", "X-PAGS-Instance-Id": "inst-1" };
			expect((await fetch(`${started.url}/tasks`, { headers })).status).toBe(500);
			expect((await fetch(`${started.url}/tasks`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" })).status).toBeLessThan(500);
			const { reports } = onDisk();
			expect(reports).toEqual([expect.objectContaining({ kind: "request_failure", route: "GET /tasks", instanceId: "inst-1" })]);
			expect(JSON.stringify(reports)).not.toContain("supersecretvalue");
		} finally {
			await started.close();
		}
	});
});

describe("crash-safe files (#1087)", () => {
	it("an interrupted write leaves the previous file intact, and its stray temp file is removed on the next open", () => {
		const log = new CrashLog(file());
		log.record(crashReport({ source: "runtime", kind: "request_failure", message: "first" }));
		// What a kill between the temp write and the rename leaves: a half-written temp beside the good file.
		writeFileSync(`${file()}.4242.dead.tmp`, '{"reports":[{"id":"half');
		expect(new CrashLog(file()).read().reports.map((r) => r.message)).toEqual(["first"]);
		expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
	});

	it("a corrupt crash file is QUARANTINED byte-for-byte and reported — not read as empty and overwritten", () => {
		writeFileSync(file(), "{not json at all");
		const log = new CrashLog(file(), { source: "runtime", account: "acct1" });
		log.record(crashReport({ source: "runtime", kind: "uncaught_exception", message: "after" }));
		const quarantined = readdirSync(dir).filter((n) => n.startsWith("crash-reports.json.corrupt-"));
		expect(quarantined).toHaveLength(1);
		expect(readFileSync(join(dir, quarantined[0]), "utf-8")).toBe("{not json at all");
		expect(onDisk().reports.map((r) => [r.kind, r.account ?? null])).toEqual([
			["store_corrupt", "acct1"],
			["uncaught_exception", null],
		]);
		expect(String(onDisk().reports[0].message)).toContain(quarantined[0]);
	});

	it("quarantined copies are bounded too", () => {
		for (let i = 0; i < MAX_QUARANTINED + 3; i++) {
			writeFileSync(file(), `garbage ${i}`);
			new CrashLog(file()).read();
		}
		expect(readdirSync(dir).filter((n) => n.includes(".corrupt-")).length).toBeLessThanOrEqual(MAX_QUARANTINED);
	});

	it("the report file is bounded, and the truncation is counted", () => {
		const log = new CrashLog(file());
		for (let i = 0; i < MAX_REPORTS + 5; i++) log.record(crashReport({ source: "runtime", kind: "request_failure", message: `m${i}` }));
		const { reports, dropped } = onDisk();
		expect(reports).toHaveLength(MAX_REPORTS);
		expect(dropped).toBe(5);
		expect(reports[0].message).toBe("m5"); // oldest dropped first
	});

	it("a report survives a restart, and recording the same id twice keeps one", () => {
		const r = crashReport({ source: "runtime", kind: "uncaught_exception", message: "once" });
		new CrashLog(file()).record(r);
		new CrashLog(file()).record(r);
		expect(new CrashLog(file()).read().reports).toEqual([r]);
	});

	it("bounds and masks what it records: a clipped stack says so, credentials are masked", () => {
		const err = new Error(`failed with sk-ant-api03-${"x".repeat(30)} and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJlLXZhbHVl`);
		err.stack = `${err.message}\n${"    at frame\n".repeat(1000)}`;
		const d = describeError(err);
		expect(d.message).not.toMatch(/sk-ant|eyJzdWIi/);
		expect(d.stack?.length).toBeLessThan(4200);
		expect(d.stack).toMatch(/\[cut: showing the first 4000 of \d+ characters\]$/);
	});

	it("writeJsonAtomic never leaves a temp file behind on success", () => {
		writeJsonAtomic(file(), { ok: true });
		expect(readdirSync(dir)).toEqual(["crash-reports.json"]);
	});
});

describe("the runner store (#1087)", () => {
	const storeFile = () => join(dir, "runner-store.json");

	it("a corrupt store is quarantined and reported, then the runner continues on a fresh one — the evidence is not overwritten", () => {
		writeFileSync(storeFile(), '{"tasks":[{"id":"t1"'); // a truncated write
		const store = new RunnerStore(dir);
		expect(store.listTasks()).toEqual([]);
		store.addEvent({ type: "x", message: "after" } as never);
		const moved = readdirSync(dir).filter((n) => n.startsWith("runner-store.json.corrupt-"));
		expect(moved).toHaveLength(1);
		expect(readFileSync(join(dir, moved[0]), "utf-8")).toBe('{"tasks":[{"id":"t1"');
		expect(onDisk().reports).toContainEqual(expect.objectContaining({ kind: "store_corrupt", message: expect.stringContaining(moved[0]) }));
	});

	it("a stray temp file from an interrupted write does not replace the store", () => {
		const store = new RunnerStore(dir);
		store.addEvent({ type: "x", message: "kept" } as never);
		writeFileSync(`${storeFile()}.99.dead.tmp`, "{");
		expect(new RunnerStore(dir).listEvents().map((e) => e.message)).toEqual(["kept"]);
		expect(existsSync(`${storeFile()}.99.dead.tmp`)).toBe(false);
	});

	it("the event buffer keeps the newest 500 and COUNTS what it dropped", () => {
		const store = new RunnerStore(dir);
		for (let i = 0; i < MAX_EVENTS + 7; i++) store.addEvent({ type: "x", message: `e${i}` } as never);
		expect(store.listEvents(1000)).toHaveLength(MAX_EVENTS);
		expect(store.listEvents(1)[0].message).toBe(`e${MAX_EVENTS + 6}`);
		expect(store.droppedEventCount()).toBe(7);
	});
});
