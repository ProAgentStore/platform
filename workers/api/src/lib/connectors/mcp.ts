// Outbound MCP connector — PAGS as an MCP *client*. The platform already SERVES MCP
// (workers/mcp); this is the other direction: any remote Streamable-HTTP MCP server becomes
// a tool a declarative pipeline can call, with no bespoke connector per service.
//
// Why this rather than a REST connector per service: an MCP server publishes its own tool
// schemas (`tools/list`), so there is nothing to hand-author and nothing to drift when the
// server adds a tool — the same leverage the connector MANIFEST work (#146) chased, one level
// up. A manifest describes a REST API we transcribed; this describes itself.
//
// GENERIC BY CONSTRUCTION. No server host appears anywhere in this file. The endpoint is a
// tool input (pipeline config / agent-supplied) and the credential is the caller's own vault
// entry, exactly like the `http` and `web-search` connectors. That is deliberate: PAGS is
// self-contained at runtime (no sibling-store dependency), and a hardcoded host here would
// quietly make some other store a dependency of this one. A configured server is user DATA.
//
// TRANSPORT — DUAL-ERA (#260). The MCP spec split the Streamable HTTP transport in two:
//
//   • MODERN (revision 2026-07-28+). Stateless. There is no `initialize` handshake and no
//     `Mcp-Session-Id`: every request carries its own protocol version, client info and
//     capabilities in `params._meta` under `io.modelcontextprotocol/*`, mirrored into the
//     `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` HTTP headers so intermediaries can
//     route without parsing the body. One POST per call.
//   • LEGACY (2025-03-26 … 2025-11-25). `initialize` → `notifications/initialized` → the call,
//     carrying whatever session id the handshake returned.
//
// This client speaks BOTH, modern first, because that is the era-detection procedure the spec
// specifies: attempt a modern request; on a 4xx, inspect the body. A recognised modern
// JSON-RPC error (-32020 header mismatch, -32021 missing capability, -32022 unsupported
// version) means the server IS modern and we must fix the request rather than fall back;
// anything else means legacy, and we redo the call through the handshake. The verdict is
// cached per endpoint so the probe is paid once, and dropped on any failure so a server that
// upgrades is re-probed instead of being permanently pinned to the era it had last week.
//
// Version handling is negotiation, not a constant. We advertise `SUPPORTED_VERSIONS`; a
// server answering -32022 hands back the list it supports, and we retry on the newest version
// present in both — which is also how a modern-shaped attempt legitimately lands on the legacy
// path. If the sets don't intersect the failure names both lists, instead of the "I connected
// but the tools are broken" that a single hardcoded version produced.
//
// OBSERVABILITY (#265). Every outbound call writes one redacted `agent_events` row (source
// "mcp"): endpoint, method, remote tool, era + negotiated version, HTTP status, duration and a
// failure class — plus a row for a call REFUSED before dispatch. Deliberately NOT recorded:
// argument and result VALUES. Arguments to an arbitrary remote tool are the most PII-dense
// thing this connector touches, and a log that keeps them turns an audit trail into a second
// copy of the user's data; key names and byte counts answer "did it send the field?" without
// becoming that. Everything that IS recorded goes through redactSecrets on the way out.
//
// Auth: `Authorization: Bearer <token>` from the vault (user_api_keys, provider "mcp") via
// ctx.connectorClient("mcp").token(). Used on the wire only — never in inputs, schema, or
// result. Servers fronted by OAuth 2.1 + dynamic client registration STILL cannot be reached
// headlessly this way — that flow is not implemented (#180). What changed is that a rejected
// credential now says so precisely: `discoverAuthServer` reads the server's own RFC 9728/8414
// metadata and reports which authorization server fronts it, whether it would register a client
// dynamically, and whether it issues refresh tokens at all (#181). Diagnosis, not a connection.
//
// Consent: `mcp_call_tool` is gated per (instance, endpoint, tool) — see lib/mcp-consent.ts
// and migration 0079 — on top of the connector-level write consent, because one `mcp` write
// grant used to reach every server the instance could name (#262).
//
// Every request goes through safeFetch (lib/ssrf.ts) — https-only, redirect-revalidated — so
// a pipeline-supplied endpoint can't be aimed at cloud metadata or an internal address.
import type { ToolDef, RegistryToolCtx } from "../tool-registry.js";
import type { Env } from "../../types.js";
import { safeFetch, SsrfError } from "../ssrf.js";
import { authFailureGuidance, discoverAuthServer, type DiscoveryResult } from "./discovery.js";
import { consentInstanceOf } from "../execution-authority.js";
import { hasMcpConsent, mcpConsentDenial, normalizeMcpEndpoint } from "../mcp-consent.js";
import { logEvent } from "../events.js";
import { redactSecrets, redactText } from "../redact.js";

/** The stateless, per-request-metadata era (MCP revision 2026-07-28). */
export const MODERN_VERSION = "2026-07-28";
/** The initialize/session era we prefer when a server turns out to be legacy. */
export const LEGACY_VERSION = "2025-06-18";
/**
 * Every version this client can actually speak, PREFERENCE ORDER (newest first). Advertising
 * a version we cannot produce would be worse than advertising one: a server would accept the
 * negotiation and then get a request in the wrong shape. `2026-07-28` gets the modern shape;
 * the others share the handshake shape and differ only in what the header says.
 */
export const SUPPORTED_VERSIONS = [MODERN_VERSION, "2025-11-25", LEGACY_VERSION, "2025-03-26"] as const;
/** How we identify ourselves to the remote server. */
const CLIENT_INFO = { name: "proagentstore", version: "1.0.0" };

/** JSON-RPC error codes the MCP spec reserves — seeing one PROVES the server is modern. */
const ERR_HEADER_MISMATCH = -32020;
const ERR_MISSING_CAPABILITY = -32021;
const ERR_UNSUPPORTED_VERSION = -32022;

export type McpEra = "modern" | "legacy";

interface JsonRpcResponse {
	jsonrpc?: string;
	id?: unknown;
	result?: unknown;
	error?: { code?: number; message?: string; data?: unknown };
}

/**
 * Parse a Streamable-HTTP response body into a JSON-RPC response. A server answering with
 * `application/json` sends a plain JSON object; otherwise the body is an SSE stream whose
 * `data:` frames each carry one message. We take the LAST frame that has a `result` or
 * `error` (notification/progress frames come first and carry neither).
 */
export function parseRpcBody(contentType: string, body: string): JsonRpcResponse | null {
	const isSse = contentType.includes("text/event-stream") || /^\s*(event|data):/m.test(body);
	if (!isSse) {
		try {
			const v = JSON.parse(body);
			// A batch response is an array — take the first answering message.
			if (Array.isArray(v)) return (v.find((m) => m && typeof m === "object" && ("result" in m || "error" in m)) as JsonRpcResponse) ?? null;
			return v && typeof v === "object" ? (v as JsonRpcResponse) : null;
		} catch {
			return null;
		}
	}
	let answer: JsonRpcResponse | null = null;
	for (const line of body.split(/\r?\n/)) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (!payload || payload === "[DONE]") continue;
		try {
			const msg = JSON.parse(payload) as JsonRpcResponse;
			if (msg && typeof msg === "object" && ("result" in msg || "error" in msg)) answer = msg;
		} catch {
			/* a frame we can't parse is not fatal — keep scanning */
		}
	}
	return answer;
}

/**
 * An MCP tool result is `{ content: [{type:"text", text}, …], isError? }`. Flatten the text
 * parts into one string; when that string is itself JSON (the common case — servers return
 * structured payloads as JSON text), parse it so a pipeline `$ref` can read fields off it
 * (e.g. the session id a create-style tool hands back). `structuredContent` wins when present.
 */
export function extractToolResult(result: unknown): { data: unknown; isError: boolean } {
	if (!result || typeof result !== "object") return { data: result, isError: false };
	const r = result as Record<string, unknown>;
	const isError = r.isError === true;
	if (r.structuredContent !== undefined) return { data: r.structuredContent, isError };
	const parts = Array.isArray(r.content) ? r.content : [];
	const text = parts
		.filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
		.map((p) => (typeof p.text === "string" ? p.text : ""))
		.filter(Boolean)
		.join("\n");
	if (!text) return { data: r.content ?? r, isError };
	const t = text.trim();
	if (t.startsWith("{") || t.startsWith("[")) {
		try {
			return { data: JSON.parse(t), isError };
		} catch {
			/* not JSON — return the text */
		}
	}
	return { data: text, isError };
}

// ─── Era detection cache ────────────────────────────────────────────────────────────────
//
// The spec says the era is a property of the SERVER, not of a request, and that a client
// should cache it per origin and re-probe if the assumption later fails. This is that cache:
// an in-isolate Map, so it lives exactly as long as the Worker isolate does. It holds no
// credential and nothing user-identifying — only "this URL speaks era X" — which is why it can
// be shared across users of the same isolate without leaking anything between them.

interface EraEntry {
	era: McpEra;
	/** The version to send. For "legacy" this is what we WILL offer at initialize. */
	version: string;
	expires: number;
}

const ERA_TTL_MS = 10 * 60_000;
const ERA_CACHE_MAX = 200;
const ERA_CACHE = new Map<string, EraEntry>();

export function recallEra(key: string): EraEntry | null {
	const hit = ERA_CACHE.get(key);
	if (!hit) return null;
	if (hit.expires < Date.now()) {
		ERA_CACHE.delete(key);
		return null;
	}
	return hit;
}

export function rememberEra(key: string, era: McpEra, version: string): void {
	// Bounded: a pipeline that walks many endpoints must not grow this without limit. Wholesale
	// clear rather than LRU bookkeeping — the entry is a cheap probe, losing it costs one 4xx.
	if (ERA_CACHE.size >= ERA_CACHE_MAX) ERA_CACHE.clear();
	ERA_CACHE.set(key, { era, version, expires: Date.now() + ERA_TTL_MS });
}

/** Drop a cached verdict so the next call re-probes. Called on EVERY failure. */
export function forgetEra(key: string): void {
	ERA_CACHE.delete(key);
}

/** Test seam — the cache is module state, so a test that pins an era must be able to undo it. */
export function resetEraCache(): void {
	ERA_CACHE.clear();
}

/**
 * Pick the newest version present in both lists. `ours` is in preference order, so the first
 * match is the best mutually supported version. Returns null when the sets are disjoint —
 * which is a real outcome (a server newer than us) and must be reported, not papered over.
 */
export function negotiateVersion(supported: unknown, ours: readonly string[] = SUPPORTED_VERSIONS): string | null {
	const list = Array.isArray(supported) ? supported.filter((v): v is string => typeof v === "string") : [];
	return ours.find((v) => list.includes(v)) ?? null;
}

/** Which era a negotiated version implies. Everything before 2026-07-28 uses the handshake. */
export function eraForVersion(version: string): McpEra {
	return version === MODERN_VERSION ? "modern" : "legacy";
}

/**
 * Classify a 4xx from a modern-shaped attempt. The distinction that matters: a recognised MCP
 * error code proves the server understood a modern request and is objecting to its CONTENT, so
 * falling back to `initialize` would be wrong (we'd downgrade a modern server on a fixable
 * complaint). Anything else — an empty body, an HTML error page, a bare 404/405 — is the
 * signature of a server that has never heard of the modern shape.
 */
export function classifyModernFailure(status: number, res: JsonRpcResponse | null): "unsupported_version" | "header_mismatch" | "missing_capability" | "modern_other" | "legacy" | null {
	if (status < 400) return null;
	const code = res?.error?.code;
	if (code === ERR_UNSUPPORTED_VERSION) return "unsupported_version";
	if (code === ERR_HEADER_MISMATCH) return "header_mismatch";
	if (code === ERR_MISSING_CAPABILITY) return "missing_capability";
	// -32601 on a 404 is a modern server saying "no such method" — still modern.
	if (status === 404 && code === -32601) return "modern_other";
	if (status === 400 || status === 404 || status === 405) return "legacy";
	return null;
}

/**
 * Encode a value for an HTTP header per the spec's Base64 sentinel rule. A remote tool name is
 * only SHOULD-constrained to header-safe characters, so a server is free to publish one with a
 * space or a non-ASCII character in it; putting that raw into `Mcp-Name` is a header-injection
 * primitive as well as a protocol violation.
 */
export function encodeHeaderValue(v: string): string {
	const s = String(v ?? "");
	const safe = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(s);
	const looksLikeSentinel = s.startsWith("=?base64?") && s.endsWith("?=");
	if (safe && !looksLikeSentinel) return s;
	const bytes = new TextEncoder().encode(s);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return `=?base64?${btoa(bin)}?=`;
}

/** The `Mcp-Name` source field: `params.name` for tools/prompts, `params.uri` for resources. */
export function mcpNameFor(method: string, params: Record<string, unknown>): string | null {
	if (method === "tools/call" || method === "prompts/get") return typeof params.name === "string" ? params.name : null;
	if (method === "resources/read") return typeof params.uri === "string" ? params.uri : null;
	return null;
}

/** Params for a modern request: the caller's params plus the required `_meta` block. */
export function withRequestMeta(params: Record<string, unknown>, version: string): Record<string, unknown> {
	const existing = params._meta && typeof params._meta === "object" && !Array.isArray(params._meta) ? (params._meta as Record<string, unknown>) : {};
	return {
		...params,
		_meta: {
			...existing,
			"io.modelcontextprotocol/protocolVersion": version,
			"io.modelcontextprotocol/clientInfo": CLIENT_INFO,
			"io.modelcontextprotocol/clientCapabilities": {},
		},
	};
}

/** Read the endpoint + auth mode shared by both tools. */
function readEndpoint(input: Record<string, unknown>): { url: string; useAuth: boolean } {
	const url = String(input.url ?? "").trim();
	if (!url) throw new Error("`url` is required — the MCP server endpoint (e.g. https://example.com/mcp).");
	if (!/^https:\/\//i.test(url)) throw new Error("MCP endpoint must be https.");
	return { url, useAuth: input.auth !== "none" };
}

interface RpcCall {
	url: string;
	token: string | null;
	method: string;
	params: Record<string, unknown>;
	id: number;
	version: string;
	era: McpEra;
	sessionId?: string | null;
	/** Notifications get no response body worth parsing; the caller only needs it not to throw. */
	notification?: boolean;
}

interface RpcOutcome {
	res: JsonRpcResponse | null;
	status: number;
	sessionId: string | null;
	rawBody: string;
}

/** One JSON-RPC POST. Returns the parsed response plus any session id the server assigned. */
async function rpc(call: RpcCall): Promise<RpcOutcome> {
	const headers = new Headers({
		"Content-Type": "application/json",
		// Both are advertised: a server may answer either way, and one that streams will
		// reject a request that doesn't accept text/event-stream.
		Accept: "application/json, text/event-stream",
		"MCP-Protocol-Version": call.version,
	});
	if (call.token) headers.set("Authorization", `Bearer ${call.token}`);

	let params = call.params;
	if (call.era === "modern") {
		// The mirrored headers are REQUIRED on a modern POST, and their values must match the
		// body exactly — a server that validates one against the other rejects a mismatch with
		// -32020, so these are derived from `params`, never passed in alongside it.
		params = withRequestMeta(params, call.version);
		headers.set("Mcp-Method", call.method);
		const name = mcpNameFor(call.method, params);
		if (name !== null) headers.set("Mcp-Name", encodeHeaderValue(name));
	} else if (call.sessionId) {
		headers.set("Mcp-Session-Id", call.sessionId);
	}

	const body = call.notification
		? { jsonrpc: "2.0", method: call.method, params }
		: { jsonrpc: "2.0", id: call.id, method: call.method, params };

	const res = await safeFetch(call.url, { method: "POST", headers, body: JSON.stringify(body) });
	const rawBody = await res.text();
	return {
		res: parseRpcBody(res.headers.get("Content-Type") ?? "", rawBody),
		status: res.status,
		sessionId: res.headers.get("Mcp-Session-Id"),
		rawBody,
	};
}

// ─── Observability (#265) ───────────────────────────────────────────────────────────────

export type McpFailureClass =
	| "bad_input"
	| "no_credential"
	| "denied"
	| "auth"
	| "unsupported_version"
	| "header_mismatch"
	| "missing_capability"
	| "rpc_error"
	| "tool_error"
	| "unparseable"
	| "blocked"
	| "network";

interface McpEventFields {
	event: "mcp.call" | "mcp.denied";
	level: "info" | "warn";
	endpoint: string;
	method: string;
	tool?: string;
	era?: McpEra;
	protocolVersion?: string;
	status?: number;
	durationMs?: number;
	ok: boolean;
	failure?: McpFailureClass;
	reason?: string;
	/** Argument KEY NAMES only — see the header note on why values are never recorded. */
	argKeys?: string[];
	argBytes?: number;
	resultBytes?: number;
}

/**
 * Write one trace row for an outbound call. Best-effort and never throws: instrumentation must
 * not be able to fail the call it observes. `redactSecrets` runs over the whole context as a
 * second net — nothing here is supposed to carry a credential, and that is exactly the kind of
 * assumption that rots, so it is enforced rather than trusted.
 */
async function recordMcp(ctx: RegistryToolCtx, f: McpEventFields): Promise<void> {
	const env = ctx.env as Env | undefined;
	if (!env?.DB) return; // no binding (unit tests, isolated handlers) — nothing to write to.
	const summary = `${f.method}${f.tool ? ` ${f.tool}` : ""} → ${f.endpoint} ${f.ok ? "ok" : (f.failure ?? "failed")}`;
	await logEvent(env, {
		source: "mcp",
		event: f.event,
		message: redactText(summary).slice(0, 300),
		level: f.level,
		userId: ctx.userId ?? null,
		instanceId: ctx.instanceId ?? null,
		traceId: ctx.traceId ?? null,
		context: redactSecrets({
			endpoint: f.endpoint,
			method: f.method,
			tool: f.tool,
			era: f.era,
			protocolVersion: f.protocolVersion,
			status: f.status,
			durationMs: f.durationMs,
			ok: f.ok,
			failure: f.failure,
			reason: f.reason,
			argKeys: f.argKeys,
			argBytes: f.argBytes,
			resultBytes: f.resultBytes,
		}) as Record<string, unknown>,
	}).catch(() => undefined);
}

// ─── The call ───────────────────────────────────────────────────────────────────────────

interface CallOutcome {
	content: string;
	success: boolean;
	failure?: McpFailureClass;
	status?: number;
	era?: McpEra;
	version?: string;
	/**
	 * What the server's own OAuth metadata said, when we had to ask (#180/#181). Carried
	 * STRUCTURALLY rather than only rendered into `content`, so the connection-test surface can
	 * show "OAuth-protected by X, no refresh token" as fields instead of re-parsing a sentence.
	 */
	discovery?: DiscoveryResult;
}

/** Shared 401/403 handling: ask the server what auth model it wants instead of guessing (#180). */
async function authFailure(url: string, status: number): Promise<CallOutcome> {
	const discovery = await discoverAuthServer(url).catch(() => ({ protected: false }) as DiscoveryResult);
	return { content: authFailureGuidance(status, discovery), success: false, failure: "auth", status, discovery };
}

/** Turn a completed RPC into a CallOutcome. Body excerpts are redacted — a server that echoes
 *  our Authorization header into its error page must not put it in the transcript or the log. */
function finish(out: RpcOutcome, era: McpEra, version: string): CallOutcome {
	if (!out.res) {
		return {
			content: `MCP server returned an unparseable response (HTTP ${out.status}): ${redactText(out.rawBody).slice(0, 300)}`,
			success: false,
			failure: "unparseable",
			status: out.status,
			era,
			version,
		};
	}
	if (out.res.error) {
		return { content: `MCP error: ${redactText(out.res.error.message ?? "unknown error")}`, success: false, failure: "rpc_error", status: out.status, era, version };
	}
	return { content: JSON.stringify(out.res.result ?? null, null, 2), success: true, status: out.status, era, version };
}

/** LEGACY era: initialize → initialized → the real call, carrying the session id. */
async function legacyCall(url: string, token: string | null, method: string, params: Record<string, unknown>, version: string): Promise<CallOutcome> {
	const init = await rpc({ url, token, method: "initialize", id: 1, era: "legacy", version, params: { protocolVersion: version, capabilities: {}, clientInfo: CLIENT_INFO } });
	if (init.status === 401 || init.status === 403) return authFailure(url, init.status);
	if (init.res?.error) {
		return { content: `MCP initialize failed: ${redactText(init.res.error.message ?? "unknown error")}`, success: false, failure: "rpc_error", status: init.status, era: "legacy", version };
	}

	// Use the version the server NEGOTIATED, not the one we offered. The spec says the header on
	// subsequent requests should carry the negotiated version; sending our preference regardless
	// is how a server that downgraded us ends up rejecting every follow-up as unsupported.
	const negotiated = typeof (init.res?.result as Record<string, unknown> | undefined)?.protocolVersion === "string" ? String((init.res?.result as Record<string, unknown>).protocolVersion) : version;

	// The handshake is not complete until the client says so. Fire-and-forget: a server that
	// 400s the notification still answers the call, and failing here would strand a working
	// server on a formality.
	await rpc({ url, token, method: "notifications/initialized", id: 0, era: "legacy", version: negotiated, params: {}, sessionId: init.sessionId, notification: true }).catch(() => undefined);

	const out = await rpc({ url, token, method, params, id: 2, era: "legacy", version: negotiated, sessionId: init.sessionId });
	if (out.status === 401 || out.status === 403) return authFailure(url, out.status);
	return finish(out, "legacy", negotiated);
}

/**
 * MODERN era: one POST, metadata in the body and mirrored into headers. Returns a CallOutcome,
 * or `{ fallback: version }` when the server proved to be legacy (or negotiated us down to a
 * handshake version), which the caller redoes through `legacyCall`.
 */
async function modernCall(url: string, token: string | null, method: string, params: Record<string, unknown>, version: string, attempt = 0): Promise<CallOutcome | { fallback: string }> {
	const out = await rpc({ url, token, method, params, id: 1, era: "modern", version });
	if (out.status === 401 || out.status === 403) return authFailure(url, out.status);

	const verdict = classifyModernFailure(out.status, out.res);
	if (verdict === "legacy") return { fallback: LEGACY_VERSION };
	if (verdict === "unsupported_version") {
		const data = (out.res?.error?.data ?? {}) as Record<string, unknown>;
		const chosen = negotiateVersion(data.supported);
		// A server that answers -32022 again for the version it just told us it supports would
		// otherwise spin here. One retry is negotiation; a second is a broken server.
		if (!chosen || chosen === version || attempt >= 1) {
			const theirs = Array.isArray(data.supported) ? data.supported.join(", ") : "(not stated)";
			return {
				content: `This MCP server supports no protocol version this client speaks. It supports: ${theirs}. This client speaks: ${SUPPORTED_VERSIONS.join(", ")}.`,
				success: false,
				failure: "unsupported_version",
				status: out.status,
				era: "modern",
				version,
			};
		}
		// A server can legitimately push us onto the handshake era, or onto a different modern
		// version. Both are "retry with what we agreed", not "give up".
		if (eraForVersion(chosen) === "legacy") return { fallback: chosen };
		return modernCall(url, token, method, params, chosen, attempt + 1);
	}
	if (verdict === "header_mismatch" || verdict === "missing_capability") {
		return {
			content: `The MCP server rejected this client's request metadata (${verdict === "header_mismatch" ? "header/body mismatch" : "a required client capability is missing"}): ${redactText(out.res?.error?.message ?? "no detail")}. This is a client bug, not a credential problem — report it with the endpoint and tool name.`,
			success: false,
			failure: verdict === "header_mismatch" ? "header_mismatch" : "missing_capability",
			status: out.status,
			era: "modern",
			version,
		};
	}
	return finish(out, "modern", version);
}

/**
 * Run one MCP method against a server, choosing the era. Modern is attempted first unless the
 * endpoint is already known to be legacy; the verdict is cached, and dropped on any failure so
 * the next attempt re-probes.
 */
async function mcpCall(
	ctx: RegistryToolCtx,
	input: Record<string, unknown>,
	method: string,
	params: Record<string, unknown>,
	log: { tool?: string; argKeys?: string[]; argBytes?: number },
): Promise<CallOutcome & { durationMs: number }> {
	const started = Date.now();
	let endpoint: { url: string; useAuth: boolean };
	try {
		endpoint = readEndpoint(input);
	} catch (e) {
		const content = e instanceof Error ? e.message : String(e);
		await recordMcp(ctx, { event: "mcp.call", level: "warn", endpoint: String(input.url ?? "(none)").slice(0, 120), method, tool: log.tool, ok: false, failure: "bad_input", reason: content });
		return { content, success: false, failure: "bad_input", durationMs: Date.now() - started };
	}
	const key = normalizeMcpEndpoint(endpoint.url) ?? endpoint.url;

	let token: string | null = null;
	if (endpoint.useAuth) {
		token = (await ctx.connectorClient?.("mcp").token().catch(() => null)) ?? null;
		if (!token) {
			const content =
				'No credential connected for the mcp connector — add the server\'s access token in the instance\'s Connections settings, or pass auth:"none" for an open server.';
			await recordMcp(ctx, { event: "mcp.call", level: "warn", endpoint: key, method, tool: log.tool, ok: false, failure: "no_credential" });
			return { content, success: false, failure: "no_credential", durationMs: Date.now() - started };
		}
	}

	let outcome: CallOutcome;
	try {
		const cached = recallEra(key);
		if (cached?.era === "legacy") {
			outcome = await legacyCall(endpoint.url, token, method, params, cached.version);
		} else {
			const modern = await modernCall(endpoint.url, token, method, params, cached?.version ?? MODERN_VERSION);
			if ("fallback" in modern) {
				rememberEra(key, "legacy", modern.fallback);
				outcome = await legacyCall(endpoint.url, token, method, params, modern.fallback);
			} else {
				outcome = modern;
			}
		}
	} catch (e) {
		outcome =
			e instanceof SsrfError
				? { content: `Blocked: ${e.message}`, success: false, failure: "blocked" }
				: { content: `MCP request failed: ${e instanceof Error ? redactText(e.message) : String(e)}`, success: false, failure: "network" };
	}

	// Cache the verdict only on success; drop it on ANY failure so a server that changes era —
	// or was misclassified by a transient 400 — is re-probed rather than pinned.
	if (outcome.success && outcome.era && outcome.version) rememberEra(key, outcome.era, outcome.version);
	else if (!outcome.success) forgetEra(key);

	const durationMs = Date.now() - started;
	await recordMcp(ctx, {
		event: "mcp.call",
		level: outcome.success ? "info" : "warn",
		endpoint: key,
		method,
		tool: log.tool,
		era: outcome.era,
		protocolVersion: outcome.version,
		status: outcome.status,
		durationMs,
		ok: outcome.success,
		failure: outcome.failure,
		argKeys: log.argKeys,
		argBytes: log.argBytes,
		resultBytes: outcome.success ? outcome.content.length : undefined,
	});
	return { ...outcome, durationMs };
}

/** What a connection probe learned about the transport. Consent/gate reasoning lives elsewhere. */
export interface McpProbeOutcome extends CallOutcome {
	/** The normalized endpoint — the form consent and the trace log key on. */
	endpoint: string;
	durationMs: number;
}

/**
 * Run `tools/list` against an endpoint and report precisely what happened (#265/#266).
 *
 * This is the SAME path a real call takes — `mcpCall`, therefore `safeFetch`, therefore
 * https-only and SSRF-guarded, therefore era detection and the redacted `agent_events` row.
 * A "test this connection" button is a textbook SSRF primitive precisely because the endpoint
 * is user-supplied config, so it deliberately gets no shortcut of its own: there is one way out
 * of this Worker to an MCP server, and the test uses it.
 *
 * `tools/list` and not a synthetic ping: it is read-scoped and needs no consent, so a test can
 * enumerate a server before anything has been granted — which is what makes per-tool consent
 * (#262) approachable — and it proves the protocol negotiation end to end rather than only that
 * a socket opened.
 */
export async function probeMcpEndpoint(ctx: RegistryToolCtx, url: string, useAuth: boolean): Promise<McpProbeOutcome> {
	const out = (await mcpCall(ctx, { url, auth: useAuth ? "vault" : "none" }, "tools/list", {}, {})) as CallOutcome & { durationMs?: number };
	return { ...out, endpoint: normalizeMcpEndpoint(url) ?? url, durationMs: out.durationMs ?? 0 };
}

export const MCP_TOOLS: ToolDef[] = [
	{
		name: "mcp_list_tools",
		tier: "connector",
		connector: "mcp",
		scope: "read",
		description:
			"Discover what a remote MCP server can do. Calls `tools/list` on the given Streamable-HTTP MCP endpoint and returns each tool's name, description, and input schema. Use this before mcp_call_tool when you don't already know the server's tool names — the server is the source of truth, not a hardcoded list.",
		jsonSchema: {
			type: "object",
			properties: {
				url: { type: "string", description: "MCP server endpoint, e.g. https://example.com/mcp (https only)." },
				auth: { type: "string", description: 'Set to "none" for a server that needs no credential. Default: send the vault-stored bearer token.' },
			},
			required: ["url"],
		},
		handler: async (ctx, input) => {
			const r = await mcpCall(ctx, input, "tools/list", {}, {});
			return { content: r.content, success: r.success };
		},
	},
	{
		name: "mcp_call_tool",
		tier: "connector",
		connector: "mcp",
		// write: an MCP tool call can mutate the remote system, so it goes through the same
		// per-instance write-consent gate (#90) every other mutating connector tool does — and,
		// since #262, a second gate naming the exact server and tool.
		scope: "write",
		description:
			"Call one tool on a remote MCP server (`tools/call`) and return its result. `args` is the tool's own input object — check mcp_list_tools for the schema. The result's text content is parsed as JSON when it is JSON, so a later pipeline step can $ref fields off it (e.g. an id returned by a create-style tool). Returns the tool result; a tool that reports failure comes back unsuccessful. The owner must have granted this agent access to that specific server and tool.",
		jsonSchema: {
			type: "object",
			properties: {
				url: { type: "string", description: "MCP server endpoint, e.g. https://example.com/mcp (https only)." },
				tool: { type: "string", description: "Name of the tool to call on that server." },
				args: { type: "object", description: "Arguments for the tool, matching its published input schema." },
				auth: { type: "string", description: 'Set to "none" for a server that needs no credential. Default: send the vault-stored bearer token.' },
			},
			required: ["url", "tool"],
		},
		handler: async (ctx, input) => {
			const tool = String(input.tool ?? "").trim();
			if (!tool) return { content: "`tool` is required — the name of the tool to call on the server.", success: false };
			const args = input.args && typeof input.args === "object" && !Array.isArray(input.args) ? (input.args as Record<string, unknown>) : {};
			const argKeys = Object.keys(args).slice(0, 40);
			const argBytes = JSON.stringify(args).length;

			// #262 — consent BEFORE anything else touches the network or the vault. Resolved
			// against the EXECUTOR via consentInstanceOf (#185): a supervisor delegating work must
			// not lend its own MCP grants downward, which is the whole reason that helper exists.
			const authority = consentInstanceOf({ instanceId: ctx.instanceId ?? "", userId: ctx.userId ?? "", onBehalfOf: ctx.onBehalfOf });
			const endpointKey = normalizeMcpEndpoint(String(input.url ?? ""));
			if (!endpointKey) {
				return { content: "`url` must be an https MCP endpoint, e.g. https://example.com/mcp.", success: false };
			}
			if (!(await hasMcpConsent(ctx.env, authority || undefined, endpointKey, tool))) {
				const denial = mcpConsentDenial(endpointKey, tool);
				await recordMcp(ctx, { event: "mcp.denied", level: "warn", endpoint: endpointKey, method: "tools/call", tool, ok: false, failure: "denied", reason: "no per-endpoint/per-tool consent", argKeys, argBytes });
				return { content: denial, success: false };
			}

			const out = await mcpCall(ctx, input, "tools/call", { name: tool, arguments: args }, { tool, argKeys, argBytes });
			if (!out.success) return { content: out.content, success: false };

			// Unwrap the MCP result envelope so pipelines chain off the payload, not the
			// protocol shape. `isError` is the server saying the TOOL failed while the RPC
			// itself succeeded — surface that as an unsuccessful step rather than a quiet pass.
			let parsed: unknown = null;
			try {
				parsed = JSON.parse(out.content);
			} catch {
				/* handled below */
			}
			const { data, isError } = extractToolResult(parsed);
			if (isError) {
				await recordMcp(ctx, { event: "mcp.call", level: "warn", endpoint: endpointKey, method: "tools/call", tool, era: out.era, protocolVersion: out.version, status: out.status, ok: false, failure: "tool_error", argKeys, argBytes });
			}
			return {
				content: JSON.stringify({ tool, ok: !isError, data }, null, 2),
				success: !isError,
			};
		},
	},
];
