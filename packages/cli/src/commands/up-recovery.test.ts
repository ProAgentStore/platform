/**
 * `pags up` comes back from what kills it — proven with real processes (#1154).
 *
 *   - kill the runner: the `pags up` holding it hands the death to its launcher, which starts a new one;
 *   - kill the launcher: its orphaned `pags up` takes over as the launcher when its runner next dies;
 *   - a failed update: a release that dies at every start is started again by the launcher until the bootstrap
 *     stub gives it up and runs the previous version — and one that crashes on import is rolled back at once.
 *
 * The stand-in for `pags up` is a few lines of glue around the REAL `restartPagsUp`, `upRestartMode` and
 * `runnerExitAction` — the same calls `up.ts` makes, in the same order — and its "runner" is a real child process.
 * The update case runs the REAL bootstrap stub (`runStub`) over a real payload cache. Reboot is not covered here:
 * that is the OS unit's `RunAtLoad` / `WantedBy=default.target` / `-AtStartup`, asserted in service-install.test.ts.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activatePayload, beginTrial, badVersions } from "../bootstrap/trial.js";
import { UP_LAUNCHER_ENV, UP_LAUNCHER_PID_ENV } from "./up-restart.js";
import { RESTART_COMMAND_ENV, SERVICE_ENV } from "./runner/self-update.js";

const cliRoot = join(import.meta.dirname, "..", "..");
const url = (file: string) => JSON.stringify(pathToFileURL(join(import.meta.dirname, file)).href);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
async function until<T>(what: string, read: () => T | undefined | false, ms = 30_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const v = read();
		if (v) return v;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(50);
	}
}

let dir: string;
let events: string;
const started: ChildProcess[] = [];
const cleanEnv = () => ({ ...process.env, [SERVICE_ENV]: "", [RESTART_COMMAND_ENV]: "", [UP_LAUNCHER_ENV]: "", [UP_LAUNCHER_PID_ENV]: "", PAGS_NO_PROMPT: "" });
const read = () => (existsSync(events) ? readFileSync(events, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, number | string>) : []);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pags-up-recovery-"));
	events = join(dir, "events.jsonl");
});
afterEach(() => {
	for (const e of read()) if (typeof e.pid === "number" && alive(e.pid)) process.kill(e.pid, "SIGKILL");
	for (const c of started) c.kill("SIGKILL");
	started.length = 0;
	rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("kill the runner, kill the launcher — in real processes (#1154)", () => {
	let script: string;
	beforeEach(() => {
		script = join(dir, "pags-up-standin.mjs");
		const runner = join(dir, "runner.mjs");
		// The runner: lives until killed; SIGTERM is a deliberate stop (exit 0), as `pags down` makes one. It announces
		// itself only once that handler is installed, so the test never signals a runner still starting up.
		writeFileSync(
			runner,
			`import { appendFileSync } from "node:fs";\nprocess.on("SIGTERM", () => process.exit(0));\nsetInterval(() => {}, 1000);\nappendFileSync(${JSON.stringify(events)}, JSON.stringify({ role: "runner", pid: process.pid, up: Number(process.argv[2]) }) + "\\n");\n`,
		);
		writeFileSync(
			script,
			`import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
const { processRestartDeps, restartPagsUp, runnerExitAction, RUNNER_DIED_EXIT_CODE, upRestartMode } = await import(${url("up-restart.ts")});
const note = (e) => appendFileSync(${JSON.stringify(events)}, JSON.stringify(e) + "\\n");
const deps = () => ({ ...processRestartDeps(), sleep: () => {} });
// up.ts, step one: a terminal pags up with no owner above it becomes the launcher.
if (upRestartMode(process.env) === "launcher") {
	note({ role: "launcher", pid: process.pid });
	restartPagsUp(["--standin"], {}, deps(), { initial: true });
} else {
	note({ role: "up", pid: process.pid, ppid: process.ppid });
	const runner = spawn(process.execPath, [${JSON.stringify(runner)}, String(process.pid)], { stdio: "ignore" });
	// up.ts's child.on("exit"), with the same decision.
	runner.on("exit", (code) => {
		const action = runnerExitAction(code, false);
		note({ role: "runner-exit", up: process.pid, code: code ?? "signal", action });
		if (action === "stop") process.exit(0);
		if (action === "died") restartPagsUp(["--standin"], { PAGS_NO_PROMPT: "1" }, deps(), { exitCode: RUNNER_DIED_EXIT_CODE });
	});
}
`,
		);
	});
	const start = () => {
		const c = spawn(process.execPath, ["--import", "tsx", script], { cwd: cliRoot, env: cleanEnv(), stdio: "ignore" });
		started.push(c);
		return c;
	};
	const runners = () => read().filter((e) => e.role === "runner");
	const ups = () => read().filter((e) => e.role === "up");

	it("kill the runner: the launcher starts pags up again, and a deliberate stop then ends it cleanly", async () => {
		const launcher = start();
		const exited = new Promise<number | null>((r) => launcher.on("exit", (code) => r(code)));
		const first = await until("the first runner", () => runners()[0]);
		process.kill(first.pid as number, "SIGKILL");

		const second = await until("a second runner", () => runners()[1]);
		const [up1, up2] = ups();
		expect(up2.pid).not.toBe(up1.pid);
		expect(up2.ppid).toBe(launcher.pid); // the launcher's own child — the chain does not grow
		expect(read().find((e) => e.role === "runner-exit")).toMatchObject({ up: up1.pid, action: "died" });
		expect(alive(up1.pid as number)).toBe(false); // the old pags up handed it over (76) and left

		process.kill(second.pid as number, "SIGTERM"); // `pags down`
		expect(await exited).toBe(0);
		expect(runners()).toHaveLength(2);
	}, 60_000);

	it("kill the launcher: its orphaned pags up becomes the launcher when the runner next dies", async () => {
		const launcher = start();
		const first = await until("the first runner", () => runners()[0]);
		const up1 = ups()[0];
		launcher.kill("SIGKILL");
		await until("the launcher to die", () => !alive(launcher.pid as number));
		expect(alive(up1.pid as number)).toBe(true); // still serving
		process.kill(first.pid as number, "SIGKILL");

		const second = await until("a second runner", () => runners()[1]);
		const up2 = ups()[1];
		expect(up2.ppid).toBe(up1.pid); // the orphan took the launcher's place, it did not exit to nobody
		expect(alive(up1.pid as number)).toBe(true);

		process.kill(second.pid as number, "SIGTERM");
		await until("the new launcher to leave", () => !alive(up1.pid as number));
	}, 60_000);
});

describe.skipIf(process.platform === "win32")("a failed update, in real processes (#1154)", () => {
	let root: string;
	let stub: string;
	let launcher: string;
	const payload = (version: string, body: string) => {
		const pkg = join(root, version, "node_modules", "@proagentstore", "cli");
		mkdirSync(join(pkg, "dist"), { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@proagentstore/cli", version }));
		writeFileSync(join(pkg, "dist", "index.js"), `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(events)}, JSON.stringify({ version: ${JSON.stringify(version)}, pid: process.pid }) + "\\n");\n${body}\n`);
	};
	beforeEach(() => {
		root = join(dir, "cli");
		stub = join(dir, "pags-stub.mjs");
		launcher = join(dir, "pags-launcher.mjs");
		// The installed `pags`: the real bootstrap stub over this cache. 1.0.1 is the published release.
		writeFileSync(stub, `const { runStub } = await import(${url("../bootstrap/stub.ts")});\nawait runStub({ bundled: null, args: process.argv.slice(2), self: process.argv[1], fromSource: false, latest: async () => "1.0.1", log: () => {} });\n`);
		// A terminal pags up after an update: the real launcher, starting the stub. No backoff wait, for the test.
		writeFileSync(launcher, `const { processRestartDeps, restartPagsUp } = await import(${url("up-restart.ts")});\nrestartPagsUp(["up"], { PAGS_NO_PROMPT: "1" }, { ...processRestartDeps(), script: ${JSON.stringify(stub)}, execArgv: ["--import", "tsx"], sleep: () => {} });\n`);
		payload("1.0.0", "process.exit(0);"); // the version that worked: it starts, and here it is stopped at once
	});
	const run = () =>
		new Promise<number | null>((resolve) => {
			const c = spawn(process.execPath, ["--import", "tsx", launcher], { cwd: cliRoot, env: { ...cleanEnv(), PAGS_CLI_CACHE: root }, stdio: "ignore" });
			started.push(c);
			c.on("exit", (code) => resolve(code));
		});
	const versions = () => read().map((e) => e.version);

	it("a release that dies at every start is retried until the stub gives it up — and the previous version comes back", async () => {
		payload("1.0.1", "process.exit(1);"); // dies before it ever registers, like a broken release
		beginTrial(root, "1.0.1", "1.0.0"); activatePayload(root, "1.0.1"); // what installVersion records when it installs 1.0.1
		expect(await run()).toBe(0);
		// Six tries of the new release (MAX_TRIAL_STARTS), then the one before it: the machine is not left without one.
		expect(versions()).toEqual(["1.0.1", "1.0.1", "1.0.1", "1.0.1", "1.0.1", "1.0.1", "1.0.0"]);
		expect(badVersions(root)["1.0.1"]).toMatch(/started 6 times without registering/);
	}, 60_000);

	it("a release that crashes on import is rolled back in the same start", async () => {
		payload("1.0.1", `throw new Error("boom on import");`);
		beginTrial(root, "1.0.1", "1.0.0"); activatePayload(root, "1.0.1");
		expect(await run()).toBe(0);
		expect(versions()).toEqual(["1.0.1", "1.0.0"]);
		expect(badVersions(root)["1.0.1"]).toMatch(/crashed on start: boom on import/);
	}, 60_000);

	it("once given up on, the release is never started again", async () => {
		payload("1.0.1", "process.exit(1);");
		beginTrial(root, "1.0.1", "1.0.0"); activatePayload(root, "1.0.1");
		await run();
		rmSync(events, { force: true });
		expect(await run()).toBe(0);
		expect(versions()).toEqual(["1.0.0"]);
	}, 90_000);
});
