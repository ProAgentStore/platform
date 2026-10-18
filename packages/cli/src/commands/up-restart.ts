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
 * There is no in-place `execve` any more (#1151). It left nothing behind to notice a respawn that did not come up:
 * on 2026-10-17 every machine that auto-updated to 0.4.149 reported `installing`, replaced or relaunched itself, and
 * was never heard from again — the process that could have tried again was gone. The launcher outlives every start it
 * makes, and an unattended one (a remote update, nobody at the keyboard) that fails is started again with backoff
 * rather than given up on. Each step goes into the update log (`bootstrap/update-log.ts`).
 */
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { logUpdateStep } from "../bootstrap/update-log.js";
import { leaveForRestart, RESTART_COMMAND_ENV, RUNNER_RESTART_EXIT_CODE, SERVICE_ENV } from "./runner/self-update.js";

/** Set on a `pags up` that a {@link restartPagsUp} launcher started — it restarts by exiting to it. */
export const UP_LAUNCHER_ENV = "PAGS_UP_LAUNCHER";

export type UpRestart = "service" | "command" | "launcher-child" | "launcher";

export function upRestartMode(env: NodeJS.ProcessEnv): UpRestart {
	if (env[SERVICE_ENV] === "1") return "service";
	if (env[RESTART_COMMAND_ENV]?.trim()) return "command";
	if (env[UP_LAUNCHER_ENV] === "1") return "launcher-child";
	return "launcher";
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
}

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
	};
}

/** Start `pags <args>` again in place of this process, by the first means {@link upRestartMode} allows. */
export function restartPagsUp(args: string[], extraEnv: NodeJS.ProcessEnv, deps: RestartDeps): void {
	const env = { ...deps.env, ...extraEnv };
	const argv = [...deps.execArgv, deps.script, ...args];
	const mode = upRestartMode(env);
	deps.step(`restart: pags ${args.join(" ")} — leaving via ${mode}`);
	if (mode === "service" || mode === "command") {
		leaveForRestart(mode, { spawn: deps.spawn, exit: deps.exit });
		return;
	}
	if (mode === "launcher-child") {
		deps.exit(RUNNER_RESTART_EXIT_CODE);
		return;
	}
	// The launcher: argv, no shell, so an instance id/slug can't be mis-quoted. Every start after the
	// first is unattended (a remote update), so none of them may stop at a prompt — and none of them may
	// end the launcher by failing: nobody is there to start it again (#1151).
	let failures = 0;
	for (let first = true; ; first = false) {
		const unattended = !first || env.PAGS_NO_PROMPT === "1";
		deps.step(`launcher: starting pags up${unattended ? " (unattended)" : ""}`);
		const r = deps.spawnSync(deps.execPath, argv, { stdio: "inherit", env: { ...env, [UP_LAUNCHER_ENV]: "1", ...(first ? {} : { PAGS_NO_PROMPT: "1" }) } });
		const how = r.error ? `could not start (${r.error.message})` : r.signal ? `was killed by ${r.signal}` : `exited ${r.status}`;
		deps.step(`launcher: pags up ${how}`);
		if (r.status === RUNNER_RESTART_EXIT_CODE) {
			failures = 0;
			continue;
		}
		if (!r.error && r.status === 0) {
			deps.exit(0);
			return;
		}
		if (unattended) {
			failures++;
			const wait = relaunchDelayMs(failures);
			deps.log(`pags up ${how} — starting it again in ${Math.round(wait / 1000)}s (attempt ${failures + 1}).`);
			deps.step(`launcher: retrying in ${Math.round(wait / 1000)}s (failure ${failures})`);
			deps.sleep(wait);
			continue;
		}
		// Restarting IS what `r` promises: a failure must not read as a clean exit to a script.
		deps.log(`Restart failed${typeof r.status === "number" ? ` (exit ${r.status})` : ""} — the runner is NOT running. Run 'pags up' again.`);
		deps.exit(typeof r.status === "number" && r.status !== 0 ? r.status : 1);
		return;
	}
}
