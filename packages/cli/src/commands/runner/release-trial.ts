/**
 * The running payload's side of the bootstrap stub's release trial (#1141, bootstrap/trial.ts).
 *
 * Kept out of relay.ts: the relay only has to say when it first registered, and read back what the
 * stub decided before it started — a rollback to report, and the versions never to install again.
 */
import { BOOTSTRAP_ENV, payloadRoot } from "../../bootstrap/payload.js";
import { badDetails, badVersions, clearBad, markPayloadHealthy, takeRollbackNotice } from "../../bootstrap/trial.js";

export interface ReleaseTrial {
	/** "Rolled back from X to Y: why." when the stub gave up on a release before this process started — reported once. */
	rollbackReason: string | null;
	/** The relay registered or heartbeated: a release on trial is proven, and the stub keeps it. Idempotent. */
	proven: () => void;
	/** Versions this machine rolled back from, with why — `UpdateFacts.rolledBack`. */
	rolledBack: () => Record<string, string>;
	/** Clear the rolled-back mark on `version`, so it installs on trial again (#1150). True when there was one. */
	forget: (version: string) => boolean;
	/** The rolled-back releases as the platform's machine page shows them: {from, to, reason, at} (#1150). Empty when none. */
	rollbacks: () => Array<{ from: string; to: string | null; reason: string; at: number | null }>;
}

/**
 * The owner's "try it again" (#1150): when the request asks to retry a rolled-back release and the release this machine would
 * update to is one it rolled back from, forget that mark and plan again from the facts without it. A dry run only shows the
 * facts as they would be — nothing is cleared. `retried` names the release, for the answer; null when there was nothing to retry.
 */
export function applyRetryRolledBack<F extends { latest: string | null; rolledBack?: Record<string, string> }>(
	facts: F,
	body: unknown,
	trial: Pick<ReleaseTrial, "forget" | "rolledBack">,
	dryRun: boolean,
): { facts: F; retried: string | null } {
	const latest = facts.latest;
	if ((body as { retryRolledBack?: unknown } | undefined)?.retryRolledBack !== true || !latest || !facts.rolledBack?.[latest]) return { facts, retried: null };
	if (dryRun) return { facts: { ...facts, rolledBack: Object.fromEntries(Object.entries(facts.rolledBack).filter(([v]) => v !== latest)) }, retried: latest };
	trial.forget(latest);
	return { facts: { ...facts, rolledBack: trial.rolledBack() }, retried: latest };
}

/** Where a rollback is recorded: the relay's policy cell, so it rides the first registration into `last_error`. */
export interface RollbackRecorder {
	record: (status: "failure", extra: { reason: string; recovery: undefined }) => void;
}

/**
 * Read what the stub decided and record a rollback — as a failure that also ends the update cycle which installed the
 * rolled-back release, so the controller does not retry it. `proven` is what the relay calls on every service answer.
 */
export function releaseTrial(version: string, cell: RollbackRecorder, log: (line: string) => void, env: NodeJS.ProcessEnv = process.env, root: () => string = payloadRoot): ReleaseTrial {
	// Only a payload the stub started is on trial; a source checkout or a global install has nothing to prove.
	if (!env[BOOTSTRAP_ENV]) return { rollbackReason: null, proven: () => undefined, rolledBack: () => ({}), forget: () => false, rollbacks: () => [] };
	const notice = takeRollbackNotice(root());
	const rollbackReason = notice ? `Rolled back from ${notice.from} to ${version}: ${notice.reason}.` : null;
	if (rollbackReason) {
		log(`auto-update: ${rollbackReason}`);
		cell.record("failure", { reason: rollbackReason, recovery: undefined });
	}
	let done = false;
	return {
		rollbackReason,
		proven: () => {
			if (done) return;
			done = true;
			if (markPayloadHealthy(root(), version)) log(`auto-update: ${version} registered — it is kept.`);
		},
		rolledBack: () => badVersions(root()),
		forget: (v) => clearBad(root(), v),
		// Every version still marked bad, with where the stub fell back to and when (kept beside the mark; the one-shot
		// notice fills in for a mark written before that was recorded).
		rollbacks: () =>
			Object.entries(badVersions(root())).map(([from, reason]) => {
				const d = badDetails(root())[from];
				return {
					from,
					reason,
					to: d?.to ?? (notice && notice.from === from ? (notice.to ?? version) : null),
					at: d?.at ?? (notice && notice.from === from && notice.at ? notice.at : null),
				};
			}),
	};
}
