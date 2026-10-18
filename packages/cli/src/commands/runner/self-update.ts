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
import { spawn } from "node:child_process";
import { BOOTSTRAP_ENV, CLI_PACKAGE, installPayload, olderThan, payloadRoot, runNpm } from "../../bootstrap/payload.js";
import { beginTrial } from "../../bootstrap/trial.js";
import { logUpdateStep } from "../../bootstrap/update-log.js";
import type { SessionStateCounts } from "./runner-work-observation.js";

export { CLI_PACKAGE, latestPublishedRelease, latestPublishedVersion, olderThan } from "../../bootstrap/payload.js";


/** The control path the cloud sends (`workers/api/src/lib/runner-update.ts` sends the same string). */
export const RUNNER_UPDATE_PATH = "/pags/runner/update";
/** `runner_restart` (#1032): restart this runner on the CLI it already has — no install. */
export const RUNNER_RESTART_PATH = "/pags/runner/restart";
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
	/** WHY npm could not be asked, when `latest` is null (#1054) — npm's own error, carried into the refusal. */
	latestError?: string;
	/** Running from a source checkout (`pnpm dev`), not an npm install. */
	fromSource: boolean;
	/** What starts this process again after it exits — null when nothing would. */
	restarter: Restarter | null;
	/** Coding sessions whose engine is mid-turn right now. */
	busy: string[];
	/**
	 * The paired work observations `busy` was derived from (#1020): which request answered, and when.
	 * Never their content — no session text, paths, arguments or tokens. Absent where nothing was asked.
	 */
	observations?: UpdateObservation[];
	/** Versions this machine rolled back from (#1141, bootstrap/trial.ts), with why. Never installed again. */
	rolledBack?: Record<string, string>;
}

/** One local work observation the updater made. */
export interface UpdateObservation {
	source: "sessions" | "health";
	success: boolean;
	sampledAt: number;
	/** It ANSWERED (HTTP 200) but not in the shape the guard reads — unreadable, which is neither healthy nor absent (#1020). */
	malformed?: boolean;
	/** `sessions` only, when its list was readable: how many engines were in each lifecycle state (#1020). Counts only. */
	sessionStates?: SessionStateCounts;
}

export type UpdatePlan =
	| { action: "up-to-date"; current: string }
	/** `retryable`: nothing about this machine forbids the update — npm could not be asked this time (#1020). */
	| { action: "refused"; current: string; reason: string; retryable?: true }
	| { action: "wait"; current: string; latest: string; waitingFor: string[] }
	| { action: "update"; current: string; latest: string; restarter: Restarter };

/**
 * A manual update which is waiting for active work is allowed to restart only for this bounded
 * control-plane lease.  Without a lease, a terminal/expired operation could leave a local timer
 * that restarts the machine much later with no operation left to explain it (#1008).
 */
export interface DeferredUpdateLease {
	operationId: string;
	expiresAt: number;
}

/** Five minutes is deliberately shorter than the API's six-minute stale-operation sweep. */
export const MAX_DEFERRED_UPDATE_LEASE_MS = 5 * 60_000;

/** Parse a non-secret, bounded lease supplied by the durable control-plane operation. */
export function deferredUpdateLease(value: unknown, now = Date.now()): DeferredUpdateLease | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	const operationId = typeof raw.operationId === "string" ? raw.operationId.trim() : "";
	const expiresAt = typeof raw.deferUntil === "number" ? raw.deferUntil : NaN;
	if (!operationId || operationId.length > 128 || !Number.isFinite(expiresAt)) return null;
	if (expiresAt <= now || expiresAt > now + MAX_DEFERRED_UPDATE_LEASE_MS) return null;
	return { operationId, expiresAt };
}

export function deferredUpdateLeaseActive(lease: DeferredUpdateLease, now = Date.now()): boolean {
	return now < lease.expiresAt;
}

/**
 * Leave so {@link Restarter} starts this process again on the new release (#860): the restart code for
 * `pags up` or a service manager; for a {@link RESTART_COMMAND_ENV} the command, started detached first.
 */
export function leaveForRestart(restarter: Restarter, deps: { spawn: typeof spawn; exit: (code: number) => void } = { spawn, exit: (code) => process.exit(code) }): void {
	logUpdateStep(`restart: leaving for the ${restarter} restarter (${restarter === "command" ? "restart command started, exit 0" : `exit ${RUNNER_RESTART_EXIT_CODE}`})`);
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
	if (!f.latest) return { action: "refused", current: f.current, reason: `npm could not be asked for the latest ${CLI_PACKAGE} from this machine${f.latestError ? `: ${f.latestError}` : "."}`, retryable: true };
	if (!olderThan(f.current, f.latest)) return { action: "up-to-date", current: f.current };
	// Retryable: nothing forbids updating — the NEXT release installs as usual; this one is never installed again (#1141).
	const rolledBack = f.rolledBack?.[f.latest];
	if (rolledBack) return { action: "refused", current: f.current, reason: `${f.latest} was installed here and rolled back: ${rolledBack}. This machine stays on ${f.current} until a newer release is published.`, retryable: true };
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

export type RestartPlan =
	| { action: "refused"; current: string; reason: string; waitingFor?: string[] }
	| { action: "restart"; current: string; restarter: Restarter };

/**
 * What this machine should do about a remote restart (#1032). Pure.
 *
 * The recovery for "relay attached, runner not answering": the relay client answers this itself, so
 * it works when the local runtime behind it is wedged. It is guarded like an update: nothing would
 * restart it → refused; work running → refused with what is running. A work look that did not
 * answer (`busy` null, or the fail-closed `runner-work-observation-unavailable`) cannot show the
 * machine idle — and a wedged runtime is exactly the one that does not answer — so it refuses with
 * that said, and `force` is the owner's explicit choice to restart anyway, losing any run in flight.
 */
export function planRunnerRestart(f: { current: string; restarter: Restarter | null; busy: string[] | null; force: boolean }): RestartPlan {
	if (!f.restarter) {
		return {
			action: "refused",
			current: f.current,
			reason: `Nothing would start this runner again after a restart: it was not started by \`pags up\`, and neither ${SERVICE_ENV}=1 nor ${RESTART_COMMAND_ENV} is set. Restart it at the machine.`,
		};
	}
	if (!f.force) {
		if (f.busy === null || f.busy.includes("runner-work-observation-unavailable")) {
			return {
				action: "refused",
				current: f.current,
				reason: "The local runtime did not answer the work check, so this machine cannot be shown idle — it may be the part that is wedged. Restart with force to restart anyway; any run in progress on this machine is lost.",
			};
		}
		if (f.busy.length > 0) {
			return { action: "refused", current: f.current, waitingFor: f.busy, reason: `${f.busy.length} piece(s) of work are running here. Restart when they finish, or with force (that work is lost).` };
		}
	}
	return { action: "restart", current: f.current, restarter: f.restarter };
}

/**
 * Install `version` — into the stub's cache when bootstrapped (#862), else globally. Rejects with npm's own reason.
 * Bootstrapped, it goes in BESIDE the running `current` and on trial (#1141): the stub falls back to `current` if the
 * new one crashes on start or never registers.
 */
export async function installVersion(version: string, current: string | null = null): Promise<void> {
	const bootstrapped = !!process.env[BOOTSTRAP_ENV];
	logUpdateStep(`install: ${current ?? "?"} → ${version} starting (${bootstrapped ? "payload cache" : "npm i -g"})`);
	try {
		if (bootstrapped) {
			await installPayload(version);
			beginTrial(payloadRoot(), version, current);
		} else {
			await runNpm(["i", "-g", `${CLI_PACKAGE}@${version}`], { timeout: 5 * 60_000 }).catch((e: unknown) => {
				const stderr = String((e as { stderr?: unknown }).stderr ?? "").trim();
				throw new Error((stderr || (e instanceof Error ? e.message : String(e))).slice(-400));
			});
		}
	} catch (e) {
		logUpdateStep(`install: ${version} FAILED — ${e instanceof Error ? e.message : String(e)}`);
		throw e;
	}
	logUpdateStep(`install: ${version} installed`);
}
