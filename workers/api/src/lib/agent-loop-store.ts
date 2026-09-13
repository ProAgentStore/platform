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
	/**
	 * ms epoch this park's clock RUNS OUT (0127). Null when the run is not parked, or when the park
	 * has no knowable end. Whether running out means "resumes" or "gives up" is entailed by
	 * `waiting_reason` and is never stored twice — see `work-report.ts`'s `PARKS` (#596).
	 */
	waiting_until: number | null;
	/** Why it is parked (0127) — a short platform enum, never free text. */
	waiting_reason: string | null;
	/**
	 * ms epoch this park BEGAN (0150, #790). Non-null exactly when `waiting_reason` is, and — the
	 * property the bound depends on — NOT pushed forward by the ticks a park generates. See the
	 * migration for why none of the existing timestamps can answer "how long has it been parked".
	 */
	parked_since: number | null;
	/** Platform interruptions this run was resumed through (0127, #583). */
	interruptions: number | null;
	/** Supervisor instance that delegated this run (0090). Null when the owner started it. */
	delegated_by: string | null;
	/** Coding session this run drives (0116). Null for chat/pipeline runs. */
	session_id: string | null;
}

/**
 * Why a run is deliberately not advancing (#580) — as a VALUE, so a guard can count it (#596).
 *
 * A closed enum rather than a sentence: the whole defect this replaces is that "running" was the
 * only word the record had for three different situations, and a free-text field would let the next
 * one be added without a reader ever learning to distinguish it.
 *
 *   engine_limit       — the engine's own subscription window is spent and reopens at a stated
 *                        time (#541). Its deadline is a RESUME.
 *   human              — a takeover or a needs-input handoff. Somebody has to answer before the run
 *                        moves. Its deadline is a GIVE-UP (`coding-pause.ts`'s 15 minutes).
 *   platform_interrupt — the run was cut off by something that was not the objective and Cloudflare
 *                        is replaying the journal (#583). Our own deploy evicting the isolate, or —
 *                        since #758 — the model provider's transport dropping mid-reply. The NAME is
 *                        kept rather than split per cause: what a reader of this column needs is the
 *                        park's shape (nothing is ticking, a replay is in flight, no instant to
 *                        state), which is identical for both, and rows already carry the string.
 *                        Which of the two it was lives where causes live — the `error_log` row's
 *                        `failureClass` and the sentence `coding-run-report.ts` composes from it.
 *                        No knowable instant; when one exists it is a RESUME.
 *
 * ── Why this is an array and not only a union (#596)
 *
 * The same reason `RUN_HEALTH_STATES` is (#588), measured on this file's own denominator: a `type`
 * union is erased, `workers/api/tsconfig.json` excludes `src/**\/*.test.ts`, and vitest transpiles
 * without checking — so `run-health-readers.test.ts`'s `const REASONS: Record<RunWaitReason, true>`
 * was an exhaustiveness check that COMPILES NOWHERE and could never have gone red. A fourth reason
 * added tomorrow would have slipped past the one guard whose stated job is to count them.
 *
 * Every table keyed by a park reason — `work-report.ts`'s `PARKS`, `coding-run-state.ts`'s
 * `PARK_GLOSS` — is a place a new member can go unhandled. This array is what lets a test walk them.
 */
export const RUN_WAIT_REASONS = ["engine_limit", "human", "platform_interrupt"] as const;

export type RunWaitReason = (typeof RUN_WAIT_REASONS)[number];

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
	/**
	 * ms epoch this park's clock RUNS OUT, or null when the run is not parked (#580).
	 *
	 * NOT "when it resumes". Two parks can state an instant and they mean opposite things: an
	 * `engine_limit` park resumes at it, a `human` handoff GIVES UP at it. The kind is entailed by
	 * {@link waitingReason} — one fact, one column — and `work-report.ts`'s `waitClause` is the only
	 * thing that renders it, so the verb can never be chosen by a reader that guessed (#596).
	 */
	waitingUntil: number | null;
	/** Why the run is parked, or null when it is not (#580). */
	waitingReason: RunWaitReason | null;
	/**
	 * ms epoch this park BEGAN, or null when the run is not parked (0150, #790).
	 *
	 * The signal `runHealth` needs to bound a park, and the one no existing column could carry: the
	 * heartbeat is rewritten by every tick, progress dates the last ADVANCE, and `waitingUntil` is
	 * null for the one park that has no knowable end — which is precisely the park that can hide
	 * forever. Written once when the park starts and deliberately NOT refreshed while it lasts.
	 */
	parkedSince: number | null;
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
		parkedSince: row.parked_since ?? null,
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
 * The runs still OPEN on one instance (#791).
 *
 * Its own query rather than a filter over {@link listLoopRuns}: that one reads 50 rows ordered by
 * `started_at DESC` and would pull a year of finished runs to find the handful that matter. This
 * predicate matches `idx_agent_loop_runs_open` (migration 0068), a PARTIAL index on
 * `status = 'running'` — a row leaves it the moment it closes, so the index stays the size of the
 * open set however much history accumulates behind it. That is what makes this cheap enough to sit
 * on a state read.
 *
 * Owner-scoped like every other reader here: a run belongs to the user who started it, and the
 * route that calls this has already proven the instance is theirs.
 */
/**
 * How far back a resume note will look for the run it is about (#523).
 *
 * A bound, not a policy: without one this query walks `idx_agent_loop_runs_instance` to the
 * beginning of the instance's history every time there is NO resumable run, which is the normal
 * case on every ordinary start. Six hours is also the semantic answer — a note about work a run did
 * last week is not a checkpoint, it is archaeology, and the repository has moved since.
 */
export const RESUME_NOTE_LOOKBACK_MS = 6 * 60 * 60 * 1000;

/**
 * The stop reasons after which a successor is told what already landed (#523 item 4, #806).
 *
 * The test is "did the run reach a verdict on its objective". These four did not — something else
 * ended the run while the work was still going, and a new run started from the bare objective
 * re-does what is already pushed:
 *
 *   * `interrupted`     — the platform cut the invocation off (#546).
 *   * `max_iterations`  — the Pilot used up its step budget mid-work (#806's own case).
 *   * `engine_limit`    — the coding CLI's usage window outlasted the run's wait (#541).
 *   * `provider_credit` — the owner's Anthropic account ran dry; its own sentence says "start the
 *                         run again" after topping up (#773), and that restart is this successor.
 *
 * The rest are verdicts or choices and stay out. A `failed` run got to say what happened, and
 * repeating its steps may be exactly right. `escalated` is the run asking a human, answered through
 * its own handoff rather than a successor. `cancelled` is a human stopping it, and a restart after
 * that may well be the "start clean" #806 lists as an option in its own right. `done` needs nothing.
 */
export const RESUMABLE_STOP_REASONS = ["interrupted", "max_iterations", "engine_limit", "provider_credit"] as const satisfies readonly LoopStopReason[];

export type ResumableStopReason = (typeof RESUMABLE_STOP_REASONS)[number];

export function isResumableStopReason(reason: string | null | undefined): reason is ResumableStopReason {
	return (RESUMABLE_STOP_REASONS as readonly string[]).includes(reason ?? "");
}

/**
 * The last run on THIS session that ended without a verdict on its objective (#523, item 4; #806).
 *
 * Which endings qualify, and why the others do not, is {@link RESUMABLE_STOP_REASONS}.
 *
 * IMMEDIATE successor only, which is why the query takes the most recent finished run and THEN asks
 * what ended it, rather than asking SQL for the most recent interrupted one. Those differ, and the
 * difference is a bug: after run A is cut off and run B picks the note up and finishes the work, a
 * later run C would find A again and be briefed on a checkpoint that has already been consumed. A
 * normal ending in between means the note's job is done.
 *
 * `finished_at IS NOT NULL` because an unfinished row is a run still going: its acts are not a
 * record of something to skip, they are a live session's, and #790 is what makes "reached a
 * terminal state" a reliable trigger point at all. It also excludes the CALLER — a run asking this
 * question has not finished, so it can never be briefed on itself.
 *
 * Ordered and bounded on `started_at` so it rides `idx_agent_loop_runs_instance` directly; see
 * {@link RESUME_NOTE_LOOKBACK_MS} for why the floor is not optional.
 */
export async function lastUnfinishedRunForSession(
	env: Env,
	userId: string,
	instanceId: string,
	sessionId: string,
	now: number = Date.now(),
): Promise<(LoopRunView & { stopReason: ResumableStopReason }) | null> {
	const row = await env.DB.prepare(
		`SELECT * FROM agent_loop_runs
		  WHERE instance_id = ?2 AND user_id = ?1 AND session_id = ?3
		    AND finished_at IS NOT NULL
		    AND started_at >= ?4
		  ORDER BY started_at DESC LIMIT 1`,
	)
		.bind(userId, instanceId, sessionId, now - RESUME_NOTE_LOOKBACK_MS)
		.first<LoopRunRow>();
	// The predecessor exists but reached a verdict — nothing to hand forward. See the header.
	if (!row || !isResumableStopReason(row.stop_reason)) return null;
	return { ...toLoopRunView(row), stopReason: row.stop_reason };
}

export async function listActiveRuns(env: Env, userId: string, instanceId: string): Promise<LoopRunView[]> {
	const res = await env.DB.prepare(
		"SELECT * FROM agent_loop_runs WHERE user_id = ?1 AND instance_id = ?2 AND status = 'running' ORDER BY started_at DESC",
	)
		.bind(userId, instanceId)
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
 *
 * `parked_since` is cleared on that same condition and in that same statement (0150, #790) — the
 * invariant it has to keep is that it is non-null exactly when `waiting_reason` is, and the only way
 * to guarantee that is for one statement to write both.
 */
export async function recordIteration(env: Env, runId: string, iteration: number, at: number = Date.now()): Promise<void> {
	await env.DB.prepare(
		`UPDATE agent_loop_runs
		    SET iteration = ?2,
		        last_progress_at = CASE WHEN ?2 > iteration THEN ?3 ELSE last_progress_at END,
		        waiting_until = CASE WHEN ?2 > iteration THEN NULL ELSE waiting_until END,
		        waiting_reason = CASE WHEN ?2 > iteration THEN NULL ELSE waiting_reason END,
		        parked_since = CASE WHEN ?2 > iteration THEN NULL ELSE parked_since END,
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
 *
 * ── `until` had no production writer for two releases (#591)
 *
 * The parameter below was implemented, bound into the UPDATE, and exercised only by
 * `run-liveness.test.ts:166`. All three production call sites passed a `reason` and no `until`, so
 * the column read null on **89 of 89 runs** — including one parked 6h51m by its own wall clock —
 * while `planEngineWait` had computed the exact instant and `coding-wait.ts` was already printing it
 * into the owner's chat. #570's pattern precisely: the helper is tested, the call sites are not, so
 * the column reads as implemented and nothing populates it. `run-park-writers.test.ts` now drives
 * the production path instead of this function, which is the only way that class of defect is
 * visible.
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
	// `parked_since` is set only when the row is NOT ALREADY PARKED, and that CASE is the whole
	// mechanism (#790). A park generates a tick every few minutes and every one of them calls this
	// function with the same reason; writing `at` unconditionally would push the park's start date
	// forward on every tick, and the bound built on it would measure "time since the last tick" —
	// which is the exact defect this closes, reintroduced one column over. Cleared in the same
	// statement when the park is (`wait: null`), so the two columns cannot disagree.
	await env.DB.prepare(
		`UPDATE agent_loop_runs
		    SET last_alive_at = ?2,
		        waiting_reason = ?3,
		        waiting_until = ?4,
		        parked_since = CASE
		          WHEN ?3 IS NULL THEN NULL
		          WHEN waiting_reason IS NULL OR parked_since IS NULL THEN ?2
		          ELSE parked_since
		        END
		  WHERE run_id = ?1`,
	)
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
 * `start_work` that never created one) simply cannot be bounded, and `driverResumePlan` refuses to
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
	// `cancel_requested_at` is what lets the sweeper enforce a stop the workflow never read (0150,
	// #790). COALESCE so a second `stop_work` on the same run does not reset the clock — the run has
	// been ignoring the request since the FIRST one, and re-asking must not buy it another grace
	// period.
	const res = await env.DB.prepare(
		`UPDATE agent_loop_runs
		    SET cancel_requested = 1, cancel_requested_at = COALESCE(cancel_requested_at, ?3)
		  WHERE run_id = ?1 AND user_id = ?2 AND status = 'running'`,
	)
		.bind(runId, userId, Date.now())
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
