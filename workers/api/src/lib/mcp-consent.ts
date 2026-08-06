// Per-server, per-remote-tool consent for the OUTBOUND MCP connector (#262).
//
// WHY THIS EXISTS SEPARATELY FROM `instance_connector_consent` (#90, migration 0051).
// That table grants a scope on a CONNECTOR: one row says "this instance may use `mcp`
// write tools". For every other connector that is the right granularity, because the
// connector IS the remote system — granting `github` write names GitHub. The outbound MCP
// connector is the one where it isn't: the remote system is a URL supplied by config at call
// time, so a single `mcp`/write row authorised every MCP server the instance could name and
// every tool on every one of them. Consenting to a site builder also consented to whatever
// other endpoint a later pipeline step, or an agent reading untrusted text, decided to point
// at. That is privilege escalation by configuration, which is exactly the shape #185 removed
// from supervision.
//
// So reach is named here: (instance, endpoint, tool). The connector-level row remains the
// outer gate — it is the kill switch, and revoking it stops everything at once — but on its
// own it no longer authorises a single remote call.
//
// TOOL ANNOTATIONS ARE NOT THE BOUNDARY. An MCP server publishes `readOnlyHint` /
// `destructiveHint` on its tools, and it is tempting to auto-allow the read-only ones. Those
// hints are written by the same party we are defending against: the server tells us what it
// intends to do, and a server that lies is not a hypothetical when the endpoint is user
// config. Hints may inform the UI; enforcement here reads only the owner's own grants.
//
// All queries parameterized. Fail-closed on any error. See migration 0079.
import type { Env } from "../types.js";

/** Wildcard grant: every tool on that endpoint except the destructive-looking ones. */
export const ALL_TOOLS = "*";

/**
 * Canonical identity of an MCP endpoint: scheme + host + port + path, lowercased, no
 * trailing slash. Query and fragment are DROPPED, which does two jobs at once:
 *
 *  1. Consent can't be dodged by appending a cache-buster — `…/mcp?v=2` is the same server.
 *  2. It is safe to log. MCP endpoints routinely carry an access key in the query string, so
 *     the raw URL is a credential; this is the form #265 records.
 *
 * Userinfo (`https://user:pass@host/`) is stripped for the same reason. Returns null for
 * anything that isn't an https URL — the caller must refuse rather than invent a key, or an
 * unparseable URL would collapse to one shared consent bucket.
 */
export function normalizeMcpEndpoint(raw: string): string | null {
	let u: URL;
	try {
		u = new URL(String(raw ?? "").trim());
	} catch {
		return null;
	}
	if (u.protocol !== "https:") return null;
	const path = u.pathname.replace(/\/+$/, "");
	return `${u.protocol}//${u.host.toLowerCase()}${path}`;
}

/**
 * Names that read as "this destroys something". A WILDCARD grant deliberately does not cover
 * them: "let this agent operate my site builder" should not silently include `delete_site`.
 *
 * Matching on the NAME rather than the server's `destructiveHint` is the point. The name is
 * the string WE put on the wire — the server cannot make `delete_everything` look benign by
 * annotating it, and a server that annotates a benign tool as destructive only costs its own
 * user one extra checkbox. This is the "identifiable" half of "require an additional explicit
 * confirmation when identifiable": when we can tell, we ask; a per-tool grant IS that
 * confirmation, and it is recorded rather than clicked-through and forgotten.
 *
 * A name we don't recognise is still covered by a wildcard — this narrows the blast radius of
 * a broad grant, it is not a substitute for granting per tool.
 */
const DESTRUCTIVE_WORDS = new Set([
	"delete",
	"destroy",
	"drop",
	"remove",
	"purge",
	"wipe",
	"erase",
	"revoke",
	"terminate",
	"truncate",
	"uninstall",
	"deprovision",
	"overwrite",
	"reset",
]);

/**
 * Split a tool name into words, then look for one of the verbs above. Whole WORDS, not
 * substrings: `undeleted_items` and `resetting` contain a destructive verb but are not
 * destructive, and making an ordinary tool unreachable under a wildcard buys no safety while
 * teaching the owner that the grant model is arbitrary. Both `snake_case` and `camelCase` are
 * split, because MCP servers publish both and `removeUser` must not slip through on spelling.
 */
export function isDestructiveToolName(tool: string): boolean {
	return String(tool ?? "")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[^A-Za-z0-9]+/)
		.some((word) => DESTRUCTIVE_WORDS.has(word.toLowerCase()));
}

/**
 * May `instanceId` call `tool` on `endpoint`? An exact per-tool row always wins; a wildcard
 * row covers everything except a destructive-looking name. Fail-closed: no instance, no
 * endpoint, no row, or a D1 error → false.
 */
export async function hasMcpConsent(
	env: Env,
	instanceId: string | undefined,
	endpoint: string | null,
	tool: string,
): Promise<boolean> {
	if (!instanceId || !endpoint || !tool) return false;
	try {
		const row = await env.DB.prepare(
			"SELECT tool FROM instance_mcp_consent WHERE instance_id = ?1 AND endpoint = ?2 AND tool IN (?3, ?4)",
		)
			.bind(instanceId, endpoint, tool, ALL_TOOLS)
			.all<{ tool: string }>();
		const rows = row.results ?? [];
		if (rows.some((r) => r.tool === tool)) return true;
		// Only a wildcard matched — good enough unless the name is one we can see is destructive.
		return rows.some((r) => r.tool === ALL_TOOLS) && !isDestructiveToolName(tool);
	} catch {
		return false;
	}
}

export async function setMcpConsent(env: Env, instanceId: string, userId: string, endpoint: string, tool: string): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO instance_mcp_consent (instance_id, user_id, endpoint, tool)
		 VALUES (?1, ?2, ?3, ?4)
		 ON CONFLICT(instance_id, endpoint, tool) DO NOTHING`,
	)
		.bind(instanceId, userId, endpoint, tool)
		.run();
}

export async function revokeMcpConsent(env: Env, instanceId: string, endpoint: string, tool: string): Promise<void> {
	await env.DB.prepare("DELETE FROM instance_mcp_consent WHERE instance_id = ?1 AND endpoint = ?2 AND tool = ?3")
		.bind(instanceId, endpoint, tool)
		.run();
}

export interface McpConsentRow {
	instance_id: string;
	user_id: string;
	endpoint: string;
	tool: string;
	created_at: string;
}

export async function listMcpConsents(env: Env, instanceId: string): Promise<McpConsentRow[]> {
	const res = await env.DB.prepare(
		"SELECT instance_id, user_id, endpoint, tool, created_at FROM instance_mcp_consent WHERE instance_id = ?1 ORDER BY endpoint, tool",
	)
		.bind(instanceId)
		.all<McpConsentRow>();
	return res.results ?? [];
}

/**
 * The refusal text. Written to be actionable — a denial that doesn't say which server and
 * which tool to allow gets read as "MCP is broken" and the grant never happens.
 */
export function mcpConsentDenial(endpoint: string, tool: string): string {
	const extra = isDestructiveToolName(tool)
		? ` "${tool}" looks destructive, so it needs its own approval even if you have allowed all tools on this server.`
		: "";
	return `Not permitted: this agent has no consent to call "${tool}" on ${endpoint}. Grant it under Settings → Permissions & Connections → MCP servers, then try again.${extra}`;
}
