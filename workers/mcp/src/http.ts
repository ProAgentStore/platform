const API = "https://api.proagentstore.online";

export type McpEnv = {
	API_BASE?: string;
	AUTH_START?: string;
	GITHUB_ORG?: string;
	GITHUB_TOKEN?: string;
	MCP_READ_ONLY?: string;
	OAUTH_KV?: KVNamespace;
	SESSION_SIGNING_KEY?: string;
};

export type TextResult = { content: { type: "text"; text: string }[] };

export const text = (value: string): TextResult => ({
	content: [{ type: "text" as const, text: value }],
});

export function authRequired(): TextResult {
	return text("Error: authentication required. Connect with browser sign-in or pass a PAGS session token.");
}

export function jsonText(value: unknown): TextResult {
	return text(JSON.stringify(value, null, 2));
}

/** A result that carries BOTH the JSON text every client has always read and the parsed
 *  object beside it (#561).
 *
 *  MCP 2025-06-18 pairs `outputSchema` with `structuredContent` so a caller can take an id
 *  out of one result and put it into the next call without parsing prose — and the spec is
 *  explicit that the serialized JSON stays in a text block for backwards compatibility, so
 *  this ADDS a field rather than replacing one.
 *
 *  Only for tools that declare an `outputSchema`: the SDK REJECTS a call whose tool has a
 *  schema and returns no structured content (`validateToolOutput`, mcp.js:197), and
 *  validates what it is given against that schema. */
export function jsonResult<T>(value: T): TextResult & { structuredContent: T } {
	return { ...jsonText(value), structuredContent: value };
}

/** Prose for the human, structure for the caller — for the paths where the useful English
 *  ("no instances yet, subscribe first") is not the useful data (`{instances: []}`). */
export function structuredText(message: string, value: unknown): TextResult & { structuredContent: unknown } {
	return { ...text(message), structuredContent: value };
}

/** What `parseJsonArg` returns for a string argument that is not valid JSON. */
export const INVALID_JSON = Symbol("invalid-json");

/**
 * Coerce an object/array-shaped tool argument that arrived as a JSON *string*. Models
 * routinely send one when a schema says "object", and rejecting that outright turns a
 * working call into a retry loop — so accepting it is deliberate.
 *
 * A string that is NOT valid JSON is a different case and must never collapse to
 * `undefined`. `create_agent` used to do exactly that, so a malformed `capabilities`
 * produced an agent with no surfaces, no runtime and no tools[] allowlist — the plain chat
 * agent its own description promises you avoid — and still answered `Created: <id>` (#325).
 * Callers compare against INVALID_JSON and refuse.
 */
export function parseJsonArg(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return INVALID_JSON;
	}
}

export function apiBase(env?: McpEnv): string {
	return env?.API_BASE || API;
}

export async function apiCall(
	path: string,
	opts?: RequestInit,
	env?: McpEnv,
): Promise<unknown> {
	const res = await fetch(`${apiBase(env)}${path}`, {
		...opts,
		headers: { "Content-Type": "application/json", ...opts?.headers },
	});
	const raw = await res.text();
	let json: unknown = {};
	try {
		json = raw ? JSON.parse(raw) : {};
	} catch {
		json = { raw };
	}
	// Never let a non-2xx pass as success — always return a visible error object,
	// whatever the body shape, so a tool can't silently format a failure as a result.
	if (!res.ok) {
		return typeof json === "object" && json !== null
			? { error: `API ${res.status}`, ...json }
			: { error: `API ${res.status}`, detail: json };
	}
	return json;
}

export async function authedCall(
	path: string,
	token: string,
	opts?: RequestInit,
	env?: McpEnv,
): Promise<unknown> {
	return apiCall(path, {
		...opts,
		headers: { Authorization: `Bearer ${token}`, ...opts?.headers },
	}, env);
}
