import { Hono } from "hono";
import { requireAdmin } from "../lib/auth.js";
import type { Env } from "../types.js";

/**
 * Admin cross-user run-trace reader (companion to the owner-scoped
 * /v1/instances/:id/trace). Mounted under /v1/admin so the final URL is
 * /v1/admin/trace/:instanceId. Every handler is behind requireAdmin; the network
 * perimeter (Cloudflare Access) is applied to /v1/admin/* in index.ts.
 *
 * Reads the unified agent_events log (migration 0038) for ONE instance, oldest→
 * newest, so an operator can reconstruct any user's run timeline for debugging.
 */
export const adminTraceRoutes = new Hono<{ Bindings: Env }>();

interface TraceRow {
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
 * GET /v1/admin/trace/:instanceId?trace_id=&source=&level=&limit= — time-ordered
 * (oldest→newest) event stream for one instance, across all users. `trace_id`
 * pins one run; `source`/`level` filter the stream. limit default 200, max 1000.
 */
adminTraceRoutes.get("/trace/:instanceId", async (c) => {
	await requireAdmin(c);
	const instanceId = c.req.param("instanceId");
	const where: string[] = ["instance_id = ?"];
	const binds: unknown[] = [instanceId];

	const traceId = c.req.query("trace_id");
	const source = c.req.query("source");
	const level = c.req.query("level");
	if (traceId) { binds.push(traceId); where.push("trace_id = ?"); }
	if (source) { binds.push(source); where.push("source = ?"); }
	if (level) { binds.push(level); where.push("level = ?"); }

	const limit = Math.min(Math.max(1, Number(c.req.query("limit")) || 200), 1000);
	const sql = `SELECT id, ts, created_at, user_id, instance_id, trace_id, source, level, event, message, context
		FROM agent_events
		WHERE ${where.join(" AND ")}
		ORDER BY ts ASC
		LIMIT ${limit}`;
	const events = (await c.env.DB.prepare(sql).bind(...binds).all<TraceRow>()).results ?? [];
	return c.json({ count: events.length, instanceId, events });
});
