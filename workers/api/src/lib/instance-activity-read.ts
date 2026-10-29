/**
 * The two reads behind "what is each of my instances doing" (#815) — shared by `GET /my/activity`
 * and the fleet snapshot (#961), so the two cannot disagree about which run is an instance's.
 */
import { parseWaitingAsk, type WaitingAsk } from "./agent-loop-store.js";
import type { ActivityRunRow } from "./instance-activity.js";
import type { Env } from "../types.js";

/** An activity row plus what the snapshot also says: the objective and the park's end. */
export interface LatestRun extends ActivityRunRow {
	objective: string;
	waitingUntil: number | null;
	/** What a `decision` park is asking (#960), or null. */
	waitingAsk: WaitingAsk | null;
}

/**
 * Each instance's newest run. Bounded on `started_at` so a long-dormant instance costs nothing, but
 * `status = 'running'` is OR'd in rather than AND'd: an open run is never missed however old it is,
 * which is exactly the run an owner most needs to see.
 */
export async function readLatestRuns(env: Env, userId: string, since: number): Promise<LatestRun[]> {
	const rows = await env.DB.prepare(
		`SELECT run_id, instance_id, objective, status, stop_reason, started_at, finished_at,
		        last_alive_at, last_progress_at, waiting_reason, waiting_until, parked_since, waiting_ask
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
		waitingAsk: r.waiting_reason === "decision" ? parseWaitingAsk(r.waiting_ask as string | null) : null,
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

/** A queue entry the drain tried and could not start — the record kept once it is no longer pending. */
export interface AdmissionFailure {
	queueEntryId: string;
	reason: string | null;
	objective: string;
	failedAt: number;
}

/**
 * Each instance's newest FAILED admission (#1404), bounded the same lookback a closed run is.
 *
 * An entry that never became a run is otherwise invisible to `recent_instances` / `fleet_snapshot`:
 * it carries no `run_id`, so `readLatestRuns` never sees it, and it left `pending` the moment it
 * failed, so `readQueueDepths` does not count it either. Zero depth and no run reads as plain idle —
 * exactly how an issue closing while its objective sat queued went unnoticed for hours (#1404): the
 * drain recorded `admission_failed` and the owner's only view of their fleet still said nothing ran
 * because nothing was WAITING to.
 */
export async function readLatestAdmissionFailures(env: Env, userId: string, since: number): Promise<Map<string, AdmissionFailure>> {
	const rows = await env.DB.prepare(
		`SELECT instance_id, id, objective, stop_reason, finished_at
		   FROM (
		     SELECT q.*, ROW_NUMBER() OVER (
		              PARTITION BY q.instance_id ORDER BY q.finished_at DESC
		            ) AS rn
		       FROM instance_objective_queue q
		      WHERE q.user_id = ?1 AND q.status = 'failed' AND q.finished_at >= ?2
		   )
		  WHERE rn = 1`,
	)
		.bind(userId, since)
		.all<{ instance_id: string; id: string; objective: string; stop_reason: string | null; finished_at: number }>();
	return new Map(
		(rows.results ?? []).map(
			(r) => [r.instance_id, { queueEntryId: r.id, reason: r.stop_reason, objective: r.objective, failedAt: r.finished_at }] as const,
		),
	);
}
