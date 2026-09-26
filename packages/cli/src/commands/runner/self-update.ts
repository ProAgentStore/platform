/**
 * `runner_update` — the machine updates its own `pags` CLI and restarts in place (#859).
 *
 * Every runner-side feature (#856's targeted reattach, #857/#858's clone) was dead on arrival for a
 * remote operator until somebody updated each machine by hand. The cloud now asks, over any relay
 * socket this process holds, and this process:
 *
 *   1. works out whether it CAN: it must be an npm-installed CLI (a source checkout updates with git)
 *      with something that brings it back — see {@link Restarter} (#860);
 *   2. never cuts an engine off mid-turn: while any coding session is working it WAITS, re-checking,
 *      and restarts only once all are idle — the cloud parks a run across the gap and resumes it
 *      with `--resume`, so a run is paused, never dropped;
 *   3. installs `@proagentstore/cli@<latest>` with npm, answers, and exits with
 *      {@link RUNNER_RESTART_EXIT_CODE}; whatever supervises it starts it again from the new files,
 *      and discovery re-attaches every agent this machine may run.
 *
 * Under the bootstrap stub (#862) the release goes into the stub's payload cache rather than over the
 * global install: the respawn runs `process.argv[1]` — the stub — which picks the newest payload.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { BOOTSTRAP_ENV, CLI_PACKAGE, installPayload, olderThan } from "../../bootstrap/payload.js";

export { CLI_PACKAGE, latestPublishedVersion, olderThan } from "../../bootstrap/payload.js";

const run = promisify(execFile);

/** The control path the cloud sends (`workers/api/src/lib/runner-update.ts` sends the same string). */
export const RUNNER_UPDATE_PATH = "/pags/runner/update";
/** `runner connect` exits with this to ask its `pags up` parent for a respawn from the updated files. */
export const RUNNER_RESTART_EXIT_CODE = 75;
/** Set by a `pags up` that respawns on {@link RUNNER_RESTART_EXIT_CODE}: `1` before #860, {@link SUPERVISOR_RESTARTS} since. */
export const SUPERVISED_ENV = "PAGS_UP_SUPERVISED";
/** The {@link SUPERVISED_ENV} value of a `pags up` that restarts ITSELF on the new release too, not only this child (#860). */
export const SUPERVISOR_RESTARTS = "2";
/** `1` from a launchd/systemd unit that starts this process again whenever it exits non-zero (#860). */
export const SERVICE_ENV = "PAGS_SERVICE";
/** A shell command that starts this runner again, for anything else that runs it — tmux scripts, nohup (#860). */
export const RESTART_COMMAND_ENV = "PAGS_RESTART_COMMAND";

/**
 * What brings this process back after it exits for an update (#860):
 *   - `pags-up` — a `pags up` that restarts itself on the new release, so the supervisor updates too;
 *   - `pags-up-child-only` — an older `pags up`: this runner comes back new, the `pags up` does not;
 *   - `service` — a launchd/systemd unit with {@link SERVICE_ENV}, restarting on the non-zero exit;
 *   - `command` — {@link RESTART_COMMAND_ENV}, run detached as this process leaves.
 */
export type Restarter = "pags-up" | "pags-up-child-only" | "service" | "command";

export function restarterFrom(env: NodeJS.ProcessEnv): Restarter | null {
	if (env[SUPERVISED_ENV] === SUPERVISOR_RESTARTS) return "pags-up";
	if (env[SUPERVISED_ENV] === "1") return "pags-up-child-only";
	if (env[SERVICE_ENV] === "1") return "service";
	if (env[RESTART_COMMAND_ENV]?.trim()) return "command";
	return null;
}

/** What the update does NOT reach, said to the operator — null when it reaches everything. */
export function supervisorNote(restarter: Restarter): string | null {
	return restarter === "pags-up-child-only"
		? "The `pags up` on this machine predates supervisor restarts (#860): the runner comes back on the new release, but the `pags up` window keeps running its own older code until it is restarted there once."
		: null;
}

export interface UpdateFacts {
	current: string;
	/** The newest published release, or null when npm could not be asked. */
	latest: string | null;
	/** Running from a source checkout (`pnpm dev`), not an npm install. */
	fromSource: boolean;
	/** What starts this process again after it exits — null when nothing would. */
	restarter: Restarter | null;
	/** Coding sessions whose engine is mid-turn right now. */
	busy: string[];
}

export type UpdatePlan =
	| { action: "up-to-date"; current: string }
	| { action: "refused"; current: string; reason: string }
	| { action: "wait"; current: string; latest: string; waitingFor: string[] }
	| { action: "update"; current: string; latest: string; restarter: Restarter };

/**
 * Leave so {@link Restarter} starts this process again on the new release (#860): the restart code for
 * `pags up` or a service manager; for a {@link RESTART_COMMAND_ENV} the command, started detached first.
 */
export function leaveForRestart(restarter: Restarter, deps: { spawn: typeof spawn; exit: (code: number) => void } = { spawn, exit: (code) => process.exit(code) }): void {
	if (restarter === "command") {
		deps.spawn(process.env[RESTART_COMMAND_ENV] as string, { shell: true, detached: true, stdio: "ignore", env: process.env }).unref();
		deps.exit(0);
		return;
	}
	deps.exit(RUNNER_RESTART_EXIT_CODE);
}

/**
 * The arguments that start this same `pags up` again. The ORIGINAL flags are preserved — dropping
 * `--instance` here made a scoped `pags up --instance X` silently fan back out to every instance.
 */
export function restartUpArgs(opts: { headless?: boolean; instance?: string; force?: boolean }): string[] {
	const args = ["up"];
	if (opts.headless) args.push("--headless");
	if (opts.force) args.push("--force");
	if (opts.instance) args.push("--instance", opts.instance);
	return args;
}

/** What this machine should do about an update request. Pure. */
export function planRunnerUpdate(f: UpdateFacts): UpdatePlan {
	if (f.fromSource) return { action: "refused", current: f.current, reason: "This runner runs from a source checkout — update it with `git pull` there, not npm." };
	if (!f.latest) return { action: "refused", current: f.current, reason: `npm could not be asked for the latest ${CLI_PACKAGE} from this machine.` };
	if (!olderThan(f.current, f.latest)) return { action: "up-to-date", current: f.current };
	if (!f.restarter) {
		return {
			action: "refused",
			current: f.current,
			reason: `Nothing would start this runner again after an update: it was not started by \`pags up\`, and neither ${SERVICE_ENV}=1 (a launchd/systemd unit that restarts it on a non-zero exit) nor ${RESTART_COMMAND_ENV} (a command that starts it again) is set. Run it under \`pags up\`, or set one of the two where it is started — later updates can then be done remotely. (A \`pags up\` older than 0.4.62 cannot restart it either: update once at the machine with \`npm i -g ${CLI_PACKAGE}\`.)`,
		};
	}
	if (f.busy.length > 0) return { action: "wait", current: f.current, latest: f.latest, waitingFor: f.busy };
	return { action: "update", current: f.current, latest: f.latest, restarter: f.restarter };
}

/** Install `version` — into the stub's cache when bootstrapped (#862), else globally. Rejects with npm's own reason. */
export async function installVersion(version: string): Promise<void> {
	if (process.env[BOOTSTRAP_ENV]) {
		await installPayload(version);
		return;
	}
	try {
		await run("npm", ["i", "-g", `${CLI_PACKAGE}@${version}`], { timeout: 5 * 60_000 });
	} catch (e) {
		const stderr = String((e as { stderr?: unknown }).stderr ?? "").trim();
		throw new Error((stderr || (e instanceof Error ? e.message : String(e))).slice(-400));
	}
}
