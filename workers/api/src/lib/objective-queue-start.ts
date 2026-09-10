// The per-repo objective queue (#788) — the DRAIN half.
//
// `objective-queue.ts` holds the rows; this is the one place that turns a queued row into a run.
// It is called from a run's terminal path (`workflows/coding-session.ts`, `workflows/agent-loop.ts`)
// at the moment the lock it was waiting on clears.
//
// ── It opens its own budget, and that is the point
//
// A queued objective is a SEPARATE run: it has its own iterations, its own spend, and it is started
// by the platform rather than by a request. #184's rule is an admission check at every autonomous
// entry point, and this is a new one — inheriting the finished run's pool would let one
// `coding_loop_start` open a budget that an unbounded chain of follow-ups then draws on. So the
// ceiling and the pool are resolved HERE, per entry, exactly as `POST /loop` does per request.
//
// ── Order of operations, and why the claim comes first
//
// `dequeueNext` moves the row to `running` BEFORE any of the work below. Everything after it can
// fail, and every one of those failures writes a terminal status — an entry that is claimed and then
// abandoned is the "if I forget to check back, the request is just lost" the issue is about, wearing
// a different hat.

import { capabilitiesForInstance } from "./agent-capabilities.js";
import { sanitizeMaxIterations } from "./agent-loop.js";
import { openBudget, resolveAccountCeilings } from "./delegation-budget-store.js";
import { logError } from "./error-log.js";
import { loopDriverFor } from "./loop-drivers.js";
import { dequeueNext, finishQueueEntry, requeueEntry } from "./objective-queue.js";
import type { Env } from "../types.js";

export type QueueDrainResult =
	/** Nothing was waiting for this instance/repo. The common case, and one cheap SELECT. */
	| { drained: false }
	/** An entry became a run. `runId` is where its account continues. */
	| { drained: true; entryId: string; started: true; runId: string; driver: string }
	/** An entry was claimed and could not be started. `requeued` says whether it kept its place. */
	| { drained: true; entryId: string; started: false; requeued: boolean; error: string };

/**
 * Start the next queued objective for this instance/repo, if there is one.
 *
 * NEVER THROWS. It is called from the terminal path of a run that has already finished, and a queue
 * that cannot be drained must not turn a completed run into a failed workflow step — the run's own
 * outcome is already written by the time this is reached. A failure is recorded in `error_log` and
 * returned, not raised.
 *
 * Drains exactly ONE entry per call, deliberately. The run it starts will reach its own terminal
 * path and drain the next, so the queue empties in FIFO order at the rate the work actually
 * completes. Looping here would start a second run against a lock the first one now holds.
 */
export async function tryDequeueAndStart(env: Env, instanceId: string, repoId: string | null, userId: string): Promise<QueueDrainResult> {
	let entryId: string | null = null;
	try {
		const entry = await dequeueNext(env, instanceId, repoId);
		if (!entry) return { drained: false };
		entryId = entry.id;

		// The entry's OWN owner, not the `userId` of the run that happened to finish. They are the
		// same today — an instance has one owner and only that owner can enqueue — but the run that
		// drains a queue is not the run that filled it, and reading the actor off the wrong row is
		// how a queued objective would come to execute as somebody else.
		const owner = entry.userId;

		// Same clamp as `POST /loop`: the account ceiling is resolved at START time, so an entry that
		// sat in the queue across a limits change is bounded by the limit in force when it runs.
		// A null `maxIterations` lands on `sanitizeMaxIterations`'s own default, which is exactly what
		// a `coding_loop_start` that named no number gets.
		let budgetId: string;
		let maxIterations: number;
		try {
			const ceilings = await resolveAccountCeilings(env, owner);
			maxIterations = sanitizeMaxIterations(entry.maxIterations ?? undefined, ceilings.loopMaxIterations);
			const budget = await openBudget(env, owner, instanceId);
			budgetId = budget.id;
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			await finishQueueEntry(env, entry.id, "failed", `budget refused: ${message}`);
			await logError(env, {
				source: "loop",
				userId: owner,
				message: `queued objective ${entry.id} could not open a budget and was not started: ${message}`,
				context: { instanceId, repoId, entryId: entry.id },
			}).catch(() => undefined);
			return { drained: true, entryId: entry.id, started: false, requeued: false, error: message };
		}

		const caps = await capabilitiesForInstance(env, instanceId, owner).catch(() => null);
		const started = await loopDriverFor(caps).start({
			env,
			instanceId,
			userId: owner,
			objective: entry.objective,
			maxIterations,
			// The entry's own repo when it named one; otherwise the repo whose lock just cleared,
			// which is what "any" means at the moment of draining. Both null leaves the choice to
			// `pickLoopRepo`, the same as a supervisor's `delegate_goal`.
			repoId: entry.repoId ?? repoId ?? undefined,
			budgetId,
			// Depth 0: the queue is the OWNER's, not a subordinate's. A queued objective is not
			// delegated by the run that drained it, and inheriting that run's depth would make the
			// tree budget refuse a follow-up for a lineage it does not belong to.
			depth: 0,
		});

		if (started.ok) {
			await finishQueueEntry(env, entry.id, "started", null, started.runId);
			return { drained: true, entryId: entry.id, started: true, runId: started.runId, driver: started.driver };
		}

		// Busy AGAIN is a race, not a verdict on this objective: another start won the claim between
		// this run releasing it and this drain asking for it. Put the entry back where it was and let
		// the winner's own terminal path drain it.
		if (started.reason === "busy") {
			await requeueEntry(env, entry.id);
			return { drained: true, entryId: entry.id, started: false, requeued: true, error: started.error };
		}

		// Everything else is structural — no repo on the agent, no runner, a checkout that failed
		// admission. Waiting does not fix any of them, so the entry FAILS with the driver's own
		// sentence rather than sitting pending forever with nobody ever told why nothing happened.
		await finishQueueEntry(env, entry.id, "failed", started.error);
		return { drained: true, entryId: entry.id, started: false, requeued: false, error: started.error };
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		await logError(env, {
			source: "loop",
			userId,
			message: `objective queue drain failed for ${instanceId}: ${message}`,
			context: { instanceId, repoId, entryId },
		}).catch(() => undefined);
		return entryId
			? { drained: true, entryId, started: false, requeued: false, error: message }
			: { drained: false };
	}
}
