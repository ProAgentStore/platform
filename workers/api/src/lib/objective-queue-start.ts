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
import { clampIterations } from "./loop-limits.js";
import { readLoopLimits } from "./loop-limits-store.js";
import { openBudget, resolveAccountCeilings } from "./delegation-budget-store.js";
import { logError } from "./error-log.js";
import { loopDriverFor, startRefusalIsWaitable } from "./loop-drivers.js";
import { dequeueNext, failOfflineEntry, finishQueueEntry, requeueEntry } from "./objective-queue.js";
import { offlineWaitExpired, offlineWaitSentence, QUEUE_OFFLINE_MAX_MS } from "./objective-queue-offline.js";
import { pausedStartRefusal } from "./instance-pause.js";
import { automaticProviderHold } from "./provider-account-hold.js";
import { recordLifecycle } from "./objective-lifecycle.js";
import { recordDrainRefusal } from "./issue-attempt-hooks.js";
import { markWokenForCheckout, releasedRunAwaitingCheckout, wakeParkedRun } from "./coding-park.js";
import type { ObjectiveQueueEntry } from "./objective-queue.js";
import type { Env } from "../types.js";
import { questionsFromMetadata } from "./question-policy.js";

export type QueueDrainResult =
	/** Nothing was waiting for this instance/repo. The common case, and one cheap SELECT. */
	| { drained: false; held?: string }
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
		// A paused agent claims NOTHING (#1015). Claiming first and letting the pause gate refuse used
		// to FAIL the entry — pause cancels the run, the run's terminal step drains, and the next
		// objective was marked failed with "paused" as its epitaph. Left pending, untouched and with no
		// budget opened, it starts when `POST /:id/resume` drains the queue.
		if (await instancePaused(env, instanceId, userId)) return { drained: false };
		const hold = await automaticProviderHold(env, instanceId, userId);
		if (hold) return { drained: false, held: hold.reason };
		// A run that parked on a question, released this checkout and now has its answer goes FIRST
		// (#1077): it was there before anything queued. Woken, it takes the checkout back; its own end drains next.
		const parked = repoId ? await releasedRunAwaitingCheckout(env, instanceId, repoId).catch(() => null) : null;
		if (parked && (await wakeParkedRun(env, parked, "checkout"))) {
			await markWokenForCheckout(env, parked).catch(() => undefined); // #1228: its grace starts now, so it cannot hold the queue forever
			return { drained: false };
		}
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
			// …and the instance's own bounds on top (#820), resolved at START time for the same
			// reason: an entry that was parked before a floor was configured runs under the floor
			// in force when it actually starts, not the one that applied when it was queued.
			const limits = await readLoopLimits(env, instanceId, owner).catch(() => ({}));
			maxIterations = clampIterations(
				sanitizeMaxIterations(entry.maxIterations ?? undefined, ceilings.loopMaxIterations),
				limits,
				ceilings.loopMaxIterations,
			);
			const budget = await openBudget(env, owner, instanceId);
			budgetId = budget.id;
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			await finishQueueEntry(env, entry.id, "failed", `budget refused: ${message}`);
			await recordLifecycle(env, { ...lifecycleOf(entry), event: "admission_failed", reason: `budget refused: ${message}` });
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
			// What the caller asked for when it queued this (#1385); none ⇒ the driver applies the instance default.
			questions: questionsFromMetadata(entry.metadata),
			budgetId,
			// Depth 0: the queue is the OWNER's, not a subordinate's. A queued objective is not
			// delegated by the run that drained it, and inheriting that run's depth would make the
			// tree budget refuse a follow-up for a lineage it does not belong to.
			depth: 0,
		});

		if (started.ok) {
			await finishQueueEntry(env, entry.id, "started", null, started.runId);
			// The run names the entry and the request it came from (#1017), so it can be traced back.
			try {
				await env.DB.prepare("UPDATE agent_loop_runs SET queue_entry_id = ?2, request_id = COALESCE(request_id, ?3) WHERE run_id = ?1").bind(started.runId, entry.id, entry.requestId ?? null).run();
			} catch {
				// A link, not the start: the run has begun either way, and its own row still names it.
			}
			await recordLifecycle(env, { ...lifecycleOf(entry), event: "admitted", runId: started.runId });
			return { drained: true, entryId: entry.id, started: true, runId: started.runId, driver: started.driver };
		}

		// Busy AGAIN is a race, not a verdict on this objective: another start won the claim between
		// this run releasing it and this drain asking for it. Put the entry back where it was and let
		// the winner's own terminal path drain it.
		//
		// `recovery_required` (#984) is waited for the same way, and that is the point of the issue:
		// the repo holds work owned by a run the platform closed, or an engine still executing a dead
		// run's instruction, so this entry must KEEP ITS PLACE rather than be failed or — as before —
		// started on top of it. The refusal is recorded on the row, because an entry that sits pending
		// with nobody told why is the other half of the same complaint.
		if (startRefusalIsWaitable(started.reason)) {
			// A wait on an offline runner has an end (#1189). A drain that finds the machine still away after the whole bound
			// fails the entry instead of putting it back; `failExpiredOfflineWaits` does the same for machines nothing drains.
			if (started.reason === "runner_offline" && offlineWaitExpired(entry.offlineSince, Date.now())) {
				const sentence = offlineWaitSentence(entry.offlineSince as number, Date.now());
				await finishQueueEntry(env, entry.id, "failed", sentence);
				await recordLifecycle(env, { ...lifecycleOf(entry), event: "admission_failed", reason: sentence });
				return { drained: true, entryId: entry.id, started: false, requeued: false, error: sentence };
			}
			// Only a requeue that moved the claimed row is a deferral, and its event carries the ordinal that
			// row now counts (#1017), so a repeated bookkeeping write for it lands on the same deferral.
			// The reason rides along (#1264): only `runner_overloaded` turns it into a TIMED backoff —
			// see `objective-queue.ts`'s `requeueEntry`.
			const requeue = await requeueEntry(env, entry.id, started.error, { reason: started.reason ?? null });
			if (requeue.requeued) await recordLifecycle(env, { ...lifecycleOf(entry), event: "deferred", reason: started.error, deferralSeq: requeue.deferralSeq });
			return { drained: true, entryId: entry.id, started: false, requeued: requeue.requeued, error: started.error };
		}

		// `runner_offline` (#1161) is waited for too: the machine is asleep or away, and its relay
		// reconnecting drains the queue (`routes/relay.ts`). Failing it stranded every entry behind it.

		// Everything else is structural — no repo on the agent, a checkout that failed admission. Waiting does not fix any of them, so the entry FAILS with the driver's own
		// sentence rather than sitting pending forever with nobody ever told why nothing happened.
		await finishQueueEntry(env, entry.id, "failed", started.error);
		await recordLifecycle(env, { ...lifecycleOf(entry), event: "admission_failed", reason: started.error });
		await recordDrainRefusal(env, entry, repoId, started.reason, started.error); // #1336: an attempt with no run, unless it was the start guard
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

/** Is the instance paused right now? Read fresh; a failed read is NOT a pause (same rule as the driver gate). */
async function instancePaused(env: Env, instanceId: string, userId: string): Promise<boolean> {
	try {
		const row = await env.DB.prepare("SELECT status FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(instanceId, userId).first<{ status: string | null }>();
		return row ? pausedStartRefusal(row.status) !== null : false;
	} catch {
		// Unreadable is not paused: the driver's own pause gate re-reads, and refuses as `paused` (waitable).
		return false;
	}
}

/**
 * Drain once per repo that has pending entries (#1015) — what `POST /:id/resume` calls, because a
 * paused instance's queue has no terminating run left to drain it. One entry per repo, the same rate
 * as a run's terminal path; each started run drains the next as it ends. Never throws.
 */
export async function drainPendingQueues(env: Env, instanceId: string, userId: string): Promise<QueueDrainResult[]> {
	const rows = await env.DB.prepare("SELECT DISTINCT repo_id FROM instance_objective_queue WHERE instance_id = ?1 AND user_id = ?2 AND status = 'pending'")
		.bind(instanceId, userId)
		.all<{ repo_id: string | null }>()
		.catch(() => ({ results: [] as Array<{ repo_id: string | null }> }));
	const out: QueueDrainResult[] = [];
	for (const r of rows.results ?? []) out.push(await tryDequeueAndStart(env, instanceId, r.repo_id ?? null, userId));
	return out;
}

/**
 * The TIMED half of the `runner_overloaded` backoff (#1264). Every other waitable reason is woken
 * by an EVENT — a run finishing, a relay reconnecting — which already calls `drainPendingQueues`.
 * Nothing wakes an overloaded machine recovering on its own clock, so this is its own per-minute
 * cron tick (`scheduled()` in index.ts): find the instances with a `runner_overloaded` entry whose
 * backoff has elapsed, and drain each — which re-asks the gate fresh and either starts it or
 * requeues it again at the next step of the schedule. Never throws; bounded per tick like every
 * other sweep here.
 */
export async function runDueOverloadRetries(env: Env, now: number = Date.now()): Promise<number> {
	const rows = await env.DB.prepare(
		`SELECT DISTINCT instance_id, user_id FROM instance_objective_queue
		  WHERE status = 'pending' AND defer_reason = 'runner_overloaded' AND next_retry_at IS NOT NULL AND next_retry_at <= ?1
		  LIMIT 200`,
	)
		.bind(now)
		.all<{ instance_id: string; user_id: string }>()
		.catch(() => ({ results: [] as Array<{ instance_id: string; user_id: string }> }));
	let tried = 0;
	for (const r of rows.results ?? []) {
		await drainPendingQueues(env, r.instance_id, r.user_id).catch(() => undefined);
		tried++;
	}
	return tried;
}

/**
 * The clock half of the offline bound (#1189). An entry waiting on an offline runner is woken by an EVENT — the relay
 * reconnecting — and a machine that never comes back sends none, so nothing would ever fail it. This is the per-minute cron
 * tick that does: every pending entry whose wait on an offline runner has reached `QUEUE_OFFLINE_MAX_MS` fails with the
 * sentence naming the bound, is recorded in the objective's lifecycle, and frees its place. Bounded per tick; never throws.
 */
export async function failExpiredOfflineWaits(env: Env, now: number = Date.now()): Promise<number> {
	type Overdue = { id: string; instance_id: string; user_id: string; request_id: string | null; offline_since: number };
	let rows: { results?: Overdue[] };
	try {
		rows = await env.DB.prepare(
			`SELECT id, instance_id, user_id, request_id, offline_since FROM instance_objective_queue
			  WHERE status = 'pending' AND defer_reason = 'runner_offline' AND offline_since IS NOT NULL AND offline_since <= ?1
			  ORDER BY offline_since LIMIT 200`,
		)
			.bind(now - QUEUE_OFFLINE_MAX_MS)
			.all<Overdue>();
	} catch {
		return 0; // an unreadable queue is retried on the next tick
	}
	let failed = 0;
	for (const r of rows.results ?? []) {
		try {
			const sentence = offlineWaitSentence(r.offline_since, now);
			if (!(await failOfflineEntry(env, r.id, sentence, now))) continue;
			failed++;
			await recordLifecycle(env, { userId: r.user_id, instanceId: r.instance_id, queueEntryId: r.id, requestId: r.request_id ?? null, actor: { kind: "platform" }, event: "admission_failed", reason: sentence, now });
		} catch {
			// One entry's trouble must not stop the rest; it is retried on the next tick.
		}
	}
	return failed;
}

/** The handles a drain transition is recorded under — the platform is the actor (#1017). */
function lifecycleOf(entry: ObjectiveQueueEntry) {
	return { userId: entry.userId, instanceId: entry.instanceId, queueEntryId: entry.id, requestId: entry.requestId ?? null, actor: { kind: "platform" as const } };
}
