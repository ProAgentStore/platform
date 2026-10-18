/**
 * `pags up` restarts leave no blocked ancestor (#1036) — and always come back (#1151).
 *
 * The live failures: six `pags up` processes chained parent → child on one machine after two days,
 * because each restart ran the next `pags up` with `execFileSync` and waited on it forever (#1036);
 * then every machine that auto-updated to 0.4.149 relaunched itself and was never heard from again,
 * because nothing outlived a respawn that failed (#1151). The process tests below run the REAL
 * `restartPagsUp` in real Node processes (a throwaway script that stands in for `pags up`), restart
 * it, fail one start, and count what is left.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { relaunchDelayMs, type RestartDeps, restartPagsUp, UP_LAUNCHER_ENV, upRestartMode } from "./up-restart.js";
import { RESTART_COMMAND_ENV, RUNNER_RESTART_EXIT_CODE, SERVICE_ENV } from "./runner/self-update.js";

describe("upRestartMode (#1036)", () => {
	it("hands a supervised pags up back to its supervisor", () => {
		expect(upRestartMode({ [SERVICE_ENV]: "1" })).toBe("service");
		expect(upRestartMode({ [RESTART_COMMAND_ENV]: "tmux respawn-pane -k" })).toBe("command");
		expect(upRestartMode({ [UP_LAUNCHER_ENV]: "1" })).toBe("launcher-child");
	});

	it("otherwise stays as the one launcher — never replaces itself in place, which leaves nothing to retry a failed start (#1151)", () => {
		expect(upRestartMode({})).toBe("launcher");
	});

	it("waits 10s after a failed unattended start, doubling, never more than 5 minutes", () => {
		expect([1, 2, 3, 4, 5, 6, 20].map(relaunchDelayMs)).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
	});
});

describe("restartPagsUp (#1036)", () => {
	const deps = (over: Partial<RestartDeps> = {}): RestartDeps => ({
		env: {},
		execPath: "/node",
		execArgv: [],
		script: "/pags",
		spawn: vi.fn(() => ({ unref: () => {} })) as never,
		spawnSync: vi.fn(() => ({ status: 0 })) as never,
		exit: vi.fn(),
		log: vi.fn(),
		sleep: vi.fn(),
		step: vi.fn(),
		...over,
	});

	it("starts pags up again with the same flags and the extra env, as the launcher's child", () => {
		const spawnSyncFn = vi.fn(() => ({ status: 0 }));
		const d = deps({ env: { A: "1" }, spawnSync: spawnSyncFn as never });
		restartPagsUp(["up", "--headless"], { PAGS_NO_PROMPT: "1" }, d);
		const [file, argv, options] = spawnSyncFn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
		expect([file, argv]).toEqual(["/node", ["/pags", "up", "--headless"]]);
		expect(options.env).toMatchObject({ A: "1", PAGS_NO_PROMPT: "1", [UP_LAUNCHER_ENV]: "1" });
		expect(d.exit).toHaveBeenCalledWith(0);
	});

	it("a service exits with the restart code; a restart command is started detached, then it exits", () => {
		const svc = deps({ env: { [SERVICE_ENV]: "1" } });
		restartPagsUp(["up"], {}, svc);
		expect(svc.exit).toHaveBeenCalledWith(RUNNER_RESTART_EXIT_CODE);
		expect(svc.spawnSync).not.toHaveBeenCalled();

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
		const d = deps({ spawnSync: spawnSyncFn as never });
		restartPagsUp(["up"], {}, d);
		expect(spawnSyncFn).toHaveBeenCalledTimes(3);
		const envs = spawnSyncFn.mock.calls.map((c) => (c as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2].env);
		expect(envs.every((e) => e[UP_LAUNCHER_ENV] === "1")).toBe(true);
		expect(envs.map((e) => e.PAGS_NO_PROMPT)).toEqual([undefined, "1", "1"]);
		expect(d.exit).toHaveBeenCalledWith(0);
	});

	it("an `r` restart that fails, with someone at the keyboard, says so and exits non-zero, never 0", () => {
		const d = deps({ spawnSync: vi.fn(() => ({ status: null, error: new Error("ENOENT") })) as never });
		restartPagsUp(["up"], {}, d);
		expect(d.exit).toHaveBeenCalledWith(1);
		expect(d.log).toHaveBeenCalledWith(expect.stringMatching(/NOT running/));

		const l = deps({ spawnSync: vi.fn(() => ({ status: 3 })) as never });
		restartPagsUp(["up"], {}, l);
		expect(l.exit).toHaveBeenCalledWith(3);
	});

	it("#1151: after a remote update a pags up that fails to start is started again, with backoff, until one comes up", () => {
		// The restart after an update: the new release fails twice (a network blip, a lock not yet released), then comes up.
		const statuses: Array<{ status: number | null; signal?: string }> = [{ status: 1 }, { status: null, signal: "SIGKILL" }, { status: 0 }];
		const spawnSyncFn = vi.fn(() => statuses.shift());
		const d = deps({ spawnSync: spawnSyncFn as never });
		restartPagsUp(["up"], { PAGS_NO_PROMPT: "1" }, d);
		expect(spawnSyncFn).toHaveBeenCalledTimes(3);
		expect(d.sleep).toHaveBeenNthCalledWith(1, 10_000);
		expect(d.sleep).toHaveBeenNthCalledWith(2, 20_000);
		expect(d.exit).toHaveBeenCalledTimes(1);
		expect(d.exit).toHaveBeenCalledWith(0);
		// Every step is in the update log: why each start ended, and each retry.
		const steps = (d.step as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
		expect(steps).toEqual(expect.arrayContaining(["launcher: pags up exited 1", "launcher: pags up was killed by SIGKILL", "launcher: retrying in 10s (failure 1)", "launcher: retrying in 20s (failure 2)"]));
	});

	it("#1151: a failure after a successful update cycle starts the backoff from 10s again", () => {
		const statuses = [{ status: 1 }, { status: RUNNER_RESTART_EXIT_CODE }, { status: 1 }, { status: 0 }];
		const d = deps({ spawnSync: vi.fn(() => statuses.shift()) as never });
		restartPagsUp(["up"], { PAGS_NO_PROMPT: "1" }, d);
		expect((d.sleep as ReturnType<typeof vi.fn>).mock.calls).toEqual([[10_000], [10_000]]);
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
// STANDIN_FAIL_AT: that start fails as a respawned release can (#1151); the launcher must start it again.
if (process.env.STANDIN_FAIL_AT && starts === Number(process.env.STANDIN_FAIL_AT)) process.exit(1);
if (starts < Number(process.env.STANDIN_RESTARTS ?? 2)) restartPagsUp(["--standin"], {}, { ...processRestartDeps(), sleep: () => {} });
`,
		);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const starts = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { pid: number; ppid: number; alive: number });
	const run = (env: NodeJS.ProcessEnv = {}) =>
		spawnSync(process.execPath, ["--import", "tsx", script], { cwd: join(import.meta.dirname, "..", ".."), env: { ...process.env, [SERVICE_ENV]: "", [RESTART_COMMAND_ENV]: "", [UP_LAUNCHER_ENV]: "", ...env }, encoding: "utf8", timeout: 60_000 });

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

	it("in a terminal: one launcher stays, and the chain does not grow with each restart", () => {
		const r = run();
		expect(r.status).toBe(0);
		const [launcher, ...after] = starts();
		expect(after).toHaveLength(2);
		// Every later start is the launcher's own child — never a child of the previous one.
		expect(after.every((x) => x.ppid === launcher.pid)).toBe(true);
		expect(after.map((x) => x.alive)).toEqual([2, 2]);
	});

	it("#1151: a respawn that dies is started again by the launcher that outlived it — the update comes back", () => {
		// Start 0 restarts (the update); start 1 — the new release — dies; the launcher starts it again; it restarts once
		// more and the last start runs to a clean exit.
		const r = run({ PAGS_NO_PROMPT: "1", STANDIN_FAIL_AT: "1", STANDIN_RESTARTS: "3" });
		expect(r.status).toBe(0);
		const [launcher, ...after] = starts();
		expect(after).toHaveLength(3);
		expect(after.every((x) => x.ppid === launcher.pid)).toBe(true);
		expect(after.map((x) => x.alive)).toEqual([2, 2, 2]);
	});
});

