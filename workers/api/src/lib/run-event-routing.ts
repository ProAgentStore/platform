/**
 * Route recorded run events onto the connection outbox (#579) — the per-minute cron's hand-off from
 * `run_events` to `deliverEvent`, so `run.finished` / `run.stalled` can chain one agent into another
 * exactly as `lead.created` does.
 *
 * Stamp AFTER routing, never before: a tick that dies between the two leaves the row unrouted and the
 * next tick routes it again (at-least-once), and because the payload is the stored one and the trace
 * is the run, the outbox's idempotency key collapses the repeat (no duplicate delivery). A row whose
 * routing throws stays unrouted for the next tick; a consumer that is DOWN is not a throw — the
 * outbox persists that delivery and retries it on its own backoff.
 */
import { deliverEvent } from "./connections.js";
import type { Env } from "../types.js";

export async function routeRunEvents(env: Env, limit = 50): Promise<{ checked: number; routed: number; failed: number }> {
	const { results } = await env.DB.prepare(
		`SELECT seq, run_id, user_id, instance_id, event_type, payload FROM run_events
		  WHERE routed_at IS NULL ORDER BY seq ASC LIMIT ?1`,
	)
		.bind(limit)
		.all<{ seq: number; run_id: string; user_id: string; instance_id: string; event_type: string; payload: string }>();
	let routed = 0;
	let failed = 0;
	for (const row of results ?? []) {
		try {
			await deliverEvent(env, row.instance_id, row.user_id, row.event_type, [JSON.parse(row.payload)], { traceId: row.run_id });
			await env.DB.prepare("UPDATE run_events SET routed_at = ?2 WHERE seq = ?1 AND routed_at IS NULL").bind(row.seq, Date.now()).run();
			routed++;
		} catch {
			failed++;
		}
	}
	return { checked: results?.length ?? 0, routed, failed };
}
