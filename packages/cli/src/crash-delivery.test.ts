/**
 * #1087 — the CLI records a supervised child's death and delivers every pending crash report:
 * after an offline stretch, across a restart, exactly once per account, never another account's.
 *
 * The platform here is a real HTTP server that keeps receipts by id the way
 * `POST /v1/errors/runner-crashes` does (that route's own test drives the real one); "offline" is a
 * port with nothing listening. The child death is a real process killed by a real signal.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CrashLog, crashAccountKey, crashReport } from "./crash-reports.js";
import { crashPaths, deliverCrashReports, OutputTail, recordChildExit } from "./crash-delivery.js";

let dir: string;
let paths: ReturnType<typeof crashPaths>;
let platform: { server: Server; url: string; received: Array<{ auth: string; ids: string[] }>; seen: Set<string> } | null = null;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pags-crash-delivery-"));
	paths = crashPaths(join(dir, "config"), "alice", join(dir, "runner"));
});
afterEach(async () => {
	if (platform) await new Promise((r) => platform?.server.close(r));
	platform = null;
	rmSync(dir, { recursive: true, force: true });
});

async function startPlatform(): Promise<NonNullable<typeof platform>> {
	const received: Array<{ auth: string; ids: string[] }> = [];
	const seen = new Set<string>();
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (d) => (body += d));
		req.on("end", () => {
			const ids = (JSON.parse(body).reports as Array<{ id: string }>).map((r) => r.id);
			received.push({ auth: String(req.headers.authorization), ids });
			for (const id of ids) seen.add(id);
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ accepted: ids, rejected: [] }));
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	platform = { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, received, seen };
	return platform;
}

const runtimeLog = (account: string) => new CrashLog(paths.runtimeFile, { source: "runtime", account: crashAccountKey(account) });
const runtimeCrash = (account: string, message: string) => runtimeLog(account).record(crashReport({ source: "runtime", account: crashAccountKey(account), kind: "uncaught_exception", message }));

describe("crash-reports.ts is vendored byte-identical", () => {
	it("the CLI's copy is the runner's copy", () => {
		const root = resolve(__dirname, "../../..");
		const runner = readFileSync(join(root, "packages/browser-runner/src/crash-reports.ts"), "utf8");
		expect(readFileSync(join(root, "packages/cli/src/crash-reports.ts"), "utf8")).toBe(runner);
		expect(runner.match(/^import .* from "(.*)";$/gm)?.every((l) => l.includes('"node:'))).toBe(true);
	});
});

describe("delivery (#1087)", () => {
	it("offline: everything stays pending; reconnected: delivered once; again: nothing is re-sent", async () => {
		runtimeCrash("alice", "runtime blew up");
		recordChildExit({ paths, account: "alice", build: "0.4.130", kind: "runner_exit", what: "the local runtime", code: null, signal: "SIGKILL", tail: [] });

		const offline = await deliverCrashReports({ apiBase: "http://127.0.0.1:9", token: "tok", account: "alice", paths });
		expect(offline).toMatchObject({ delivered: 0, pending: 2 });
		expect(offline.error).toBeTruthy();

		const p = await startPlatform();
		expect(await deliverCrashReports({ apiBase: p.url, token: "tok", account: "alice", paths })).toEqual({ delivered: 2, pending: 0 });
		expect(p.received).toHaveLength(1);
		expect(p.received[0].auth).toBe("Bearer tok");

		expect(await deliverCrashReports({ apiBase: p.url, token: "tok", account: "alice", paths })).toEqual({ delivered: 0, pending: 0 });
		expect(p.received).toHaveLength(1);
		// The CLI's own acknowledged report is gone from its file; the runtime's file was never written.
		expect(new CrashLog(paths.cliFile).read().reports).toEqual([]);
		expect(runtimeLog("alice").read().reports).toHaveLength(1);
	});

	it("a restart (a fresh process reading the same files) delivers what an earlier one could not", async () => {
		runtimeCrash("alice", "before the restart");
		await deliverCrashReports({ apiBase: "http://127.0.0.1:9", token: "tok", account: "alice", paths });
		const p = await startPlatform();
		const again = crashPaths(join(dir, "config"), "alice", join(dir, "runner"));
		expect((await deliverCrashReports({ apiBase: p.url, token: "tok", account: "alice", paths: again })).delivered).toBe(1);
	});

	it("never sends another account's report, or one with no account", async () => {
		runtimeCrash("bob", "bob's runner");
		runtimeLog("x").record(crashReport({ source: "runtime", kind: "uncaught_exception", message: "no account" }));
		runtimeCrash("alice", "alice's runner");
		const p = await startPlatform();
		const result = await deliverCrashReports({ apiBase: p.url, token: "alice-token", account: "alice", paths });
		expect(result.delivered).toBe(1);
		const sent = runtimeLog("alice").read().reports.filter((r) => p.seen.has(r.id));
		expect(sent.map((r) => r.message)).toEqual(["alice's runner"]);
	});

	it("a refusal from the platform keeps the reports pending", async () => {
		runtimeCrash("alice", "kept");
		const server = createServer((_req, res) => {
			res.statusCode = 503;
			res.end();
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		try {
			const result = await deliverCrashReports({ apiBase: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: "t", account: "alice", paths });
			expect(result).toMatchObject({ delivered: 0, pending: 1, error: "the platform answered 503" });
		} finally {
			await new Promise((r) => server.close(r));
		}
	});
});

describe("a supervised child's death (#1087)", () => {
	it("a child killed by a signal is recorded WITH the signal and its last lines — code null used to say nothing", async () => {
		const tail = new OutputTail(20);
		const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
			const child = spawn(process.execPath, ["-e", "console.error('about to die with Bearer abcdefghijklmnopqrst'); setTimeout(() => process.kill(process.pid, 'SIGKILL'), 50)"], { stdio: ["ignore", "ignore", "pipe"] });
			child.stderr.on("data", (d) => tail.push(d));
			child.on("exit", (code, signal) => done({ code, signal }));
		});
		expect(exit).toEqual({ code: null, signal: "SIGKILL" });
		const report = recordChildExit({ paths, account: "alice", build: "0.4.130", kind: "runner_exit", what: "the local runtime", ...exit, tail: tail.lines() });
		expect(report).toMatchObject({ kind: "runner_exit", signal: "SIGKILL", exitCode: null, build: "0.4.130", message: "the local runtime was killed by SIGKILL", account: crashAccountKey("alice") });
		expect(report.tail?.join("\n")).toMatch(/about to die with Bearer \[redacted\]/);
		expect(new CrashLog(paths.cliFile).read().reports).toEqual([report]);
	});
});
