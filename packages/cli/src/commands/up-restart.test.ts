/**
 * `pags up` restarts leave no blocked ancestor (#1036).
 *
 * The live failure: six `pags up` processes chained parent → child on one machine after two days,
 * because each restart ran the next `pags up` with `execFileSync` and waited on it forever. The
 * process tests below run the REAL `restartPagsUp` in real Node processes (a throwaway script that
 * stands in for `pags up`), restart it twice, and count what is left.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RestartDeps, restartPagsUp, UP_LAUNCHER_ENV, upRestartMode } from "./up-restart.js";
import { RESTART_COMMAND_ENV, RUNNER_RESTART_EXIT_CODE, SERVICE_ENV } from "./runner/self-update.js";

describe("upRestartMode (#1036)", () => {
	it("hands a supervised pags up back to its supervisor", () => {
		expect(upRestartMode({ [SERVICE_ENV]: "1" }, "darwin", true)).toBe("service");
		expect(upRestartMode({ [RESTART_COMMAND_ENV]: "tmux respawn-pane -k" }, "linux", true)).toBe("command");
		expect(upRestartMode({ [UP_LAUNCHER_ENV]: "1" }, "linux", true)).toBe("launcher-child");
	});

	it("replaces the process in place where it can, and keeps one launcher where it cannot", () => {
		expect(upRestartMode({}, "darwin", true)).toBe("exec");
		expect(upRestartMode({}, "linux", false)).toBe("launcher");
		expect(upRestartMode({}, "win32", true)).toBe("launcher");
	});
});

describe("restartPagsUp (#1036)", () => {
	const deps = (over: Partial<RestartDeps> = {}): RestartDeps => ({
		env: {},
		platform: "darwin",
		execPath: "/node",
		execArgv: [],
		script: "/pags",
		execve: vi.fn(),
		spawn: vi.fn(() => ({ unref: () => {} })) as never,
		spawnSync: vi.fn(() => ({ status: 0 })) as never,
		exit: vi.fn(),
		log: vi.fn(),
		...over,
	});

	it("execs in place with the same flags and the extra env, starting no child", () => {
		const d = deps({ env: { A: "1" } });
		restartPagsUp(["up", "--headless"], { PAGS_NO_PROMPT: "1" }, d);
		expect(d.execve).toHaveBeenCalledWith("/node", ["/node", "/pags", "up", "--headless"], { A: "1", PAGS_NO_PROMPT: "1" });
		expect(d.spawnSync).not.toHaveBeenCalled();
		expect(d.exit).not.toHaveBeenCalled();
	});

	it("a service exits with the restart code; a restart command is started detached, then it exits", () => {
		const svc = deps({ env: { [SERVICE_ENV]: "1" } });
		restartPagsUp(["up"], {}, svc);
		expect(svc.exit).toHaveBeenCalledWith(RUNNER_RESTART_EXIT_CODE);
		expect(svc.execve).not.toHaveBeenCalled();

		// `leaveForRestart` (self-update.ts, shared with the runner) reads the command from process.env.
		vi.stubEnv(RESTART_COMMAND_ENV, "pags up");
		try {
			const cmd = deps({ env: { [RESTART_COMMAND_ENV]: "pags up" } });
			restartPagsUp(["up"], {}, cmd);
			expect(cmd.spawn).toHaveBeenCalledWith("pags up", expect.objectContaining({ detached: true, shell: true }));
			expect(cmd.exit).toHaveBeenCalledWith(0);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("the launcher runs pags up again while it asks for a restart, unattended after the first", () => {
		const statuses = [RUNNER_RESTART_EXIT_CODE, RUNNER_RESTART_EXIT_CODE, 0];
		const spawnSyncFn = vi.fn(() => ({ status: statuses.shift() }));
		const d = deps({ platform: "win32", spawnSync: spawnSyncFn as never });
		restartPagsUp(["up"], {}, d);
		expect(spawnSyncFn).toHaveBeenCalledTimes(3);
		const envs = spawnSyncFn.mock.calls.map((c) => (c as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2].env);
		expect(envs.every((e) => e[UP_LAUNCHER_ENV] === "1")).toBe(true);
		expect(envs.map((e) => e.PAGS_NO_PROMPT)).toEqual([undefined, "1", "1"]);
		expect(d.exit).toHaveBeenCalledWith(0);
	});

	it("a failed restart says so and exits non-zero, never 0", () => {
		const d = deps({ execve: vi.fn(() => { throw new Error("ENOENT"); }) });
		restartPagsUp(["up"], {}, d);
		expect(d.exit).toHaveBeenCalledWith(1);
		expect(d.log).toHaveBeenCalledWith(expect.stringMatching(/NOT running/));

		const l = deps({ platform: "win32", spawnSync: vi.fn(() => ({ status: 3 })) as never });
		restartPagsUp(["up"], {}, l);
		expect(l.exit).toHaveBeenCalledWith(3);
	});
});

/**
 * Real processes. The stand-in records one line per start — `{pid, ppid, alive}` where `alive` is how
 * many processes are running this script right now — and restarts itself until it has started three
 * times (two restarts).
 */
describe.skipIf(process.platform === "win32")("two consecutive restarts in real processes (#1036)", () => {
	let dir: string;
	let script: string;
	let log: string;
	const moduleUrl = pathToFileURL(join(import.meta.dirname, "up-restart.ts")).href;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-up-restart-"));
		script = join(dir, "pags-up-standin.mjs");
		log = join(dir, "starts.jsonl");
		writeFileSync(
			script,
			`import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const { processRestartDeps, restartPagsUp } = await import(${JSON.stringify(moduleUrl)});
const log = ${JSON.stringify(log)};
const starts = existsSync(log) ? readFileSync(log, "utf8").split("\\n").filter(Boolean).length : 0;
const alive = execFileSync("ps", ["-A", "-o", "command="], { encoding: "utf8" }).split("\\n").filter((l) => l.includes(${JSON.stringify(script)})).length;
appendFileSync(log, JSON.stringify({ pid: process.pid, ppid: process.ppid, alive }) + "\\n");
if (starts < 2) restartPagsUp(["--standin"], {}, { ...processRestartDeps(), ...(process.env.STANDIN_NO_EXECVE ? { execve: undefined } : {}) });
`,
		);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const starts = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { pid: number; ppid: number; alive: number });
	const run = (env: NodeJS.ProcessEnv = {}) =>
		spawnSync(process.execPath, ["--import", "tsx", script], { cwd: join(import.meta.dirname, "..", ".."), env: { ...process.env, [SERVICE_ENV]: "", [RESTART_COMMAND_ENV]: "", [UP_LAUNCHER_ENV]: "", ...env }, encoding: "utf8", timeout: 60_000 });

	it.skipIf(typeof (process as { execve?: unknown }).execve !== "function")("in a terminal: the same process restarts in place, and exactly one is ever running", () => {
		const r = run();
		expect(r.status).toBe(0);
		const s = starts();
		expect(s).toHaveLength(3);
		expect(new Set(s.map((x) => x.pid)).size).toBe(1); // one process, replaced in place
		expect(s.every((x) => x.ppid === process.pid)).toBe(true); // no ancestor between it and its starter
		expect(s.map((x) => x.alive)).toEqual([1, 1, 1]);
	});

	it("under a service: each start exits to the supervisor, and exactly one is ever running", () => {
		const statuses: Array<number | null> = [];
		for (let i = 0; i < 5; i++) {
			const r = run({ [SERVICE_ENV]: "1" });
			statuses.push(r.status);
			if (r.status !== RUNNER_RESTART_EXIT_CODE) break;
		}
		expect(statuses).toEqual([RUNNER_RESTART_EXIT_CODE, RUNNER_RESTART_EXIT_CODE, 0]);
		const s = starts();
		expect(s.every((x) => x.ppid === process.pid)).toBe(true);
		expect(s.map((x) => x.alive)).toEqual([1, 1, 1]);
	});

	it("without execve (as on Windows): one launcher stays, and the chain does not grow with each restart", () => {
		const r = run({ STANDIN_NO_EXECVE: "1" });
		expect(r.status).toBe(0);
		const [launcher, ...after] = starts();
		expect(after).toHaveLength(2);
		// Every later start is the launcher's own child — never a child of the previous one.
		expect(after.every((x) => x.ppid === launcher.pid)).toBe(true);
		expect(after.map((x) => x.alive)).toEqual([2, 2]);
	});
});

