/**
 * How `pags up` starts itself again after a remote update or an `r` (#1036, #1151).
 *
 * It used to run the new `pags up` with `execFileSync` and wait for it, so the old process stayed
 * blocked behind every restart. A healthy runner never exits, so the old one never did either: one
 * machine reached six `pags up` processes chained parent → child after two days of updates, each
 * holding the CLI version it started with. Now a restart leaves no blocked ancestor:
 *
 *   - `service` — a launchd/systemd unit set `PAGS_SERVICE=1`: exit with the restart code and let the
 *     unit start the new release (the same `service` restarter `self-update.ts` models);
 *   - `command` — `PAGS_RESTART_COMMAND` is set: start it detached and exit;
 *   - `launcher-child` — this `pags up` was started by a launcher below: exit with the restart code
 *     and let it start the next one;
 *   - `launcher` — stay as ONE thin launcher that runs `pags up` again for as long as it asks for a
 *     restart. The chain is then two deep for good, never one more per restart.
 *
 * One restart owner per `pags up` (#1154): the service supervisor under `PAGS_SERVICE`, otherwise the launcher — which
 * a terminal `pags up` now becomes on its FIRST start, not only after its first update. Whatever ends the runner is
 * handed to that owner: an update or `runner_restart` exits {@link RUNNER_RESTART_EXIT_CODE} (start again at once), a
 * runner that died exits {@link RUNNER_DIED_EXIT_CODE} (start again with backoff), a deliberate stop exits 0. A
 * launcher-child whose launcher is gone (killed, crashed) takes the launcher's place instead of exiting to nobody.
 *
 * There is no in-place `execve` any more (#1151). It left nothing behind to notice a respawn that did not come up:
 * on 2026-10-17 every machine that auto-updated to 0.4.149 reported `installing`, replaced or relaunched itself, and
 * was never heard from again — the process that could have tried again was gone. The launcher outlives every start it
 * makes, and an unattended one (a remote update, nobody at the keyboard) that fails is started again with backoff
 * rather than given up on. Each step goes into the update log (`bootstrap/update-log.ts`).
 */
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { logUpdateStep } from "../bootstrap/update-log.js";
import { pidAlive } from "../runner-lock.js";
import { leaveForRestart, RESTART_COMMAND_ENV, RUNNER_RESTART_EXIT_CODE, SERVICE_ENV } from "./runner/self-update.js";

/** Set on a `pags up` that a {@link restartPagsUp} launcher started — it restarts by exiting to it. */
export const UP_LAUNCHER_ENV = "PAGS_UP_LAUNCHER";
/** The launcher's pid, beside {@link UP_LAUNCHER_ENV}: a child whose launcher is gone must not exit to it (#1154). */
export const UP_LAUNCHER_PID_ENV = "PAGS_UP_LAUNCHER_PID";
/** `pags up` handing a runner that DIED to its restart owner (#1154) — started again with backoff, unlike 75. */
export const RUNNER_DIED_EXIT_CODE = 76;

export type UpRestart = "service" | "command" | "launcher-child" | "launcher";

/**
 * Who restarts this `pags up`. `launcher-child` only while its launcher is still there: the launcher's pid is the
 * parent and alive. A child orphaned by a killed launcher becomes the launcher itself (#1154). (On Windows a dead
 * parent's pid stays in `ppid`, hence the liveness check.)
 */
export function upRestartMode(env: NodeJS.ProcessEnv, parent: { pid: number; alive: (pid: number) => boolean } = { pid: process.ppid, alive: pidAlive }): UpRestart {
	if (env[SERVICE_ENV] === "1") return "service";
	if (env[RESTART_COMMAND_ENV]?.trim()) return "command";
	const launcher = Number(env[UP_LAUNCHER_PID_ENV]);
	if (env[UP_LAUNCHER_ENV] === "1" && launcher === parent.pid && parent.alive(launcher)) return "launcher-child";
	return "launcher";
}

/**
 * What a `pags up` does when its `runner connect` exits (#1154). Pure — `up.ts` and the real-process tests share it.
 *   - `restart`: 75, an update or `runner_restart` asked for a start on the new release;
 *   - `ignore`: this `pags up` is stopping it itself (`q`, Ctrl-C);
 *   - `stop`: 0, a deliberate stop from outside (`pags down`, `--replace`) — leave cleanly, nobody restarts it;
 *   - `died`: anything else (a crash, OOM, a signal) — hand it to the restart owner with {@link RUNNER_DIED_EXIT_CODE}.
 */
export function runnerExitAction(code: number | null, stopping: boolean): "restart" | "ignore" | "stop" | "died" {
	if (code === RUNNER_RESTART_EXIT_CODE) return "restart";
	if (stopping) return "ignore";
	return code === 0 ? "stop" : "died";
}

/**
 * What starts THIS machine's runner again if it dies (#1154), as the heartbeat reports it: `service` (the OS
 * supervisor), `launcher` (a live `pags up` launcher above it), or `none` — `--background`, a bare `runner connect`,
 * or a launcher that was killed.
 */
export function restartOwner(env: NodeJS.ProcessEnv = process.env, alive: (pid: number) => boolean = pidAlive): "service" | "launcher" | "none" {
	if (env[SERVICE_ENV] === "1") return "service";
	return env[UP_LAUNCHER_ENV] === "1" && alive(Number(env[UP_LAUNCHER_PID_ENV])) ? "launcher" : "none";
}

/** How long an unattended launcher waits before starting a `pags up` that failed again: 10s, doubling, 5 min at most. */
export function relaunchDelayMs(failures: number): number {
	return Math.min(5 * 60_000, 10_000 * 2 ** Math.max(0, failures - 1));
}

export interface RestartDeps {
	env: NodeJS.ProcessEnv;
	execPath: string;
	execArgv: string[];
	/** The installed `pags` (`process.argv[1]`, the #862 stub when there is one), so the newest CLI runs. */
	script: string;
	spawn: typeof nodeSpawn;
	spawnSync: typeof nodeSpawnSync;
	exit: (code: number) => void;
	log: (line: string) => void;
	/** The launcher's wait between failed unattended starts. Blocking is fine: it has nothing else to do. */
	sleep: (ms: number) => void;
	/** One update-log step (#1151). */
	step: (line: string) => void;
	/** This process's parent, for {@link upRestartMode}. */
	parent: { pid: number; alive: (pid: number) => boolean };
	/** This process's pid — what its children are told their launcher is. */
	pid: number;
	now: () => number;
}

/** A `pags up` that ran at least this long was up: its failure is retried even if a person started it (#1154). */
const RAN_MS = 60_000;
/** A run this long resets the backoff, like the service supervisor's. */
const RESET_MS = 10 * 60_000;

export function processRestartDeps(): RestartDeps {
	return {
		env: process.env,
		execPath: process.execPath,
		execArgv: process.execArgv,
		script: process.argv[1],
		spawn: nodeSpawn,
		spawnSync: nodeSpawnSync,
		exit: (code) => process.exit(code),
		log: () => {},
		sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
		step: (line) => logUpdateStep(line),
		parent: { pid: process.ppid, alive: pidAlive },
		pid: process.pid,
		now: Date.now,
	};
}

/**
 * Start `pags <args>` again in place of this process, by the first means {@link upRestartMode} allows. `exitCode` is
 * what a supervised `pags up` hands its owner: {@link RUNNER_RESTART_EXIT_CODE} for an update or `runner_restart`,
 * {@link RUNNER_DIED_EXIT_CODE} for a runner that died. `initial` is a terminal `pags up` becoming its own launcher
 * on its first start (#1154): a quick failure of that first start is reported by the child itself and passed on.
 */
export function restartPagsUp(args: string[], extraEnv: NodeJS.ProcessEnv, deps: RestartDeps, opts: { exitCode?: number; initial?: boolean } = {}): void {
	const env = { ...deps.env, ...extraEnv };
	const argv = [...deps.execArgv, deps.script, ...args];
	const exitCode = opts.exitCode ?? RUNNER_RESTART_EXIT_CODE;
	const mode = upRestartMode(env, deps.parent);
	deps.step(`${opts.initial ? "start" : "restart"}: pags ${args.join(" ")} — ${opts.initial ? "as" : "leaving via"} ${mode}${exitCode === RUNNER_DIED_EXIT_CODE ? " (the runner died)" : ""}`);
	if (mode === "service") {
		deps.exit(exitCode);
		return;
	}
	if (mode === "command") {
		leaveForRestart(mode, { spawn: deps.spawn, exit: deps.exit });
		return;
	}
	if (mode === "launcher-child") {
		deps.exit(exitCode);
		return;
	}
	// The launcher: argv, no shell, so an instance id/slug can't be mis-quoted. Every start after the first is
	// unattended (a remote update, a runner that died), so none may stop at a prompt — and none may end the
	// launcher by failing: nobody is there to start it again (#1151).
	const childEnv = { ...env, [UP_LAUNCHER_ENV]: "1", [UP_LAUNCHER_PID_ENV]: String(deps.pid) };
	let failures = 0;
	for (let first = true; ; first = false) {
		const unattended = !first || env.PAGS_NO_PROMPT === "1";
		deps.step(`launcher: starting pags up${unattended ? " (unattended)" : ""}`);
		const startedAt = deps.now();
		const r = deps.spawnSync(deps.execPath, argv, { stdio: "inherit", env: first ? childEnv : { ...childEnv, PAGS_NO_PROMPT: "1" } });
		const ran = deps.now() - startedAt;
		const how = r.error ? `could not start (${r.error.message})` : r.signal ? `was killed by ${r.signal}` : `exited ${r.status}`;
		deps.step(`launcher: pags up ${how} after ${Math.round(ran / 1000)}s`);
		if (ran >= RESET_MS) failures = 0;
		if (r.status === RUNNER_RESTART_EXIT_CODE) {
			failures = 0;
			continue;
		}
		// A clean exit, or the person at the keyboard stopping it (Ctrl-C reaches the whole foreground group).
		if (!r.error && (r.status === 0 || r.signal === "SIGINT")) {
			deps.exit(0);
			return;
		}
		if (unattended || r.status === RUNNER_DIED_EXIT_CODE || ran >= RAN_MS) {
			failures++;
			const wait = relaunchDelayMs(failures);
			deps.log(`pags up ${how} — starting it again in ${Math.round(wait / 1000)}s (attempt ${failures + 1}).`);
			deps.step(`launcher: retrying in ${Math.round(wait / 1000)}s (failure ${failures})`);
			deps.sleep(wait);
			continue;
		}
		// A first start that failed at once (not signed in, the lock held): the child already said why.
		if (!opts.initial) deps.log(`Restart failed${typeof r.status === "number" ? ` (exit ${r.status})` : ""} — the runner is NOT running. Run 'pags up' again.`);
		deps.exit(typeof r.status === "number" && r.status !== 0 ? r.status : 1);
		return;
	}
}
