import { type Context, Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { AUDIT_INDEX_PREFIX, type AuditPage, readAuditPage } from "../lib/mcp-audit-ledger.js";
import { redactSecrets } from "../lib/redact.js";
import type { Env } from "../types.js";

/**
 * Owner-scoped MCP tool-call audit log — `GET /v1/mcp-audit` (#704).
 *
 * Before this route the audit trail was readable only through `mcp_audit_log`, i.e. through
 * the surface it audits: when the MCP connection is the thing that broke, the record of what
 * the MCP client did was unreachable. `GET /v1/admin/mcp-audit` exists but is `requireAdmin`
 * and cross-user, so it is not an answer for a normal owner.
 *
 * The data lives in the MCP worker's `OAUTH_KV`, in the time-ordered ledger
 * `lib/mcp-audit-ledger.ts` describes (#1016) — `workers/mcp/src/safety.ts` is the writer. The API worker already binds that
 * namespace (`wrangler.toml`) and `Env.OAUTH_KV` is already declared.
 *
 * Tenant isolation is structural: the KV prefix is built from `session.uid` and there is no
 * query parameter that can widen it. A caller cannot name another subject.
 */

/** The KV binding this route needs. Declared optional on `Env`, so narrow before use. */
type EnvWithOAuthKV = Env & { OAUTH_KV?: KVNamespace };

export interface McpAuditEvent {
	/** The KV key's trailing uuid. Stable per event, which nothing else in the payload is —
	 *  `time` + `tool` collide freely when a client makes several calls in one millisecond. */
	id?: string;
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

/**
 * `session_id` is an opaque handle (`csess_6ce3627a-…`), not a credential — and it is the
 * ONLY join key from an audited MCP call back to the `coding_timeline` rows that hold what
 * was actually typed into the engine. The MCP worker's write-time `redact()` deliberately
 * keeps it; the read-time `SECRET_KEY` pattern matches `session[_-]?(id|token)` and was
 * destroying it, so the two surfaces disagreed about the same stored bytes and the one HTTP
 * path to MCP history removed the field that makes the history usable (#704).
 *
 * Exempted HERE rather than by narrowing the shared pattern: `redactSecrets` has three other
 * consumers, and a `Mcp-Session-Id` from a stateful remote MCP server IS effectively a
 * capability (`lib/connectors/mcp.ts` echoes one). `session_token` stays redacted, and the
 * value-shape net still runs over the exempted field.
 */
export const MCP_AUDIT_PRESERVE_KEYS = /^session[_-]?id$/i;

export interface McpAuditQuery {
	/** Ledger key prefix: `audit_idx:{subject}:` for one owner, `audit_all:` for the admin sweep. */
	prefix: string;
	limit: number;
	/** The previous page's `nextCursor`. */
	cursor?: string;
	tool?: string;
	/** Exact receipt id — see `carriesReceipt`. */
	receipt?: string;
}

/**
 * One page of the audit ledger, newest first, redacted again on read (#1016).
 *
 * The ledger is keyed by INVERTED time (`lib/mcp-audit-ledger.ts`), so KV's lexicographic order is
 * newest-first and its list cursor is the continuation. A storage failure throws; the routes turn
 * it into a 503, never into a short page that looks like the whole history.
 */
export async function readMcpAuditEvents(kv: KVNamespace, query: McpAuditQuery): Promise<AuditPage<McpAuditEvent>> {
	const page = await readAuditPage(kv, query);
	// Defense-in-depth: tool input/result are untrusted — redact secret-shaped values on read
	// (the write-time redact in the MCP worker is the first net, this is the second).
	const events = (page.events as McpAuditEvent[]).map((e) => ({
		...e,
		input: "input" in e ? redactSecrets(e.input, 0, { allowKeys: MCP_AUDIT_PRESERVE_KEYS }) : e.input,
		result: "result" in e ? redactSecrets(e.result, 0, { allowKeys: MCP_AUDIT_PRESERVE_KEYS }) : e.result,
	}));
	return { ...page, events };
}

/** Parse the shared `?cursor=` / `?tool=` / `?receipt=` query; `null` when any is out of bounds. */
export function parseAuditPaging(query: { cursor?: string; tool?: string; receipt?: string }): { cursor?: string; tool?: string; receipt?: string } | null {
	const cursor = query.cursor?.trim() || undefined;
	const tool = query.tool?.trim() || undefined;
	const receipt = query.receipt?.trim() || undefined;
	if ((cursor && cursor.length > 2048) || (tool && tool.length > 100) || (receipt && receipt.length > 200)) return null;
	return { cursor, tool, receipt };
}

/** Read a page, or answer 503 naming the failure — a failed read is never an empty history. */
export async function auditPageOr503(c: Context, kv: KVNamespace, query: McpAuditQuery) {
	try {
		return c.json(await readMcpAuditEvents(kv, query));
	} catch (e) {
		return c.json(
			{ error: "MCP audit ledger read failed", detail: e instanceof Error ? e.message : String(e), events: null },
			503,
		);
	}
}

export const mcpAuditRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /mcp-audit — the CALLER's own MCP tool-call events, newest first.
 * Query: ?limit= (default 100, max 200) ?tool= (exact match) ?receipt= (exact event/run/queue/session id)
 * ?cursor= (a previous `nextCursor`).
 */
mcpAuditRoutes.get("/mcp-audit", async (c) => {
	const session = await requireUser(c);

	const kv = (c.env as EnvWithOAuthKV).OAUTH_KV;
	if (!kv) {
		return c.json(
			{
				error: "OAUTH_KV not bound",
				detail:
					"MCP audit events live in the MCP worker's OAUTH_KV namespace, not in D1. " +
					"Bind it on the API worker to enable this view.",
			},
			501,
		);
	}

	const limit = Math.max(1, Math.min(200, Number(c.req.query("limit")) || 100));
	const paging = parseAuditPaging(c.req.query());
	if (!paging) return c.json({ error: "cursor must be at most 2048 characters, tool at most 100 and receipt at most 200" }, 400);

	// The prefix is the caller's own uid and nothing else reaches it — no `?user=` here, and a
	// cursor only moves WITHIN the prefix it is listed under.
	return auditPageOr503(c, kv, { prefix: `${AUDIT_INDEX_PREFIX}${session.uid}:`, limit, ...paging });
});
