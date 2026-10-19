import { Hono } from "hono";
import { requireAdmin } from "../lib/auth.js";
import { historyCoverage, keysetBefore, keysetPage, parseHistoryCursor, parseTimeBound, sqlTimeOf } from "../lib/history-page.js";
import { AUDIT_GLOBAL_PREFIX, AUDIT_INDEX_PREFIX } from "../lib/mcp-audit-ledger.js";
import { summarizeAuditLedger } from "../lib/mcp-audit-summary.js";
import { logDirectResponse } from "../lib/on-error.js";
import { redactSecrets } from "../lib/redact.js";
import type { AdminAuditRow } from "../lib/admin.js";
import type { Env } from "../types.js";
import { AUDIT_PAGING_LIMITS, auditPageOr503, parseAuditPaging } from "./mcp-audit.js";

/**
 * Admin-only history readers for the MCP server (#1090): the cross-owner MCP tool-call ledger and
 * the admin-action audit log. Both already had readers under `/v1/admin/*`, but that prefix sits
 * behind the Cloudflare Access perimeter, which the MCP Worker cannot pass — so an admin working
 * through MCP could not read either. Same placement and reason as `/v1/errors/telemetry-health`:
 * outside the perimeter, with the admin ROLE (`requireAdmin`) as the gate on every route.
 */
export const auditRoutes = new Hono<{ Bindings: Env }>();

type EnvWithOAuthKV = Env & { OAUTH_KV?: KVNamespace };

/**
 * GET /v1/audit/mcp — every account's MCP tool-call events, newest first (KV-cursor paged, the
 * ledger's own order). `?user=` narrows to one subject's index. Same paging and filters (tool, action, receipt, request_id, session_id, since, until) as
 * the owner route; a failed ledger read is a 503, never a short page.
 */
auditRoutes.get("/mcp", async (c) => {
	await requireAdmin(c);
	const kv = (c.env as EnvWithOAuthKV).OAUTH_KV;
	if (!kv) return c.json({ error: "OAUTH_KV not bound — the MCP audit ledger is unreadable on this deployment." }, 501);
	const limit = Math.max(1, Math.min(200, Number(c.req.query("limit")) || 100));
	const user = c.req.query("user")?.trim() || undefined;
	const paging = parseAuditPaging(c.req.query());
	if (!paging || (user && user.length > 200)) return c.json({ error: `${AUDIT_PAGING_LIMITS}; user at most 200` }, 400);
	const prefix = user ? `${AUDIT_INDEX_PREFIX}${user}:` : AUDIT_GLOBAL_PREFIX;
	// #1241: per-tool counts over a window, from key metadata alone — the input to the tool-surface audit.
	if (c.req.query("summarize") === "true") {
		try {
			return c.json(await summarizeAuditLedger(kv, { prefix, since: paging.since, until: paging.until, cursor: paging.cursor }));
		} catch (e) {
			return c.json({ error: "MCP audit ledger read failed", detail: e instanceof Error ? e.message : String(e) }, 503);
		}
	}
	return auditPageOr503(c, kv, { prefix, limit, ...paging });
});

/**
 * GET /v1/audit/admin-actions — the admin-action audit log (`admin_audit_log`), newest first by a
 * keyset cursor on `(created_at, id)`, so the whole log is reachable rather than its newest 500.
 * Filters: `?actor=` `?action=` `?target_type=` `?target=` `?since=` `?until=`. `detail` holds the
 * before/after of the change and is redacted again on read, as the MCP ledger is.
 */
auditRoutes.get("/admin-actions", async (c) => {
	await requireAdmin(c);
	const limit = Math.max(1, Math.min(200, Number(c.req.query("limit")) || 100));
	const since = parseTimeBound(c.req.query("since"));
	const until = parseTimeBound(c.req.query("until"));
	if (since === null || until === null) return c.json({ error: "since/until must be an ISO time or epoch milliseconds" }, 400);
	const cursor = parseHistoryCursor(c.req.query("cursor") ?? "newest", "string");
	if (cursor.kind === "invalid") return c.json({ error: "cursor is not one this endpoint issued — pass \"newest\" or a previous nextCursor" }, 400);

	const where: string[] = [];
	const binds: unknown[] = [];
	const exact = (column: string, value: string | undefined) => {
		if (!value) return;
		binds.push(value);
		where.push(`${column} = ?${binds.length}`);
	};
	exact("actor_user_id", c.req.query("actor"));
	exact("action", c.req.query("action"));
	exact("target_type", c.req.query("target_type"));
	exact("target_id", c.req.query("target"));
	if (since !== undefined) {
		binds.push(sqlTimeOf(since));
		where.push(`created_at >= ?${binds.length}`);
	}
	if (until !== undefined) {
		binds.push(sqlTimeOf(until));
		where.push(`created_at <= ?${binds.length}`);
	}
	keysetBefore(cursor, "created_at", where, binds);
	try {
		const res = await c.env.DB.prepare(
			`SELECT id, created_at, actor_user_id, action, target_type, target_id, detail FROM admin_audit_log${
				where.length ? ` WHERE ${where.join(" AND ")}` : ""
			} ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`,
		)
			.bind(...binds)
			.all<AdminAuditRow>();
		const page = keysetPage(res.results ?? [], limit, (row) => row.created_at);
		return c.json({
			order: "newest_first",
			count: page.rows.length,
			audit: page.rows.map((row) => ({ ...row, detail: redactDetail(row.detail) })),
			hasMore: page.hasMore,
			nextCursor: page.nextCursor,
			coverage: await historyCoverage(c.env, "admin_audit_log", true),
		});
	} catch (e) {
		const error = `admin audit read failed: ${e instanceof Error ? e.message : String(e)}`;
		// This Worker's own read failed — an `error`, not the dependency `warn` a returned 503 gets by default (#1134).
		await logDirectResponse(c.env, { status: 503, level: "error", source: "admin-audit", message: error, context: { path: c.req.path, method: c.req.method } });
		return c.json({ error, audit: null }, 503);
	}
});

function redactDetail(detail: string | null): unknown {
	if (detail === null) return null;
	try {
		return redactSecrets(JSON.parse(detail));
	} catch {
		return redactSecrets(detail);
	}
}
