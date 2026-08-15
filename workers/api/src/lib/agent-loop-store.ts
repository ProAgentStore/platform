// Run records for the durable agent loop (#158, migration 0062).
//
// Shape and vocabulary mirror `pipeline-runs.ts` on purpose: a user should not have to learn two
// mental models for "what did my agent do", and #19/#182 want both histories rendered from one.

import { statusFor, type LoopStopReason } from "./agent-loop.js";
import type { Env } from "../types.js";

export interface LoopRunRow {
	run_id: string;
	user_id: string;
	instance_id: string;
	objective: string;
	status: string;
	stop_reason: string | null;
	detail: string | null;
	iteration: number;
	max_iterations: number;
	cancel_requested: number;
	budget_id: string | null;
	started_at: number;
	finished_at: number | null;
	/** ms epoch of the last recorded iteration (0067). Null for a run that never reported. */
	last_progress_at: number | null;
	/** ms epoch of the orchestrator's last heartbeat (0127). Null before its first tick. */
	last_alive_at: number | null;
	/** When a deliberate park is expected to end (0127). Null when the run is not parked. */
	waiting_until: number | null;
	/** Why it is parked (0127) — a short platform enum, never free text. */
	waiting_reason: string | null;
	/** Platform interruptions this run was resumed through (0127, #583). */
	interruptions: number | null;
	/** Supervisor instance that delegated this run (0090). Null when the owner started it. */
	delegated_by: string | null;
	/** Coding session this run drives (0116). Null for chat/pipeline runs. */
	session_id: string | null;
}

/**
 * Why a run is deliberately not advancing (#580).
 *
 * A closed enum rather than a sentence: the whole defect this replaces is that "running" was the
 * only word the record had for three different situations, and a free-text field would let the next
 * one be added without a reader ever learning to distinguish it.
 */
export type RunWaitReason =
	/** The engine's own subscription window is spent and reopens at a stated time (#541). */
	| "engine_limit"
	/** A takeover or a needs-input handoff. Somebody has to answer before the run moves. */
	| "human"
	/** A platform event (our own deploy) interrupted the run and it is being resumed (#583). */
	| "platform_interrupt";

export interface LoopRunView {
	runId: string;
	instanceId: string;
	objective: string;
	status: string;
	stopReason: LoopStopReason | null;
	detail: string | null;
	iteration: number;
	maxIterations: number;
	cancelRequested: boolean;
	budgetId: string | null;
	startedAt: number;
	finishedAt: number | null;
	/**
	 * ms epoch of the last recorded ADVANCE — the run moved to a new instruction (#580).
	 *
	 * NOT a liveness signal, and it was read as one for two releases. `recordIteration` used to
	 * write it unconditionally, and `coding-session.ts`'s pause tick called that on a timer with an
	 * unchanged iteration, so a run parked for 4.35 hours carried a timestamp 3.5 minutes old.
	 * Since 0127 the write is conditional on the iteration actually advancing (see
	 * {@link recordIteration}), so a stale value now means what a reader always assumed it meant.
	 */
	lastProgressAt: number | null;
	/**
	 * ms epoch of the orchestrator's last heartbeat (0127).
	 *
	 * The signal the SWEEPER reads, and the one `isStalled` reads: a Workflow that died mid-step
	 * stops ticking, whereas one parked on a usage limit keeps ticking on purpose. Null on rows
	 * written before 0127 and on a run that died before its first tick — every reader falls back
	 * through `lastProgressAt` to `startedAt`, so absence never reads as death.
	 */
	lastAliveAt: number | null;
	/** When a deliberate park should end, or null when the run is not parked (#580). */
	waitingUntil: number | null;
	/** Why the run is parked, or null when it is not (#580). */
	waitingReason: RunWaitReason | null;
	/** Platform interruptions this run has been resumed through (#583). */
	interruptions: number;
	/**
	 * The supervisor instance that delegated this run, or null when its owner started it (#318).
	 *
	 * AUDIT ONLY — never an authority (`lib/execution-authority.ts`). It exists so a supervisor can
	 * READ BACK work it started somewhere else: its runs live on its subordinates, so an
	 * instance-scoped `check_work` truthfully found nothing and then told a truthful agent it had
	 * misled the user.
	 */
	delegatedBy: string | null;
	/**
	 * The coding session this run drives (#465). Null for chat and pipeline drivers.
	 *
	 * Written once by `codingDriver` at run-create time, never updated. The `check_work` handler
	 * reads it to reach the live `runState` via `/coding/capture`, so the run report can say
	 * "the engine is working" instead of only "NOT stalled".
	 */
	sessionId: string | null;
}

export function toLoopRunView(row: LoopRunRow): LoopRunView {
	return {
		runId: row.run_id,
		instanceId: row.instance_id,
		objective: row.objective,
		status: row.status,
		stopReason: (row.stop_reason as LoopStopReason | null) ?? null,
		detail: row.detail,
		iteration: row.iteration,
		maxIterations: row.max_iterations,
		cancelRequested: row.cancel_requested !== 0,
		budgetId: row.budget_id,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
		lastProgressAt: row.last_progress_at ?? null,
		lastAliveAt: row.last_alive_at ?? null,
		waitingUntil: row.waiting_until ?? null,
		waitingReason: (row.waiting_reason as RunWaitReason | null) ?? null,
		interruptions: row.interruptions ?? 0,
		delegatedBy: row.delegated_by ?? null,
		sessionId: row.session_id ?? null,
	};
}

export async function createLoopRun(
	env: Env,
	input: {
		runId: string;
		userId: string;
		instanceId: string;
		objective: string;
		maxIterations: number;
		budgetId?: string | null;
		startedAt: number;
		/** The supervisor that asked for this (`onBehalfOf`). Omit for a run its owner started. */
		delegatedBy?: string | null;
		/**
		 * The coding session this run drives (#465). Omit for chat and pipeline drivers.
		 * Written once; read by `check_work` to reach the live `runState` via `/coding/capture`.
		 */
		sessionId?: string | null;
	},
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, max_iterations, budget_id, started_at, status, delegated_by, session_id)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'running', ?8, ?9)`,
	)
		.bind(
			input.runId,
			input.userId,
			input.instanceId,
			input.objective.slice(0, 2000),
			input.maxIterations,
			input.budgetId ?? null,
			input.startedAt,
			input.delegatedBy ?? null,
			input.sessionId ?? null,
		)
		.run();
}

export async function getLoopRun(env: Env, userId: string, runId: string): Promise<LoopRunView | null> {
	const row = await env.DB.prepare("SELECT * FROM agent_loop_runs WHERE run_id = ?1 AND user_id = ?2")
		.bind(runId, userId)
		.first<LoopRunRow>();
	return row ? toLoopRunView(row) : null;
}

export async function listLoopRuns(env: Env, userId: string, instanceId: string, limit = 50): Promise<LoopRunView[]> {
	const res = await env.DB.prepare(
		"SELECT * FROM agent_loop_runs WHERE user_id = ?1 AND instance_id = ?2 ORDER BY started_at DESC LIMIT ?3",
	)
		.bind(userId, instanceId, Math.max(1, Math.min(200, limit)))
		.all<LoopRunRow>();
	return (res.results ?? []).map(toLoopRunView);
}

/**
 * The runs one SUPERVISOR started on other agents (#318).
 *
 * The counterpart to `listLoopRuns`, which answers "what did this instance run itself". A
 * supervisor delegates, so its own instance has no runs at all and the two lists together are what
 * "your work" actually means for it.
 *
 * Keyed on `delegated_by` rather than on the supervision graph on purpose: "runs on an agent I
 * supervise" also contains runs the OWNER started there, and claiming those would be the
 * over-claim the instance scoping exists to prevent.
 */
export async function listDelegatedRuns(
	env: Env,
	userId: string,
	supervisorInstanceId: string,
	limit = 50,
): Promise<LoopRunView[]> {
	if (!supervisorInstanceId) return [];
	const res = await env.DB.prepare(
		"SELECT * FROM agent_loop_runs WHERE user_id = ?1 AND delegated_by = ?2 ORDER BY started_at DESC LIMIT ?3",
	)
		.bind(userId, supervisorInstanceId, Math.max(1, Math.min(200, limit)))
		.all<LoopRunRow>();
	return (res.results ?? []).map(toLoopRunView);
}

/**
 * Record an ADVANCE — the run reached a new instruction.
 *
 * ── Why `last_progress_at` moves in a CASE and not unconditionally (#580)
 *
 * This one statement used to write `iteration` and `last_progress_at` together, and the conflation
 * was invisible for as long as every caller passed a number that had just gone up. Then
 * `coding-session.ts`'s pause tick started calling it on a five-minute timer with `pilotSteps`
 * unchanged — deliberately, because `sweepStaleRuns` reads that column and would otherwise close a
 * parked run as dead at 3h. Both callers were locally correct and together they made the platform's
 * only stall signal advance on a run that had not moved since iteration 1 four hours earlier.
 *
 * Splitting the CALLERS would have been enough for today and worth nothing tomorrow: the next
 * heartbeat added by someone who has not read this docblock would re-break it in one line. So the
 * rule lives in the STATEMENT — progress cannot move unless the counter moves — and
 * `agent-loop-store.test.ts` asserts it by calling this with an unchanged iteration.
 *
 * Liveness always moves, because an advance is also a heartbeat, and a park is CLEARED on the same
 * condition: a run that advanced is by definition no longer waiting for anything.
 */
export async function recordIteration(env: Env, runId: string, iteration: number, at: number = Date.now()): Promise<void> {
	await env.DB.prepare(
		`UPDATE agent_loop_runs
		    SET iteration = ?2,
		        last_progress_at = CASE WHEN ?2 > iteration THEN ?3 ELSE last_progress_at END,
		        waiting_until = CASE WHEN ?2 > iteration THEN NULL ELSE waiting_until END,
		        waiting_reason = CASE WHEN ?2 > iteration THEN NULL ELSE waiting_reason END,
		        last_alive_at = ?3
		  WHERE run_id = ?1`,
	)
		.bind(runId, iteration, at)
		.run();
}

/**
 * Record that the ORCHESTRATOR is still alive, and — when it is parked — what it is waiting for.
 *
 * The half of {@link recordIteration} that a heartbeat actually wanted. A tick is a statement about
 * the workflow, never about the objective, so this touches no counter and no progress timestamp.
 *
 * `wait` is the difference between the two truthful reports a non-advancing run can attract. Absent,
 * the run is working and simply has not finished its instruction — a large refactor legitimately
 * spends ten minutes in one step. Present, the run is deliberately stopped until a stated instant or
 * a stated event, which is the sentence run 70ea298e needed and no column could produce.
 *
 * Passing `wait: null` explicitly CLEARS a park; omitting `wait` leaves whatever is stored alone, so
 * a heartbeat that knows nothing about parks cannot erase one.
 */
export async function recordLiveness(
	env: Env,
	runId: string,
	at: number = Date.now(),
	wait?: { reason: RunWaitReason; until?: number | null } | null,
): Promise<void> {
	if (wait === undefined) {
		await env.DB.prepare("UPDATE agent_loop_runs SET last_alive_at = ?2 WHERE run_id = ?1").bind(runId, at).run();
		return;
	}
	await env.DB.prepare("UPDATE agent_loop_runs SET last_alive_at = ?2, waiting_reason = ?3, waiting_until = ?4 WHERE run_id = ?1")
		.bind(runId, at, wait?.reason ?? null, wait?.until ?? null)
		.run();
}

/**
 * Count one platform interruption this run was RESUMED through (#583), and return the new total.
 *
 * Durable rather than in-memory because of how the resume works: the error is allowed to escape
 * `run()` so Cloudflare Workflows replays the journal, and everything outside `step.do` re-executes
 * on the replay — which is precisely where a counter bounding that replay would have to live. An
 * in-memory one would reset on the event it exists to bound.
 *
 * Returns 0 when the row is missing rather than throwing: a run with no loop-run row (a chat-side
 * `start_work` that never created one) simply cannot be bounded, and `codingResumePlan` refuses to
 * resume in that case rather than resuming without a bound.
 */
export async function countInterruption(env: Env, runId: string): Promise<number> {
	await env.DB.prepare("UPDATE agent_loop_runs SET interruptions = COALESCE(interruptions, 0) + 1 WHERE run_id = ?1").bind(runId).run();
	const row = await env.DB.prepare("SELECT interruptions FROM agent_loop_runs WHERE run_id = ?1")
		.bind(runId)
		.first<{ interruptions: number | null }>();
	return row?.interruptions ?? 0;
}

/**
 * Ask a run to stop.
 *
 * Cooperative rather than a kill: the flag is read at the top of each iteration, so the in-flight
 * step completes and its spend settles. Killing mid-step would strand a reservation against the
 * budget pool and leak headroom the tree never gets back.
 */
export async function requestCancel(env: Env, userId: string, runId: string): Promise<boolean> {
	const res = await env.DB.prepare(
		"UPDATE agent_loop_runs SET cancel_requested = 1 WHERE run_id = ?1 AND user_id = ?2 AND status = 'running'",
	)
		.bind(runId, userId)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

export async function isCancelRequested(env: Env, runId: string): Promise<boolean> {
	const row = await env.DB.prepare("SELECT cancel_requested FROM agent_loop_runs WHERE run_id = ?1")
		.bind(runId)
		.first<{ cancel_requested: number }>();
	return !!row && row.cancel_requested !== 0;
}

/** Close a run out. `stopReason` carries WHY; `status` is derived so the two cannot disagree. */
export async function finishLoopRun(
	env: Env,
	runId: string,
	stopReason: LoopStopReason,
	detail: string,
	finishedAt: number,
): Promise<void> {
	await env.DB.prepare(
		`UPDATE agent_loop_runs
		    SET status = ?2, stop_reason = ?3, detail = ?4, finished_at = ?5
		  WHERE run_id = ?1`,
	)
		.bind(runId, statusFor(stopReason), stopReason, detail.slice(0, 2000), finishedAt)
		.run();
}
