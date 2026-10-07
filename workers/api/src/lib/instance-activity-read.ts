/**
 * The two reads behind "what is each of my instances doing" (#815) — shared by `GET /my/activity`
 * and the fleet snapshot (#961), so the two cannot disagree about which run is an instance's.
 */
import type { ActivityRunRow } from "./instance-activity.js";
import type { Env } from "../types.js";

/** An activity row plus what the snapshot also says: the objective and the park's end. */
export interface LatestRun extends ActivityRunRow {
	objective: string;
	waitingUntil: number | null;
}

/**
 * Each instance's newest run. Bounded on `started_at` so a long-dormant instance costs nothing, but
 * `status = 'running'` is OR'd in rather than AND'd: an open run is never missed however old it is,
 * which is exactly the run an owner most needs to see.
 */
export async function readLatestRuns(env: Env, userId: string, since: number): Promise<LatestRun[]> {
	const rows = await env.DB.prepare(
		`SELECT run_id, instance_id, objective, status, stop_reason, started_at, finished_at,
		        last_alive_at, last_progress_at, waiting_reason, waiting_until, parked_since
		   FROM (
		     SELECT r.*, ROW_NUMBER() OVER (
		              PARTITION BY r.instance_id ORDER BY r.started_at DESC
		            ) AS rn
		       FROM agent_loop_runs r
		      WHERE r.user_id = ?1
		        AND (r.status = 'running' OR r.started_at >= ?2)
		   )
		  WHERE rn = 1`,
	)
		.bind(userId, since)
		.all<Record<string, unknown>>();
	return (rows.results ?? []).map((r) => ({
		instanceId: String(r.instance_id),
		runId: String(r.run_id),
		objective: String(r.objective ?? ""),
		status: String(r.status),
		stopReason: (r.stop_reason as string | null) ?? null,
		finishedAt: (r.finished_at as number | null) ?? null,
		startedAt: Number(r.started_at),
		lastAliveAt: (r.last_alive_at as number | null) ?? null,
		lastProgressAt: (r.last_progress_at as number | null) ?? null,
		waitingReason: (r.waiting_reason as string | null) ?? null,
		waitingUntil: (r.waiting_until as number | null) ?? null,
		parkedSince: (r.parked_since as number | null) ?? null,
	}));
}

/** Objectives still queued, per instance. */
export async function readQueueDepths(env: Env, userId: string): Promise<Map<string, number>> {
	const rows = await env.DB.prepare(
		`SELECT instance_id, COUNT(*) AS depth
		   FROM instance_objective_queue
		  WHERE user_id = ?1 AND status = 'pending'
		  GROUP BY instance_id`,
	)
		.bind(userId)
		.all<Record<string, unknown>>();
	return new Map((rows.results ?? []).map((r) => [String(r.instance_id), Number(r.depth) || 0] as const));
}
