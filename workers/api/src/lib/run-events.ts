/**
 * A run's end, announced (#579) — one durable, owner-scoped fact per terminal transition, readable
 * as a cursor feed and routed onto the existing connection outbox.
 *
 * Detection already existed; transport did not. Every run driver (loop, coding, pipeline, browser /
 * apply) closes its `agent_loop_runs` row through `finishLoopRun`, and the platform closes the rows a
 * run stopped reporting on through the sweeper and session displacement. Those writers call
 * `recordRunEvent` after their UPDATE; nothing else does.
 *
 * The delivery contract:
 *   • `run.finished` — the run closed itself (any status: completed, failed, cancelled, needs_human).
 *     `run.stalled`  — the platform closed it because it went quiet. Distinct producers, distinct
 *     types: a stall is "your machine went quiet", a failure is "the provider said no".
 *   • Exactly one row per (run, type): UNIQUE in the schema, so a repeated terminal write records
 *     nothing new.
 *   • At-least-once to connections: the writer only RECORDS. `routeRunEvents` (per-minute cron,
 *     `run-event-routing.ts`) hands every unrouted row to the connection outbox and stamps it only
 *     after, so a crash between record and route loses nothing, and an overlapping tick is collapsed
 *     by the outbox's idempotency key. Retries, backoff and dead-lettering are the outbox's own
 *     (`connection-deliveries.ts`). Keeping the writers free of the outbox also keeps the run
 *     stores (`agent-loop-store`, `coding-store`) out of the connections import graph.
 *   • Owner-scoped by construction: user and instance come from the run row, never from a caller.
 *   • Best-effort for the writer: announcing a run's end must never fail the run's close.
 *
 * Not here, deliberately: a user-registered outbound webhook. It needs HMAC signing, per-account
 * rate limits and `safeFetch`, none of which this groundwork has to decide (#579 phase 3).
 */
import { codingSessionLink, instanceLink } from "./console-links.js";
import type { Env } from "../types.js";

export const RUN_EVENT_TYPES = ["run.finished", "run.stalled"] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

/** What a receiver gets — every field read from the run record, `traceId` joins it to the trace. */
export interface RunEventPayload {
	event: RunEventType;
	runId: string;
	instanceId: string;
	status: string;
	stopReason: string | null;
	detail: string;
	iterations: number;
	maxIterations: number;
	sessionId: string | null;
	delegatedBy: string | null;
	startedAt: number;
	finishedAt: number;
	traceId: string;
	link: string;
}

export interface RunEvent {
	seq: number;
	eventType: RunEventType;
	payload: RunEventPayload;
	createdAt: number;
}

interface RunRow {
	run_id: string;
	user_id: string;
	instance_id: string;
	status: string;
	stop_reason: string | null;
	detail: string | null;
	iteration: number;
	max_iterations: number;
	session_id: string | null;
	delegated_by: string | null;
	started_at: number;
	finished_at: number | null;
}

const DETAIL_CHARS = 500;

export function runEventPayload(row: RunRow & { finished_at: number }, event: RunEventType): RunEventPayload {
	return {
		event,
		runId: row.run_id,
		instanceId: row.instance_id,
		status: row.status,
		stopReason: row.stop_reason,
		detail: (row.detail ?? "").slice(0, DETAIL_CHARS),
		iterations: row.iteration,
		maxIterations: row.max_iterations,
		sessionId: row.session_id,
		delegatedBy: row.delegated_by,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
		traceId: row.run_id,
		link: row.session_id ? codingSessionLink(row.instance_id, row.session_id) : instanceLink(row.instance_id),
	};
}

/**
 * Record the end of one run. `finishedAt` is the value THIS writer stored: if the row now
 * carries another, a different writer closed it (the sweeper lost a race to the workflow's own
 * finish, or the reverse) and that writer announces it — so a sweep that changed nothing can never
 * label a clean finish a stall. Never throws.
 */
export async function recordRunEvent(env: Env, runId: string, event: RunEventType, finishedAt: number): Promise<"recorded" | "duplicate" | "skipped"> {
	try {
		const row = await env.DB.prepare(
			`SELECT run_id, user_id, instance_id, status, stop_reason, detail, iteration, max_iterations,
			        session_id, delegated_by, started_at, finished_at
			   FROM agent_loop_runs WHERE run_id = ?1`,
		)
			.bind(runId)
			.first<RunRow>();
		if (!row || row.status === "running" || row.finished_at !== finishedAt) return "skipped";

		const payload = runEventPayload({ ...row, finished_at: finishedAt }, event);
		const inserted = await env.DB.prepare(
			`INSERT INTO run_events (run_id, user_id, instance_id, event_type, payload, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
			 ON CONFLICT(run_id, event_type) DO NOTHING`,
		)
			.bind(row.run_id, row.user_id, row.instance_id, event, JSON.stringify(payload), Date.now())
			.run();
		return (inserted.meta?.changes ?? 0) > 0 ? "recorded" : "duplicate";
	} catch {
		return "skipped";
	}
}

/** The owner's run events on one instance after `since` (exclusive), oldest first. */
export async function listRunEvents(
	env: Env,
	userId: string,
	instanceId: string,
	opts: { since?: number; limit?: number } = {},
): Promise<{ events: RunEvent[]; nextCursor: number }> {
	const since = Math.max(0, Math.floor(opts.since ?? 0));
	const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), 200);
	const { results } = await env.DB.prepare(
		`SELECT seq, event_type, payload, created_at FROM run_events
		  WHERE user_id = ?1 AND instance_id = ?2 AND seq > ?3
		  ORDER BY seq ASC LIMIT ?4`,
	)
		.bind(userId, instanceId, since, limit)
		.all<{ seq: number; event_type: RunEventType; payload: string; created_at: number }>();
	const events = (results ?? []).map((r) => ({ seq: r.seq, eventType: r.event_type, payload: JSON.parse(r.payload) as RunEventPayload, createdAt: r.created_at }));
	return { events, nextCursor: events.length ? events[events.length - 1].seq : since };
}
