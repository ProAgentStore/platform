/**
 * How `pags up` starts itself again after a remote update or an `r` (#1036).
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
 *   - `exec` — replace this process in place (`process.execve`): same pid, same terminal or tmux pane;
 *   - `launcher` — no execve (Windows): stay as ONE thin launcher that runs `pags up` again for as
 *     long as it asks for a restart. The chain is then two deep for good, never one more per restart.
 */
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { leaveForRestart, RESTART_COMMAND_ENV, RUNNER_RESTART_EXIT_CODE, SERVICE_ENV } from "./runner/self-update.js";

/** Set on a `pags up` that a {@link restartPagsUp} launcher started — it restarts by exiting to it. */
export const UP_LAUNCHER_ENV = "PAGS_UP_LAUNCHER";

export type UpRestart = "service" | "command" | "launcher-child" | "exec" | "launcher";

export function upRestartMode(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, canExecve: boolean): UpRestart {
	if (env[SERVICE_ENV] === "1") return "service";
	if (env[RESTART_COMMAND_ENV]?.trim()) return "command";
	if (env[UP_LAUNCHER_ENV] === "1") return "launcher-child";
	return platform !== "win32" && canExecve ? "exec" : "launcher";
}

export interface RestartDeps {
	env: NodeJS.ProcessEnv;
	platform: NodeJS.Platform;
	execPath: string;
	execArgv: string[];
	/** The installed `pags` (`process.argv[1]`, the #862 stub when there is one), so the newest CLI runs. */
	script: string;
	execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => void;
	spawn: typeof nodeSpawn;
	spawnSync: typeof nodeSpawnSync;
	exit: (code: number) => void;
	log: (line: string) => void;
}

export function processRestartDeps(): RestartDeps {
	const execve = (process as { execve?: RestartDeps["execve"] }).execve;
	return {
		env: process.env,
		platform: process.platform,
		execPath: process.execPath,
		execArgv: process.execArgv,
		script: process.argv[1],
		execve: typeof execve === "function" ? execve.bind(process) : undefined,
		spawn: nodeSpawn,
		spawnSync: nodeSpawnSync,
		exit: (code) => process.exit(code),
		log: () => {},
	};
}

/** Start `pags <args>` again in place of this process, by the first means {@link upRestartMode} allows. */
export function restartPagsUp(args: string[], extraEnv: NodeJS.ProcessEnv, deps: RestartDeps): void {
	const env = { ...deps.env, ...extraEnv };
	const argv = [...deps.execArgv, deps.script, ...args];
	const mode = upRestartMode(env, deps.platform, !!deps.execve);
	if (mode === "service" || mode === "command") {
		leaveForRestart(mode, { spawn: deps.spawn, exit: deps.exit });
		return;
	}
	if (mode === "launcher-child") {
		deps.exit(RUNNER_RESTART_EXIT_CODE);
		return;
	}
	if (mode === "exec") {
		try {
			deps.execve!(deps.execPath, [deps.execPath, ...argv], env);
		} catch (e) {
			deps.log(`Restart failed (${e instanceof Error ? e.message : String(e)}) — the runner is NOT running. Run 'pags up' again.`);
			deps.exit(1);
		}
		return;
	}
	// The launcher: argv, no shell, so an instance id/slug can't be mis-quoted. Every start after the
	// first is unattended (a remote update), so none of them may stop at a prompt.
	for (let first = true; ; first = false) {
		const r = deps.spawnSync(deps.execPath, argv, { stdio: "inherit", env: { ...env, [UP_LAUNCHER_ENV]: "1", ...(first ? {} : { PAGS_NO_PROMPT: "1" }) } });
		if (r.status === RUNNER_RESTART_EXIT_CODE) continue;
		if (r.error || r.status !== 0) {
			// Restarting IS what `r` promises: a failure must not read as a clean exit to a script.
			deps.log(`Restart failed${typeof r.status === "number" ? ` (exit ${r.status})` : ""} — the runner is NOT running. Run 'pags up' again.`);
			deps.exit(typeof r.status === "number" && r.status !== 0 ? r.status : 1);
			return;
		}
		deps.exit(0);
		return;
	}
}
