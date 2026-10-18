/**
 * The running payload's side of the bootstrap stub's release trial (#1141, bootstrap/trial.ts).
 *
 * Kept out of relay.ts: the relay only has to say when it first registered, and read back what the
 * stub decided before it started — a rollback to report, and the versions never to install again.
 */
import { BOOTSTRAP_ENV, payloadRoot } from "../../bootstrap/payload.js";
import { badVersions, markPayloadHealthy, takeRollbackNotice } from "../../bootstrap/trial.js";

export interface ReleaseTrial {
	/** "Rolled back from X to Y: why." when the stub gave up on a release before this process started — reported once. */
	rollbackReason: string | null;
	/** The relay registered or heartbeated: a release on trial is proven, and the stub keeps it. Idempotent. */
	proven: () => void;
	/** Versions this machine rolled back from, with why — `UpdateFacts.rolledBack`. */
	rolledBack: () => Record<string, string>;
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
	if (!env[BOOTSTRAP_ENV]) return { rollbackReason: null, proven: () => undefined, rolledBack: () => ({}) };
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
	};
}
