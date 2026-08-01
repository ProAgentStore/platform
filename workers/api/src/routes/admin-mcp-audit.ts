import { Hono } from "hono";
import { requireAdmin } from "../lib/auth.js";
import type { Env } from "../types.js";

/**
 * Admin: MCP tool-call audit log (cross-user).
 *
 * WHERE THE DATA LIVES — read this before wiring:
 * The MCP server does NOT record tool calls to a D1 table. It writes them to the
 * MCP worker's KV namespace `OAUTH_KV` (workers/mcp/src/safety.ts → `audit()`),
 * one key per event:
 *
 *     audit:{subject}:{ISO-8601 time}:{uuid}  →  JSON {
 *       time, subject, tool, action, reason?, requiredScope?, scopes?, input?, result?, ...
 *     }
 *
 * `subject` is the authenticated MCP account (user) id. `action` is the allow/deny
 * signal: "denied" = blocked (with `reason`: read_only | missing_scope |
 * missing_confirmation), anything else (completed | write | dry_run | …) = allowed.
 * Events expire after 90 days (KV TTL). Secrets are redacted at write time.
 *
 * This route reads that same KV namespace across ALL subjects (no subject prefix),
 * newest-first. The API worker therefore needs the `OAUTH_KV` binding — see the
 * WIRING note at the bottom of this file. Until that binding exists the route returns
 * a 501 with the exact reason instead of pretending there is data.
 */

/** The KV binding this route needs. `Env` (workers/api/src/types.ts) does not yet
 *  declare it, so we narrow locally rather than edit the shared type. */
type EnvWithOAuthKV = Env & { OAUTH_KV?: KVNamespace };

interface McpAuditEvent {
	time?: string;
	subject?: string;
	tool?: string;
	action?: string;
	reason?: string;
	requiredScope?: string;
	scopes?: string[] | string | null;
	input?: unknown;
	result?: unknown;
	[k: string]: unknown;
}

export const adminMcpAuditRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /mcp-audit — recent MCP tool-call events across every user, newest first.
 * Query: ?limit= (default 200, max 500) ?tool= (exact match) ?user= (subject match).
 */
adminMcpAuditRoutes.get("/mcp-audit", async (c) => {
	await requireAdmin(c);

	const kv = (c.env as EnvWithOAuthKV).OAUTH_KV;
	if (!kv) {
		return c.json(
			{
				error: "OAUTH_KV not bound",
				detail:
					"MCP audit events live in the MCP worker's OAUTH_KV namespace, not in D1. " +
					"Bind it on the API worker (see WIRING note in admin-mcp-audit.ts) to enable this page.",
			},
			501,
		);
	}

	const limit = Math.max(1, Math.min(500, Number(c.req.query("limit")) || 200));
	const toolFilter = c.req.query("tool")?.trim() || undefined;
	const userFilter = c.req.query("user")?.trim() || undefined;

	// Keys are `audit:{subject}:{time}:{uuid}`. To filter by user we can narrow the KV
	// list prefix; otherwise we sweep all `audit:` keys. We over-list (up to the KV
	// per-call cap of 1000) and slice after sort so filters still surface enough rows.
	const prefix = userFilter ? `audit:${userFilter}:` : "audit:";
	const listed = await kv.list({ prefix, limit: 1000 });

	// Key name sorts lexicographically by subject then ISO time; reverse for newest-first
	// within a subject. We still sort loaded events by `time` below for a true global order.
	const names = listed.keys.map((k) => k.name);

	const loaded = await Promise.all(
		names.map(async (name) => {
			const raw = await kv.get(name);
			if (!raw) return null;
			try {
				return JSON.parse(raw) as McpAuditEvent;
			} catch {
				return { raw } as McpAuditEvent;
			}
		}),
	);

	let events = loaded.filter((e): e is McpAuditEvent => e !== null);
	if (toolFilter) events = events.filter((e) => e.tool === toolFilter);

	events.sort((a, b) => String(b.time ?? "").localeCompare(String(a.time ?? "")));
	events = events.slice(0, limit);

	return c.json({ count: events.length, truncated: listed.list_complete === false, events });
});

/*
 * WIRING (three edits, all outside this file — do them separately):
 *
 * 1. workers/api/src/index.ts
 *      import { adminMcpAuditRoutes } from "./routes/admin-mcp-audit.js";
 *      app.route("/v1/admin", adminMcpAuditRoutes);   // → GET /v1/admin/mcp-audit
 *
 * 2. workers/api/wrangler.toml  — give the API worker read access to the SAME KV the
 *    MCP worker writes to (id copied from workers/mcp/wrangler.toml):
 *      [[kv_namespaces]]
 *      binding = "OAUTH_KV"
 *      id = "0a52222c4d0c45b3bba496357d2c8b99"
 *
 * 3. workers/api/src/types.ts  — add to interface Env:
 *      OAUTH_KV?: KVNamespace;
 */
