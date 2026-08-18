import { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
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
 * The data lives in the MCP worker's `OAUTH_KV`, one key per event
 * (`audit:{subject}:{ISO time}:{uuid}`) — see the header of `admin-mcp-audit.ts` for the
 * shape and `workers/mcp/src/safety.ts` for the writer. The API worker already binds that
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
	/** KV key prefix. `audit:{subject}:` for one owner, `audit:` for the admin sweep. */
	prefix: string;
	limit: number;
	tool?: string;
	/**
	 * True when `prefix` pins exactly ONE subject. Only then does the key name order by
	 * time (`audit:{subject}:{ISO}:{uuid}` sorts by subject FIRST), which is what makes it
	 * safe to slice the names before loading. On a cross-subject sweep the newest-by-name
	 * keys are just the newest of the last subject alphabetically, so every listed key has
	 * to be loaded and ordered by its `time` field instead.
	 */
	subjectScoped?: boolean;
}

/**
 * Read events out of the audit KV, newest first.
 *
 * Over-lists to the KV per-call cap of 1000 because KV lists LEXICOGRAPHICALLY: the key
 * carries an ISO timestamp, so the first N keys are the OLDEST N. Asking KV for `limit` keys
 * and sorting those is the bug #704 fixed on the MCP side; do not reintroduce it here.
 */
export async function readMcpAuditEvents(
	kv: KVNamespace,
	{ prefix, limit, tool, subjectScoped }: McpAuditQuery,
): Promise<{ count: number; truncated: boolean; events: McpAuditEvent[] }> {
	const listed = await kv.list({ prefix, limit: 1000 });

	const names = listed.keys.map((k) => k.name).sort((a, b) => b.localeCompare(a));
	// Load only the window we will return when the names already order by time and nothing
	// filters them out: the sort needs the names, not the values, so a `limit` of 50 costs
	// 50 reads rather than up to 1000.
	const window = subjectScoped && !tool ? names.slice(0, limit) : names;

	const loaded = await Promise.all(
		window.map(async (name) => {
			const raw = await kv.get(name);
			if (!raw) return null;
			const id = name.slice(name.lastIndexOf(":") + 1);
			try {
				return { id, ...(JSON.parse(raw) as McpAuditEvent) };
			} catch {
				return { id, raw } as McpAuditEvent;
			}
		}),
	);

	let events = loaded.filter((e): e is McpAuditEvent => e !== null);
	if (tool) events = events.filter((e) => e.tool === tool);
	events.sort((a, b) => String(b.time ?? "").localeCompare(String(a.time ?? "")));
	events = events.slice(0, limit);

	// Defense-in-depth: tool input/result are untrusted — redact secret-shaped values on read
	// (the write-time redact in the MCP worker is the first net, this is the second).
	const safe = events.map((e) => ({
		...e,
		input: "input" in e ? redactSecrets(e.input, 0, { allowKeys: MCP_AUDIT_PRESERVE_KEYS }) : e.input,
		result: "result" in e ? redactSecrets(e.result, 0, { allowKeys: MCP_AUDIT_PRESERVE_KEYS }) : e.result,
	}));

	return { count: safe.length, truncated: listed.list_complete === false, events: safe };
}

export const mcpAuditRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /mcp-audit — the CALLER's own MCP tool-call events, newest first.
 * Query: ?limit= (default 100, max 200) ?tool= (exact match).
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
	const tool = c.req.query("tool")?.trim() || undefined;

	// The prefix is the caller's own uid and nothing else reaches it — no `?user=` here.
	const result = await readMcpAuditEvents(kv, {
		prefix: `audit:${session.uid}:`,
		limit,
		tool,
		subjectScoped: true,
	});
	return c.json(result);
});
