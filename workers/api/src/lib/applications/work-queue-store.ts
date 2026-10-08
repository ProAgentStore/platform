/**
 * The queue reads and writes (#974), shared by the Tailor's and the Runner's run tables.
 *
 * One module for both because the run row IS the queue entry in each of them (migration 0191) and
 * both tables carry the same three queue columns. Parameterising the table is the lesser evil
 * against two copies of a FIFO claim drifting apart — the alternative this repo rejects elsewhere
 * for the same reason (one verb, one implementation).
 *
 * The table name is a closed union, never caller text, so no identifier here is interpolated from
 * anything a request can influence.
 */
import type { Env } from "../../types.js";
import { backoffDelayMs } from "./work-queue.js";

type DB = Pick<Env, "DB">;
export type QueueTable = "local_artifact_runs" | "local_apply_runs";

/** The statuses that mean "this instance's one machine slot is taken right now". */
const BUSY_STATUSES: Record<QueueTable, readonly string[]> = {
	local_artifact_runs: ["running"],
	// A paused fill still owns the machine: it is waiting for the owner, not finished.
	local_apply_runs: ["running", "paused"],
};

export interface QueuedRun {
	id: string;
	instanceId: string;
	userId: string;
	applicationId: string;
	attempts: number;
	nextAttemptAt: number | null;
	createdAt: number;
}

/**
 * The next run this instance should dispatch: queued, due, oldest first — and only when the
 * machine slot is free.
 *
 * The emptiness check and the pick are one statement so a sweep cannot read "free" and then pick a
 * row that a concurrent dispatch has already started on. The caller still claims the row (see
 * {@link claimQueuedDispatch}) before touching the machine; this is the cheap filter, not the lock.
 */
export async function nextDueQueuedRun(env: DB, table: QueueTable, instanceId: string, userId: string, now: number): Promise<QueuedRun | null> {
	const busy = BUSY_STATUSES[table];
	const placeholders = busy.map((_, i) => `?${i + 4}`).join(", ");
	const row = await env.DB.prepare(
		`SELECT id, instance_id, user_id, application_id, attempts, next_attempt_at, created_at
		   FROM ${table}
		  WHERE instance_id = ?1 AND user_id = ?2 AND status = 'queued'
		    AND COALESCE(next_attempt_at, 0) <= ?3
		    AND NOT EXISTS (SELECT 1 FROM ${table} b WHERE b.instance_id = ?1 AND b.user_id = ?2 AND b.status IN (${placeholders}))
		  ORDER BY created_at, id
		  LIMIT 1`,
	)
		.bind(instanceId, userId, now, ...busy)
		.first<{ id: string; instance_id: string; user_id: string; application_id: string; attempts: number | null; next_attempt_at: number | null; created_at: number }>();
	return row
		? { id: row.id, instanceId: row.instance_id, userId: row.user_id, applicationId: row.application_id, attempts: row.attempts ?? 0, nextAttemptAt: row.next_attempt_at, createdAt: row.created_at }
		: null;
}

/** Every instance holding at least one queued run — what a sweep iterates. */
export async function instancesWithQueuedRuns(env: DB, table: QueueTable, limit: number): Promise<Array<{ instanceId: string; userId: string }>> {
	const { results } = await env.DB.prepare(
		`SELECT DISTINCT instance_id, user_id FROM ${table} WHERE status = 'queued' ORDER BY instance_id LIMIT ?1`,
	)
		.bind(limit)
		.all<{ instance_id: string; user_id: string }>();
	return (results ?? []).map((r) => ({ instanceId: r.instance_id, userId: r.user_id }));
}

/**
 * Claim one queued run for a dispatch attempt: bump `attempts` and push `next_attempt_at` out by
 * the backoff BEFORE the machine is asked.
 *
 * Conditional on the attempt count it was read with, so two sweeps racing on one row cannot both
 * claim it — the loser's update changes nothing and it skips the row. Pushing the next attempt out
 * first is deliberate: a dispatch that dies mid-flight (an isolate killed, a runner that never
 * answers) leaves the row due again later rather than claimed forever or hammered every tick.
 */
export async function claimQueuedDispatch(env: DB, table: QueueTable, run: QueuedRun, now: number): Promise<boolean> {
	const res = await env.DB.prepare(
		`UPDATE ${table} SET attempts = ?1, next_attempt_at = ?2, updated_at = ?3
		  WHERE id = ?4 AND status = 'queued' AND COALESCE(attempts, 0) = ?5`,
	)
		.bind(run.attempts + 1, now + backoffDelayMs(run.attempts), now, run.id, run.attempts)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

/** Record that the machine would not take it yet, with the reason the owner reads. */
export async function noteQueued(env: DB, table: QueueTable, runId: string, reason: string, now: number): Promise<void> {
	await env.DB.prepare(`UPDATE ${table} SET queued_reason = ?1, updated_at = ?2 WHERE id = ?3`).bind(reason.slice(0, 300), now, runId).run();
}

/** Where this run sits in its instance's line: 1 = next. Counted over queued rows only. */
export async function queuePosition(env: DB, table: QueueTable, run: { id: string; instanceId: string; userId: string; createdAt: number }): Promise<number> {
	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS ahead FROM ${table}
		  WHERE instance_id = ?1 AND user_id = ?2 AND status = 'queued' AND (created_at < ?3 OR (created_at = ?3 AND id < ?4))`,
	)
		.bind(run.instanceId, run.userId, run.createdAt, run.id)
		.first<{ ahead: number | null }>();
	return Number(row?.ahead ?? 0) + 1;
}

/** The queue columns for one run, for the card and MCP. */
export async function queueFieldsFor(env: DB, table: QueueTable, runId: string): Promise<{ attempts: number; nextAttemptAt: number | null; reason: string | null } | null> {
	const row = await env.DB.prepare(`SELECT attempts, next_attempt_at, queued_reason FROM ${table} WHERE id = ?1`)
		.bind(runId)
		.first<{ attempts: number | null; next_attempt_at: number | null; queued_reason: string | null }>();
	return row ? { attempts: row.attempts ?? 0, nextAttemptAt: row.next_attempt_at, reason: row.queued_reason } : null;
}
