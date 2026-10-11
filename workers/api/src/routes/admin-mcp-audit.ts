import { Hono } from "hono";
import { requireAdmin } from "../lib/auth.js";
import type { Env } from "../types.js";
import { AUDIT_GLOBAL_PREFIX, AUDIT_INDEX_PREFIX } from "../lib/mcp-audit-ledger.js";
import { auditPageOr503, parseAuditPaging } from "./mcp-audit.js";

/**
 * Admin: MCP tool-call audit log (cross-user).
 *
 * WHERE THE DATA LIVES — read this before wiring:
 * The MCP server does NOT record tool calls to a D1 table. It writes them to the
 * MCP worker's KV namespace `OAUTH_KV` (workers/mcp/src/safety.ts → `audit()`),
 * in the time-ordered ledger `lib/mcp-audit-ledger.ts` describes (#1016):
 *
 *     audit_all:{inverted time}:{subject}:{uuid}  →  JSON {
 *       id, time, subject, tool, action, reason?, requiredScope?, scopes?, input?, result?, ...
 *     }
 *
 * `subject` is the authenticated MCP account (user) id. `action` is the allow/deny
 * signal: "denied" = blocked (with `reason`: read_only | missing_scope |
 * missing_confirmation), anything else (completed | write | dry_run | …) = allowed.
 * Events expire after 90 days (KV TTL). Secrets are redacted at write time.
 *
 * This route reads that ledger across ALL subjects (`audit_all:`), or one subject's
 * `audit_idx:{subject}:` index with `?user=`, newest-first, paged by `?cursor=`. The API worker therefore needs the `OAUTH_KV` binding — see the
 * WIRING note at the bottom of this file. Until that binding exists the route returns
 * a 501 with the exact reason instead of pretending there is data.
 */

/** The KV binding this route needs. `Env` (workers/api/src/types.ts) does not yet
 *  declare it, so we narrow locally rather than edit the shared type. */
type EnvWithOAuthKV = Env & { OAUTH_KV?: KVNamespace };

export const adminMcpAuditRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /mcp-audit — recent MCP tool-call events across every user, newest first.
 * Query: ?limit= (default 200, max 500) ?tool= (exact match) ?receipt= (exact id) ?user= (subject match) ?cursor=.
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
	const userFilter = c.req.query("user")?.trim() || undefined;
	const paging = parseAuditPaging(c.req.query());
	if (!paging) return c.json({ error: "cursor must be at most 2048 characters, tool at most 100 and receipt at most 200" }, 400);

	// One owner's index when filtering by user, otherwise the cross-owner index — both keyed by
	// inverted time, so either listing is newest-first and pages by KV cursor (#1016).
	const prefix = userFilter ? `${AUDIT_INDEX_PREFIX}${userFilter}:` : AUDIT_GLOBAL_PREFIX;
	return auditPageOr503(c, kv, { prefix, limit, ...paging });
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
