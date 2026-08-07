import { Hono } from "hono";
import { requireAdmin } from "../lib/auth.js";
import { normalizeMcpEndpoint } from "../lib/mcp-consent.js";
import type { Env } from "../types.js";

/**
 * Admin cross-user run-trace reader (companion to the owner-scoped
 * /v1/instances/:id/trace). Mounted under /v1/admin so the final URL is
 * /v1/admin/trace/:instanceId. Every handler is behind requireAdmin; the network
 * perimeter (Cloudflare Access) is applied to /v1/admin/* in index.ts.
 *
 * Reads the unified agent_events log (migration 0038) for ONE instance, oldest→
 * newest, so an operator can reconstruct any user's run timeline for debugging.
 *
 * OUTBOUND-MCP DIAGNOSTICS (#265). Outbound MCP calls write here (source "mcp") with the
 * endpoint and remote tool in `context`. The debugging question an operator actually has is
 * never "show me one instance" — it is "is THIS SERVER failing for everyone, or has one tenant
 * misconfigured it?", and "who has been calling that tool". Neither is answerable from a
 * per-instance timeline, so this file gains a cross-instance listing and `endpoint`/`tool`
 * filters on both.
 *
 * The filters read `context` as JSON (`json_extract`) rather than pattern-matching the text.
 * A LIKE over a serialized blob would match an endpoint appearing in some unrelated field — a
 * filter that quietly over-matches in an AUDIT tool is worse than no filter, because the
 * operator believes the result is exhaustive. `json_valid` guards the extract so one malformed
 * row cannot fail the whole query.
 *
 * Cost is honest about itself: `context` is not indexed, so these predicates scan. They are
 * always applied alongside an indexed narrowing (instance, user, source, or the ts ordering with
 * a bounded LIMIT), and this is an operator tool with an admin-only rate limit — not a hot path.
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

export interface TraceFilters {
	instanceId?: string;
	userId?: string;
	traceId?: string;
	source?: string;
	level?: string;
	event?: string;
	/** An MCP endpoint. Normalized before matching, so a filter typed with a trailing slash or
	 *  mixed-case host still finds the rows — which are written in normalized form. */
	endpoint?: string;
	/** A remote tool name, matched exactly against `context.tool`. */
	tool?: string;
	limit?: number;
	/** ASC reads as a timeline (one instance); DESC answers "what happened recently" (fleet-wide). */
	order?: "asc" | "desc";
}

/**
 * Build the parameterized SELECT. Exported and pure so the filter semantics are testable
 * without D1 — the thing worth pinning is that every user-supplied value is a BIND and only the
 * clamped integer limit and the fixed order keyword are ever interpolated.
 */
export function buildTraceQuery(f: TraceFilters): { sql: string; binds: unknown[] } {
	const where: string[] = [];
	const binds: unknown[] = [];
	const eq = (col: string, val: unknown) => {
		binds.push(val);
		where.push(`${col} = ?${binds.length}`);
	};

	if (f.instanceId) eq("instance_id", f.instanceId);
	if (f.userId) eq("user_id", f.userId);
	if (f.traceId) eq("trace_id", f.traceId);
	if (f.source) eq("source", f.source);
	if (f.level) eq("level", f.level);
	if (f.event) eq("event", f.event);
	if (f.endpoint) {
		// Match the normalized form the connector logs. Falling back to the raw string keeps a
		// non-URL filter (someone pasting a host) as a literal that simply matches nothing,
		// rather than silently dropping the predicate and returning everything.
		binds.push(normalizeMcpEndpoint(f.endpoint) ?? f.endpoint);
		where.push(`(context IS NOT NULL AND json_valid(context) AND json_extract(context, '$.endpoint') = ?${binds.length})`);
	}
	if (f.tool) {
		binds.push(f.tool);
		where.push(`(context IS NOT NULL AND json_valid(context) AND json_extract(context, '$.tool') = ?${binds.length})`);
	}

	// A nonsense limit falls back to the DEFAULT, not to 1. `Math.max(1, …)` would turn a
	// mistyped `limit=-5` into a single-row answer that reads as "almost nothing happened".
	const asked = Number(f.limit);
	const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), 1000) : 200;
	const order = f.order === "desc" ? "DESC" : "ASC";
	const sql = `SELECT id, ts, created_at, user_id, instance_id, trace_id, source, level, event, message, context
		FROM agent_events
		${where.length ? `WHERE ${where.join(" AND ")}` : ""}
		ORDER BY ts ${order}
		LIMIT ${limit}`;
	return { sql, binds };
}

/** Read the filters every trace route shares out of the query string. */
function filtersFromQuery(c: { req: { query: (k: string) => string | undefined } }): TraceFilters {
	return {
		userId: c.req.query("user_id") || undefined,
		traceId: c.req.query("trace_id") || undefined,
		source: c.req.query("source") || undefined,
		level: c.req.query("level") || undefined,
		event: c.req.query("event") || undefined,
		endpoint: c.req.query("endpoint") || undefined,
		tool: c.req.query("tool") || undefined,
		limit: Number(c.req.query("limit")) || undefined,
	};
}

/**
 * GET /v1/admin/trace?user_id=&instance_id=&source=&level=&event=&endpoint=&tool=&limit=
 *
 * Fleet-wide, most recent first. The cross-user view #265 asks for: "which tenants hit
 * `delete_site` on that endpoint today" and "is this MCP server failing for everyone" are both
 * one query here and unanswerable from the per-instance route below.
 */
adminTraceRoutes.get("/trace", async (c) => {
	await requireAdmin(c);
	const filters: TraceFilters = {
		...filtersFromQuery(c),
		instanceId: c.req.query("instance_id") || undefined,
		order: "desc",
	};
	const { sql, binds } = buildTraceQuery(filters);
	const events = (await c.env.DB.prepare(sql).bind(...binds).all<TraceRow>()).results ?? [];
	return c.json({ count: events.length, filters, events });
});

/**
 * GET /v1/admin/trace/:instanceId?trace_id=&source=&level=&event=&endpoint=&tool=&limit= —
 * time-ordered (oldest→newest) event stream for one instance, across all users. `trace_id`
 * pins one run; the rest narrow the stream. limit default 200, max 1000.
 */
adminTraceRoutes.get("/trace/:instanceId", async (c) => {
	await requireAdmin(c);
	const instanceId = c.req.param("instanceId");
	const { sql, binds } = buildTraceQuery({ ...filtersFromQuery(c), instanceId, order: "asc" });
	const events = (await c.env.DB.prepare(sql).bind(...binds).all<TraceRow>()).results ?? [];
	return c.json({ count: events.length, instanceId, events });
});

/**
 * GET /v1/admin/trace-endpoints?source=mcp&limit= — which outbound endpoints/tools exist at all,
 * with call counts, failures and the last time each was seen.
 *
 * The filters above are only usable if you know what to type. Without this an operator has to
 * already know an endpoint URL to investigate one, which is exactly backwards for the "some MCP
 * server is misbehaving and I don't know which" case that motivates admin diagnostics.
 */
adminTraceRoutes.get("/trace-endpoints", async (c) => {
	await requireAdmin(c);
	const limit = Math.min(Math.max(1, Number(c.req.query("limit")) || 100), 500);
	const source = c.req.query("source") || "mcp";
	const rows =
		(
			await c.env.DB.prepare(
				`SELECT json_extract(context, '$.endpoint') AS endpoint,
				        json_extract(context, '$.tool')     AS tool,
				        COUNT(*)                             AS calls,
				        SUM(CASE WHEN level IN ('warn','error') THEN 1 ELSE 0 END) AS failures,
				        COUNT(DISTINCT user_id)              AS users,
				        COUNT(DISTINCT instance_id)          AS instances,
				        MAX(ts)                              AS last_ts
				 FROM agent_events
				 WHERE source = ?1 AND context IS NOT NULL AND json_valid(context)
				   AND json_extract(context, '$.endpoint') IS NOT NULL
				 GROUP BY endpoint, tool
				 ORDER BY last_ts DESC
				 LIMIT ?2`,
			)
				.bind(source, limit)
				.all<{ endpoint: string; tool: string | null; calls: number; failures: number; users: number; instances: number; last_ts: number }>()
		).results ?? [];
	return c.json({ source, count: rows.length, endpoints: rows });
});
