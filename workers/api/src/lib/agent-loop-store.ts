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
	/** Supervisor instance that delegated this run (0090). Null when the owner started it. */
	delegated_by: string | null;
	/** Coding session this run drives (0116). Null for chat/pipeline runs. */
	session_id: string | null;
}

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
	/** ms epoch of the last recorded iteration. A `running` run whose value is far in the past is
	 *  stalled — the only queryable staleness signal there is, since a Workflow that dies mid-step
	 *  leaves `status` at `running` forever. */
	lastProgressAt: number | null;
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

/** Record progress mid-run so a watching console sees movement without the workflow finishing. */
/**
 * Record progress. `at` defaults to now, so every existing caller starts writing the staleness
 * signal with no change — `AgentLoopWorkflow` already calls this once per iteration.
 */
export async function recordIteration(env: Env, runId: string, iteration: number, at: number = Date.now()): Promise<void> {
	await env.DB.prepare("UPDATE agent_loop_runs SET iteration = ?2, last_progress_at = ?3 WHERE run_id = ?1")
		.bind(runId, iteration, at)
		.run();
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
