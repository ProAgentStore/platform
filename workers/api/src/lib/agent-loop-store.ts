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
	},
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, max_iterations, budget_id, started_at, status)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'running')`,
	)
		.bind(input.runId, input.userId, input.instanceId, input.objective.slice(0, 2000), input.maxIterations, input.budgetId ?? null, input.startedAt)
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

/** Record progress mid-run so a watching console sees movement without the workflow finishing. */
export async function recordIteration(env: Env, runId: string, iteration: number): Promise<void> {
	await env.DB.prepare("UPDATE agent_loop_runs SET iteration = ?2 WHERE run_id = ?1").bind(runId, iteration).run();
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
