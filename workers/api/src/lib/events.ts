/**
 * Unified agent trace log (D1 `agent_events`, migration 0038). Every meaningful
 * thing an agent DOES writes one row here — chat turns, tool calls, apply
 * steps/handoffs/outcomes — plus failures bridged from `logError`. One query then
 * reconstructs the full timeline of a run (see GET /v1/instances/:id/trace and the
 * MCP `agent_trace` tool), which is what makes an agent debuggable/improvable.
 *
 * Like the error log, `logEvent` NEVER throws — instrumentation must not break the
 * path it observes — and every field is length-bounded.
 */
import type { Env } from "../types.js";

export type EventLevel = "debug" | "info" | "warn" | "error";

export interface EventInput {
	/** Subsystem: 'chat' | 'apply' | 'coding' | 'voice' | 'tool' | … */
	source: string;
	/** Dotted event name: 'chat.in' | 'tool.call' | 'apply.step' | 'apply.end' | … */
	event: string;
	/** Human-readable one-line summary. */
	message?: string;
	level?: EventLevel;
	/** Owner (for scoping). */
	userId?: string | null;
	/** The agent instance this happened on. */
	instanceId?: string | null;
	/** Groups one run/session — taskId, a chat turn id, a session id. */
	traceId?: string | null;
	/** Structured extras. */
	context?: Record<string, unknown>;
	/** Override the timestamp (ms epoch). Defaults to now. */
	ts?: number;
	/**
	 * A DETERMINISTIC row id, making the write idempotent (#294).
	 *
	 * Omit it and every call gets a fresh uuid, which is right for an event that happens once at
	 * the moment it is logged. Supply it when the same real-world fact can be reported more than
	 * once — an act drained from a runner can be written by a console poll and a Pilot capture
	 * racing each other, and two rows saying "merged a pull request" read as two merges.
	 */
	id?: string;
}

/** Persist a trace event. Best-effort; never throws. */
export async function logEvent(env: Env, e: EventInput): Promise<void> {
	try {
		// `ON CONFLICT(id) DO NOTHING` is a no-op for every caller that lets the id default to a
		// fresh uuid — a random 128-bit key never collides — and is what makes a supplied `id`
		// idempotent. Written in this form rather than `INSERT OR IGNORE` deliberately: several
		// test doubles across the repo recognise a trace write by the literal prefix
		// `INSERT INTO agent_events`, and the equivalent spelling keeps them matching.
		await env.DB.prepare(
			"INSERT INTO agent_events (id, ts, user_id, instance_id, trace_id, source, level, event, message, context) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) ON CONFLICT(id) DO NOTHING",
		)
			.bind(
				e.id ? String(e.id).slice(0, 300) : crypto.randomUUID(),
				typeof e.ts === "number" ? e.ts : Date.now(),
				e.userId ?? null,
				e.instanceId ?? null,
				e.traceId ?? null,
				String(e.source).slice(0, 48),
				e.level ?? "info",
				String(e.event).slice(0, 64),
				e.message != null ? String(e.message).slice(0, 2000) : null,
				e.context ? JSON.stringify(e.context).slice(0, 4000) : null,
			)
			.run();
		// Opportunistic retention: no cron, so ~1% of writes prune rows older than
		// 14 days (indexed on created_at). The trace is a debugging aid, not an archive.
		//
		// This statement is RANDOM: a test fixture that counts statements against this table must
		// match the INSERT above, not the table name, or it counts this one on 1% of runs and
		// flakes (#446, which cost an afternoon being read as CPU starvation).
		if (Math.random() < 0.01) {
			await env.DB.prepare("DELETE FROM agent_events WHERE created_at < datetime('now', '-14 days')")
				.run()
				.catch(() => undefined);
		}
	} catch (err) {
		console.error("[events] failed to persist:", err instanceof Error ? err.message : String(err));
	}
}

export interface EventRow {
	id: string;
	ts: number;
	created_at: string;
	user_id: string | null;
	instance_id: string | null;
	trace_id: string | null;
	source: string;
	level: string;
	event: string;
	message: string | null;
	context: string | null;
}

/**
 * Read a slice of the trace. Always scoped to one owner + one instance. Returns the
 * most recent `limit` events in CHRONOLOGICAL order (oldest→newest) so the result
 * reads as a timeline. Optional `traceId`/`source`/`level` narrow it.
 */
export async function listEvents(
	env: Env,
	opts: { userId: string; instanceId: string; traceId?: string; source?: string; level?: EventLevel; limit?: number },
): Promise<EventRow[]> {
	const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
	const where = ["user_id = ?1", "instance_id = ?2"];
	const binds: unknown[] = [opts.userId, opts.instanceId];
	if (opts.traceId) {
		binds.push(opts.traceId);
		where.push(`trace_id = ?${binds.length}`);
	}
	if (opts.source) {
		binds.push(opts.source);
		where.push(`source = ?${binds.length}`);
	}
	if (opts.level) {
		binds.push(opts.level);
		where.push(`level = ?${binds.length}`);
	}
	// Take the most recent `limit` by ts DESC, then flip to chronological for display.
	const sql = `SELECT id, ts, created_at, user_id, instance_id, trace_id, source, level, event, message, context FROM agent_events WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ${limit}`;
	const res = await env.DB.prepare(sql).bind(...binds).all<EventRow>();
	return (res.results ?? []).reverse();
}
