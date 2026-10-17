import type { Context, Hono } from "hono";
import { HttpError, isAdmin, requireUser } from "../lib/auth.js";
import { type EventLevel, listEvents, listEventsPage } from "../lib/events.js";
import { historyCoverage, parseHistoryCursor, parseTimeBound } from "../lib/history-page.js";
import { logDirectResponse } from "../lib/on-error.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

/**
 * Unified run trace — the complete time-ordered timeline of what this agent DID
 * (chat turns, tool calls, apply steps/handoffs/outcomes, and bridged failures),
 * so a run can be reconstructed and debugged from one place. Filter by `trace_id`
 * (one run/turn), `source`, or `level` — a FLOOR since #564, so `?level=warn` returns the warnings AND the errors above them (it read as an equality until then, excluding exactly the rows a caller asking for warnings most wanted); `limit` caps how many recent events.
 *
 * Two shapes (#1090). Without `?cursor=` it is the original window — the newest `limit` (max 1000)
 * events, oldest→newest — unchanged for its callers. With `?cursor=newest` (then each reply's
 * `nextCursor`) it walks the WHOLE retained trace newest-first by keyset, which is the only way past
 * the window, and reports retention and replay backlog beside the page. `?since=`/`?until=` (ISO or
 * epoch ms) bound either. `?scope=all` lets an ADMIN read an instance they do not own; for anyone
 * else it is ignored and ownership applies as before.
 */
export function registerTraceRoutes(router: Hono<{ Bindings: Env }>): void {
	router.get("/:instanceId/trace", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		const rawCursor = c.req.query("cursor");
		// The admin lookup costs a query, so it is only made when the answer can change the reply.
		const admin = rawCursor !== undefined || c.req.query("scope") === "all" ? await isAdmin(c, session) : false;
		const crossOwner = c.req.query("scope") === "all" && admin;
		if (crossOwner) await requireInstanceExists(c, instanceId);
		else await requireOwnedInstance(c.env, instanceId, session.uid);

		const level = c.req.query("level");
		const since = parseTimeBound(c.req.query("since"));
		const until = parseTimeBound(c.req.query("until"));
		if (since === null || until === null) return c.json({ error: "since/until must be an ISO time or epoch milliseconds" }, 400);
		const filter = {
			instanceId,
			traceId: c.req.query("trace_id") || c.req.query("traceId") || undefined,
			source: c.req.query("source") || undefined,
			level: (level === "debug" || level === "info" || level === "warn" || level === "error" ? level : undefined) as EventLevel | undefined,
		};
		const limit = Number(c.req.query("limit")) || 200;

		// The legacy window, byte-for-byte, for every caller that asks for it.
		if (rawCursor === undefined && !crossOwner && since === undefined && until === undefined) {
			const events = await listEvents(c.env, { ...filter, userId: session.uid, limit });
			return c.json({ instanceId, count: events.length, events });
		}
		const cursor = parseHistoryCursor(rawCursor ?? "newest", "number");
		if (cursor.kind === "invalid") return c.json({ error: "cursor is not one this endpoint issued — pass \"newest\" or a previous nextCursor" }, 400);
		try {
			const page = await listEventsPage(c.env, { ...filter, userId: crossOwner ? undefined : session.uid, since, until, cursor, limit });
			return c.json({
				instanceId,
				scope: crossOwner ? "all" : "me",
				order: "newest_first",
				count: page.events.length,
				events: page.events,
				hasMore: page.hasMore,
				nextCursor: page.nextCursor,
				coverage: await historyCoverage(c.env, "agent_events", admin),
			});
		} catch (e) {
			// A failed read is an error, never an empty page that reads as "nothing happened" — and it is
			// this Worker's own fault, so recorded at `error` rather than as a dependency's 503 (#1134).
			const error = `trace read failed: ${e instanceof Error ? e.message : String(e)}`;
			await logDirectResponse(c.env, { status: 503, level: "error", source: "trace-read", message: error, userId: session.uid, context: { instanceId } });
			return c.json({ error, events: null }, 503);
		}
	});
}

async function requireInstanceExists(c: Context<{ Bindings: Env }>, instanceId: string): Promise<void> {
	const row = await c.env.DB.prepare("SELECT id FROM agent_instances WHERE id = ?1").bind(instanceId).first();
	if (!row) throw new HttpError(404, "Instance not found");
}
