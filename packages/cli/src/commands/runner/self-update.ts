/**
 * `runner_update` — the machine updates its own `pags` CLI and restarts in place (#859).
 *
 * Every runner-side feature (#856's targeted reattach, #857/#858's clone) was dead on arrival for a
 * remote operator until somebody updated each machine by hand. The cloud now asks, over any relay
 * socket this process holds, and this process:
 *
 *   1. works out whether it CAN: it must be an npm-installed CLI (a source checkout updates with git)
 *      supervised by a `pags up` that respawns it (a bare `pags runner connect` would just stop);
 *   2. never cuts an engine off mid-turn: while any coding session is working it WAITS, re-checking,
 *      and restarts only once all are idle — the cloud parks a run across the gap and resumes it
 *      with `--resume`, so a run is paused, never dropped;
 *   3. installs `@proagentstore/cli@<latest>` with npm, answers, and exits with
 *      {@link RUNNER_RESTART_EXIT_CODE}; `pags up` respawns `runner connect` from the new files, and
 *      discovery re-attaches every agent this machine may run.
 *
 * Under the bootstrap stub (#862) the release goes into the stub's payload cache rather than over the
 * global install: the respawn runs `process.argv[1]` — the stub — which picks the newest payload.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BOOTSTRAP_ENV, CLI_PACKAGE, installPayload, olderThan } from "../../bootstrap/payload.js";

export { CLI_PACKAGE, latestPublishedVersion, olderThan } from "../../bootstrap/payload.js";

const run = promisify(execFile);

/** The control path the cloud sends (`workers/api/src/lib/runner-update.ts` sends the same string). */
export const RUNNER_UPDATE_PATH = "/pags/runner/update";
/** `runner connect` exits with this to ask its `pags up` parent for a respawn from the updated files. */
export const RUNNER_RESTART_EXIT_CODE = 75;
/** Set by a `pags up` that respawns on {@link RUNNER_RESTART_EXIT_CODE}. Without it nothing would restart us. */
export const SUPERVISED_ENV = "PAGS_UP_SUPERVISED";

export interface UpdateFacts {
	current: string;
	/** The newest published release, or null when npm could not be asked. */
	latest: string | null;
	/** Running from a source checkout (`pnpm dev`), not an npm install. */
	fromSource: boolean;
	/** A `pags up` parent that respawns us on the restart exit code. */
	supervised: boolean;
	/** Coding sessions whose engine is mid-turn right now. */
	busy: string[];
}

export type UpdatePlan =
	| { action: "up-to-date"; current: string }
	| { action: "refused"; current: string; reason: string }
	| { action: "wait"; current: string; latest: string; waitingFor: string[] }
	| { action: "update"; current: string; latest: string };

/** What this machine should do about an update request. Pure. */
export function planRunnerUpdate(f: UpdateFacts): UpdatePlan {
	if (f.fromSource) return { action: "refused", current: f.current, reason: "This runner runs from a source checkout — update it with `git pull` there, not npm." };
	if (!f.latest) return { action: "refused", current: f.current, reason: `npm could not be asked for the latest ${CLI_PACKAGE} from this machine.` };
	if (!olderThan(f.current, f.latest)) return { action: "up-to-date", current: f.current };
	if (!f.supervised) {
		return {
			action: "refused",
			current: f.current,
			reason: `This runner was not started by a \`pags up\` that can restart it (\`pags runner connect\` directly, or a \`pags up\` older than the respawn). Update once at the machine: \`npm i -g ${CLI_PACKAGE}\` and restart \`pags up\` — later updates can then be done remotely.`,
		};
	}
	if (f.busy.length > 0) return { action: "wait", current: f.current, latest: f.latest, waitingFor: f.busy };
	return { action: "update", current: f.current, latest: f.latest };
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
