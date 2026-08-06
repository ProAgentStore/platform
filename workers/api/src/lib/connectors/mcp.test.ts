import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRegistryTool } from "../tool-registry.js";
import type { RegistryToolCtx } from "../tool-registry.js";
import type { ConnectorClient } from "./client.js";
import { ALL_TOOLS } from "../mcp-consent.js";
import {
	classifyModernFailure,
	encodeHeaderValue,
	eraForVersion,
	extractToolResult,
	LEGACY_VERSION,
	mcpNameFor,
	MODERN_VERSION,
	negotiateVersion,
	parseRpcBody,
	resetEraCache,
	SUPPORTED_VERSIONS,
	withRequestMeta,
} from "./mcp.js";

// Both tools resolved from the REGISTRY (proves they're wired, so a pipeline step / the
// runtime / POST …/tools/<name> can reach them with no bespoke route).
const listTools = getRegistryTool("mcp_list_tools")!;
const callTool = getRegistryTool("mcp_call_tool")!;

interface LoggedEvent {
	source: string;
	event: string;
	message: string | null;
	level: string;
	context: Record<string, unknown>;
}

/**
 * A ctx whose vault hands back a token and whose D1 answers the #262 consent lookup and
 * captures the #265 trace rows. Both live on the same stub because the handler touches both in
 * one call and a test needs to assert on the pair (denied → logged, allowed → logged).
 */
function makeCtx(opts: { token?: string | null; grants?: string[]; instanceId?: string } = {}) {
	const token = opts.token === undefined ? "tok-abc" : opts.token;
	const grants = opts.grants ?? [ALL_TOOLS];
	const events: LoggedEvent[] = [];

	const DB = {
		prepare: (sql: string) => ({
			bind: (...args: unknown[]) => ({
				all: async () => {
					if (sql.includes("instance_mcp_consent")) {
						const [, , tool, wildcard] = args as string[];
						return { results: grants.filter((g) => g === tool || g === wildcard).map((g) => ({ tool: g })) };
					}
					return { results: [] };
				},
				first: async () => null,
				run: async () => {
					if (sql.includes("INSERT INTO agent_events")) {
						const [, , , , , source, level, event, message, context] = args as string[];
						events.push({ source, level, event, message, context: context ? JSON.parse(context) : {} });
					}
					return { success: true };
				},
			}),
			run: async () => ({ success: true }),
		}),
	};

	const ctx = {
		env: { DB } as never,
		userId: "user-1",
		instanceId: opts.instanceId ?? "inst-1",
		connectorClient: () =>
			({
				token: async () => {
					if (!token) throw new Error("no key");
					return token;
				},
			}) as unknown as ConnectorClient,
	} as unknown as RegistryToolCtx;

	return { ctx, events };
}

interface ScriptEntry {
	status?: number;
	contentType?: string;
	body: unknown;
}

/**
 * Mock the network with a per-JSON-RPC-method script. Records every request so the tests can
 * assert on the era, headers, `_meta`, and the params actually put on the wire. `once` lets a
 * script answer the FIRST attempt at a method differently from the retry, which is how the
 * era-detection and version-negotiation paths are exercised.
 */
function mockRpc(script: Record<string, ScriptEntry | ScriptEntry[]>, opts: { sessionId?: string } = {}) {
	const calls: Array<{ url: string; headers: Headers; body: any }> = [];
	const seen = new Map<string, number>();
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init: any) => {
		const parsedBody = JSON.parse(String(init?.body ?? "{}"));
		calls.push({ url: String(url), headers: new Headers(init?.headers), body: parsedBody });
		const method = parsedBody.method;
		const spec = script[method] ?? { body: { jsonrpc: "2.0", id: parsedBody.id, result: {} } };
		let entry: ScriptEntry;
		if (Array.isArray(spec)) {
			const n = seen.get(method) ?? 0;
			seen.set(method, n + 1);
			entry = spec[Math.min(n, spec.length - 1)];
		} else {
			entry = spec;
		}
		const headers: Record<string, string> = { "Content-Type": entry.contentType ?? "application/json" };
		if (opts.sessionId && method === "initialize") headers["Mcp-Session-Id"] = opts.sessionId;
		return new Response(typeof entry.body === "string" ? entry.body : JSON.stringify(entry.body), {
			status: entry.status ?? 200,
			headers,
		});
	});
	return calls;
}

/** An MCP tools/call result whose text content is a JSON payload (the common server shape). */
function textResult(payload: unknown, isError = false) {
	return { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) } };
}

const OK_INIT = { body: { jsonrpc: "2.0", id: 1, result: { protocolVersion: LEGACY_VERSION, capabilities: {}, serverInfo: { name: "s", version: "1" } } } };

/** What a pre-2026-07-28 server does with a modern POST: a 4xx with nothing modern in it. */
const LEGACY_REJECTS_MODERN: ScriptEntry = { status: 400, contentType: "text/html", body: "<html>Bad Request</html>" };

/** A modern server's -32022, listing what it does support. */
function unsupportedVersion(supported: string[]): ScriptEntry {
	return { status: 400, body: { jsonrpc: "2.0", id: 1, error: { code: -32022, message: "Unsupported protocol version", data: { supported, requested: MODERN_VERSION } } } };
}

// The era verdict is cached in module state, so one test's server must not decide the next
// test's transport.
beforeEach(() => resetEraCache());
afterEach(() => vi.restoreAllMocks());

describe("parseRpcBody — both Streamable-HTTP response shapes", () => {
	it("parses a plain JSON response (application/json servers)", () => {
		expect(parseRpcBody("application/json", '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')).toEqual({
			jsonrpc: "2.0",
			id: 1,
			result: { ok: true },
		});
	});

	it("parses an SSE-framed response, taking the frame that answers", () => {
		const sse = ["event: message", 'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}', "", "event: message", 'data: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}', ""].join("\n");
		expect(parseRpcBody("text/event-stream", sse)?.result).toEqual({ ok: true });
	});

	it("detects SSE framing even when the content-type is wrong", () => {
		// Some servers mislabel the stream; the body shape is the reliable signal.
		expect(parseRpcBody("application/json", 'data: {"jsonrpc":"2.0","id":1,"result":{"ok":1}}')?.result).toEqual({ ok: 1 });
	});

	it("skips unparseable frames rather than failing the whole response", () => {
		const sse = ["data: not-json", 'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}'].join("\n");
		expect(parseRpcBody("text/event-stream", sse)?.result).toEqual({ ok: true });
	});

	it("returns null for a body that is neither (so the caller reports it, not crashes)", () => {
		expect(parseRpcBody("text/html", "<html>gateway error</html>")).toBeNull();
	});

	it("picks the answering message out of a batch response", () => {
		const batch = '[{"jsonrpc":"2.0","method":"notifications/x"},{"jsonrpc":"2.0","id":1,"result":{"ok":true}}]';
		expect(parseRpcBody("application/json", batch)?.result).toEqual({ ok: true });
	});
});

describe("extractToolResult — unwrapping the MCP content envelope", () => {
	it("parses JSON text content so pipelines can $ref fields off it", () => {
		const r = extractToolResult({ content: [{ type: "text", text: '{"session_id":"s-1","slug":"cafe"}' }] });
		expect(r.data).toEqual({ session_id: "s-1", slug: "cafe" });
		expect(r.isError).toBe(false);
	});

	it("keeps plain (non-JSON) text as a string", () => {
		expect(extractToolResult({ content: [{ type: "text", text: "done" }] }).data).toBe("done");
	});

	it("joins multiple text parts", () => {
		expect(extractToolResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }).data).toBe("a\nb");
	});

	it("prefers structuredContent when the server sends it", () => {
		const r = extractToolResult({ structuredContent: { id: 7 }, content: [{ type: "text", text: "ignored" }] });
		expect(r.data).toEqual({ id: 7 });
	});

	it("surfaces isError from the server", () => {
		expect(extractToolResult({ content: [{ type: "text", text: "nope" }], isError: true }).isError).toBe(true);
	});
});

// ─── #260: protocol / version negotiation ───────────────────────────────────────────────

describe("version negotiation (pure)", () => {
	it("picks the newest version present in both lists", () => {
		// SUPPORTED_VERSIONS is in preference order, so the first match is the best one — a naive
		// "first in THEIR list" would pin us to whatever the server happened to list first.
		expect(negotiateVersion(["2025-06-18", "2025-11-25"])).toBe("2025-11-25");
	});

	it("returns null when the sets are disjoint, rather than guessing a version", () => {
		// A server newer than this client is a real outcome; inventing a version would produce
		// the "connected but the tools are broken" failure this work exists to remove.
		expect(negotiateVersion(["2099-01-01"])).toBeNull();
		expect(negotiateVersion(undefined)).toBeNull();
		expect(negotiateVersion("not-a-list")).toBeNull();
	});

	it("never advertises a version it cannot actually produce", () => {
		// Advertising an unspeakable version is worse than advertising none: the server accepts
		// the negotiation and then receives a request in the wrong shape.
		expect(SUPPORTED_VERSIONS).toContain(MODERN_VERSION);
		expect(SUPPORTED_VERSIONS).toContain(LEGACY_VERSION);
		expect(eraForVersion(MODERN_VERSION)).toBe("modern");
		for (const v of SUPPORTED_VERSIONS.filter((x) => x !== MODERN_VERSION)) expect(eraForVersion(v)).toBe("legacy");
	});
});

describe("classifyModernFailure — is this server modern or legacy?", () => {
	it("treats a reserved MCP error code as proof the server is modern", () => {
		// Falling back to `initialize` here would downgrade a modern server over a fixable
		// complaint about the request's contents.
		expect(classifyModernFailure(400, { error: { code: -32022 } })).toBe("unsupported_version");
		expect(classifyModernFailure(400, { error: { code: -32020 } })).toBe("header_mismatch");
		expect(classifyModernFailure(400, { error: { code: -32021 } })).toBe("missing_capability");
		expect(classifyModernFailure(404, { error: { code: -32601 } })).toBe("modern_other");
	});

	it("treats a bare 4xx with no modern error body as a legacy server", () => {
		expect(classifyModernFailure(400, null)).toBe("legacy");
		expect(classifyModernFailure(405, null)).toBe("legacy");
		expect(classifyModernFailure(404, { error: { code: -1 } })).toBe("legacy");
	});

	it("says nothing about a 2xx or a 5xx", () => {
		// A 500 is the server being broken, not the server being old — retrying as legacy would
		// double the load and still fail.
		expect(classifyModernFailure(200, null)).toBeNull();
		expect(classifyModernFailure(503, null)).toBeNull();
	});
});

describe("modern request metadata", () => {
	it("carries the three required _meta keys without clobbering caller _meta", () => {
		const p = withRequestMeta({ name: "x", _meta: { "vendor/thing": 1 } }, MODERN_VERSION);
		const meta = p._meta as Record<string, unknown>;
		expect(meta["io.modelcontextprotocol/protocolVersion"]).toBe(MODERN_VERSION);
		expect(meta["io.modelcontextprotocol/clientInfo"]).toBeTruthy();
		expect(meta["io.modelcontextprotocol/clientCapabilities"]).toEqual({});
		expect(meta["vendor/thing"]).toBe(1);
	});

	it("sources Mcp-Name from the right field per method", () => {
		expect(mcpNameFor("tools/call", { name: "get_weather" })).toBe("get_weather");
		expect(mcpNameFor("resources/read", { uri: "file:///a" })).toBe("file:///a");
		expect(mcpNameFor("tools/list", {})).toBeNull();
	});

	it("base64-encodes a header value that isn't header-safe", () => {
		// A remote tool name is only SHOULD-constrained to ASCII, so a raw one is both a spec
		// violation and a header-injection primitive.
		expect(encodeHeaderValue("get_weather")).toBe("get_weather");
		expect(encodeHeaderValue("héllo")).toMatch(/^=\?base64\?.+\?=$/);
		expect(encodeHeaderValue("a\r\nX-Evil: 1")).toMatch(/^=\?base64\?/);
		expect(encodeHeaderValue(" padded ")).toMatch(/^=\?base64\?/);
		// A plain-ASCII value that LOOKS like the sentinel must be encoded too, or a server
		// would decode content that was never encoded.
		expect(encodeHeaderValue("=?base64?literal?=")).toBe("=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=");
	});
});

describe("mcp_call_tool — modern (2026-07-28) servers", () => {
	it("calls a modern server with ONE post: no initialize, no session", async () => {
		const calls = mockRpc({ "tools/call": { body: textResult({ session_id: "s-1" }) } });
		const { ctx } = makeCtx();
		const r = await callTool.handler(ctx, { url: "https://example.com/mcp", tool: "create_site", args: { template_slug: "neon-ai" } });

		expect(r.success).toBe(true);
		expect(JSON.parse(r.content)).toEqual({ tool: "create_site", ok: true, data: { session_id: "s-1" } });
		// The handshake is gone in this era — sending it anyway is a wasted round trip against
		// a server that has no `initialize` method at all.
		expect(calls.map((c) => c.body.method)).toEqual(["tools/call"]);
	});

	it("mirrors the body metadata into the required headers", async () => {
		const calls = mockRpc({ "tools/call": { body: textResult({}) } });
		const { ctx } = makeCtx();
		await callTool.handler(ctx, { url: "https://example.com/mcp", tool: "get_weather", args: { city: "Sydney" } });

		const req = calls[0];
		expect(req.headers.get("MCP-Protocol-Version")).toBe(MODERN_VERSION);
		expect(req.headers.get("Mcp-Method")).toBe("tools/call");
		expect(req.headers.get("Mcp-Name")).toBe("get_weather");
		expect(req.headers.get("Accept")).toContain("text/event-stream");
		expect(req.headers.get("Accept")).toContain("application/json");
		// The header value MUST equal the body value or a validating server answers -32020.
		expect(req.body.params.name).toBe("get_weather");
		expect(req.body.params._meta["io.modelcontextprotocol/protocolVersion"]).toBe(MODERN_VERSION);
		// Sessions do not exist in this era.
		expect(req.headers.get("Mcp-Session-Id")).toBeNull();
	});

	it("sends the vault token as a bearer", async () => {
		const calls = mockRpc({ "tools/call": { body: textResult({}) } });
		const { ctx } = makeCtx({ token: "tok-xyz" });
		await callTool.handler(ctx, { url: "https://example.com/mcp", tool: "get_status" });
		expect(calls[0].headers.get("Authorization")).toBe("Bearer tok-xyz");
	});

	it("reports a header/body mismatch as a client bug and does NOT fall back to initialize", async () => {
		// -32020 proves the server is modern. Downgrading to the handshake on it would hide a
		// real client bug behind a transport change and produce a second, unrelated failure.
		const calls = mockRpc({ "tools/call": { status: 400, body: { jsonrpc: "2.0", id: 1, error: { code: -32020, message: "Mcp-Name mismatch" } } } });
		const { ctx } = makeCtx();
		const r = await callTool.handler(ctx, { url: "https://example.com/mcp", tool: "x" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/client bug/);
		expect(calls.map((c) => c.body.method)).toEqual(["tools/call"]);
	});
});

describe("mcp_call_tool — legacy (initialize/session) servers", () => {
	it("falls back to the handshake when a modern POST gets a non-modern 4xx", async () => {
		const calls = mockRpc({ "tools/call": [LEGACY_REJECTS_MODERN, { body: textResult({ ok: 1 }) }], initialize: OK_INIT }, { sessionId: "sess-9" });
		const { ctx } = makeCtx();
		const r = await callTool.handler(ctx, { url: "https://example.com/mcp", tool: "create_site" });

		expect(r.success).toBe(true);
		// modern probe → initialize → initialized → the real call.
		expect(calls.map((c) => c.body.method)).toEqual(["tools/call", "initialize", "notifications/initialized", "tools/call"]);
		// The session id from initialize rides on everything after it.
		expect(calls[3].headers.get("Mcp-Session-Id")).toBe("sess-9");
		// …and the legacy shape carries no per-request _meta.
		expect(calls[3].body.params._meta).toBeUndefined();
	});

	it("completes the handshake with notifications/initialized", async () => {
		// A strict legacy server may refuse requests until the client confirms initialization,
		// and it is a spec MUST — the previous client skipped it entirely.
		const calls = mockRpc({ "tools/call": [LEGACY_REJECTS_MODERN, { body: textResult({}) }], initialize: OK_INIT });
		const { ctx } = makeCtx();
		await callTool.handler(ctx, { url: "https://example.com/mcp", tool: "x" });
		const note = calls.find((c) => c.body.method === "notifications/initialized")!;
		expect(note).toBeTruthy();
		// A notification carries no id — a server that sees one is entitled to answer it.
		expect(note.body.id).toBeUndefined();
	});

	it("sends the version the server NEGOTIATED, not the one we offered", async () => {
		// The spec says follow-up requests carry the negotiated version. Sending our preference
		// regardless is how a server that downgraded us rejects every follow-up as unsupported.
		const downgraded = { body: { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", capabilities: {} } } };
		const calls = mockRpc({ "tools/call": [LEGACY_REJECTS_MODERN, { body: textResult({}) }], initialize: downgraded });
		const { ctx } = makeCtx();
		await callTool.handler(ctx, { url: "https://example.com/mcp", tool: "x" });
		expect(calls[1].headers.get("MCP-Protocol-Version")).toBe(LEGACY_VERSION); // what we offered
		expect(calls[3].headers.get("MCP-Protocol-Version")).toBe("2025-03-26"); // what we agreed
	});

	it("caches the era so the second call skips the modern probe", async () => {
		const calls = mockRpc({ "tools/call": [LEGACY_REJECTS_MODERN, { body: textResult({}) }, { body: textResult({}) }], initialize: OK_INIT });
		const { ctx } = makeCtx();
		await callTool.handler(ctx, { url: "https://example.com/mcp", tool: "x" });
		const afterFirst = calls.length;
		await callTool.handler(ctx, { url: "https://example.com/mcp", tool: "y" });
		// Second call: initialize → initialized → call. No wasted 400-generating probe.
		expect(calls.slice(afterFirst).map((c) => c.body.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
	});

	it("re-probes after a failure instead of staying pinned to a stale era", async () => {
		// A server that upgrades — or that was misclassified by a transient 400 — must not be
		// stuck on the wrong transport for the isolate's lifetime.
		mockRpc({ "tools/call": [LEGACY_REJECTS_MODERN, { status: 500, contentType: "text/html", body: "boom" }], initialize: OK_INIT });
		const { ctx } = makeCtx();
		await callTool.handler(ctx, { url: "https://example.com/mcp", tool: "x" });
		vi.restoreAllMocks();

		const calls = mockRpc({ "tools/call": { body: textResult({}) } });
		await callTool.handler(ctx, { url: "https://example.com/mcp", tool: "x" });
		expect(calls.map((c) => c.body.method)).toEqual(["tools/call"]); // modern again
	});
});

describe("mcp_call_tool — version mismatch", () => {
	it("retries on a mutually supported version when the server names one", async () => {
		const calls = mockRpc({ "tools/call": [unsupportedVersion(["2025-11-25", "2025-06-18"]), { body: textResult({ ok: 1 }) }], initialize: OK_INIT });
		const { ctx } = makeCtx();
		const r = await callTool.handler(ctx, { url: "https://example.com/mcp", tool: "x" });

		expect(r.success).toBe(true);
		// 2025-11-25 is a handshake-era version, so agreeing on it means switching transports —
		// not just changing a header.
		expect(calls.map((c) => c.body.method)).toEqual(["tools/call", "initialize", "notifications/initialized", "tools/call"]);
		expect(calls[1].body.params.protocolVersion).toBe("2025-11-25");
	});

	it("reports both version lists when there is no overlap, and gives up", async () => {
		// The failure a user can act on: "we speak these, it speaks those" — not a generic 400.
		const calls = mockRpc({ "tools/call": unsupportedVersion(["2099-01-01"]) });
		const { ctx } = makeCtx();
		const r = await callTool.handler(ctx, { url: "https://example.com/mcp", tool: "x" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/2099-01-01/);
		expect(r.content).toMatch(new RegExp(MODERN_VERSION));
		expect(calls).toHaveLength(1); // no pointless retry
	});
});

// ─── #262: per-server, per-tool consent ─────────────────────────────────────────────────

describe("mcp_call_tool — consent is per server and per tool", () => {
	it("refuses a server it has no grant for, before anything reaches the network", async () => {
		// The escalation this closes: one connector-level `mcp` write grant used to authorise
		// every endpoint the instance could name.
		const calls = mockRpc({ "tools/call": { body: textResult({}) } });
		const { ctx } = makeCtx({ grants: [] });
		const r = await callTool.handler(ctx, { url: "https://other.example.com/mcp", tool: "create_site" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/no consent/);
		expect(calls).toHaveLength(0);
	});

	it("does not consult the vault for a refused call", async () => {
		// A refusal must not mint a credential — that is a token use the owner never authorised,
		// and on an OAuth-backed provider it is a side effect visible to the remote service.
		mockRpc({ "tools/call": { body: textResult({}) } });
		let minted = 0;
		const { ctx } = makeCtx({ grants: [] });
		(ctx as { connectorClient?: unknown }).connectorClient = () =>
			({
				token: async () => {
					minted++;
					return "tok";
				},
			}) as unknown as ConnectorClient;
		await callTool.handler(ctx, { url: "https://example.com/mcp", tool: "create_site" });
		expect(minted).toBe(0);
	});

	it("allows an ordinary tool under a wildcard grant but not a destructive one", async () => {
		mockRpc({ "tools/call": { body: textResult({}) } });
		const { ctx } = makeCtx({ grants: [ALL_TOOLS] });
		expect((await callTool.handler(ctx, { url: "https://example.com/mcp", tool: "add_section" })).success).toBe(true);
		// "let this agent operate my site builder" must not quietly include delete_site.
		const del = await callTool.handler(ctx, { url: "https://example.com/mcp", tool: "delete_site" });
		expect(del.success).toBe(false);
		expect(del.content).toMatch(/destructive/);
	});

	it("allows a destructive tool once it is granted by name", async () => {
		mockRpc({ "tools/call": { body: textResult({}) } });
		const { ctx } = makeCtx({ grants: [ALL_TOOLS, "delete_site"] });
		expect((await callTool.handler(ctx, { url: "https://example.com/mcp", tool: "delete_site" })).success).toBe(true);
	});

	it("keeps discovery ungated — mcp_list_tools is read-only and names nothing", async () => {
		// Requiring consent to LIST is the trap #262 names: you cannot approve individual tools
		// if you can't find out what they are.
		const tools = { tools: [{ name: "create_site", description: "…", inputSchema: { type: "object" } }] };
		mockRpc({ "tools/list": { body: { jsonrpc: "2.0", id: 1, result: tools } } });
		const { ctx } = makeCtx({ grants: [] });
		const r = await listTools.handler(ctx, { url: "https://example.com/mcp" });
		expect(r.success).toBe(true);
		expect(JSON.parse(r.content)).toEqual(tools);
	});
});

// ─── #265: audit + redaction ────────────────────────────────────────────────────────────

describe("outbound MCP is traced, and the trace carries no secrets", () => {
	it("logs a successful call with endpoint, tool, era, status and duration", async () => {
		mockRpc({ "tools/call": { body: textResult({ id: 1 }) } });
		const { ctx, events } = makeCtx();
		await callTool.handler(ctx, { url: "https://example.com/mcp", tool: "create_site", args: { slug: "cafe" } });

		const ev = events.find((e) => e.event === "mcp.call")!;
		expect(ev.source).toBe("mcp");
		expect(ev.level).toBe("info");
		expect(ev.context.endpoint).toBe("https://example.com/mcp");
		expect(ev.context.tool).toBe("create_site");
		expect(ev.context.method).toBe("tools/call");
		expect(ev.context.era).toBe("modern");
		expect(ev.context.protocolVersion).toBe(MODERN_VERSION);
		expect(ev.context.status).toBe(200);
		expect(ev.context.ok).toBe(true);
		expect(typeof ev.context.durationMs).toBe("number");
	});

	it("records argument KEY NAMES and size, never argument values", async () => {
		// Arguments to an arbitrary remote tool are the most PII-dense thing this connector
		// touches; a log that keeps them turns the audit trail into a second copy of the data.
		mockRpc({ "tools/call": { body: textResult({}) } });
		const { ctx, events } = makeCtx();
		await callTool.handler(ctx, { url: "https://example.com/mcp", tool: "set_contact", args: { email: "jane@example.com", phone: "0400000000" } });

		const ev = events.find((e) => e.event === "mcp.call")!;
		expect(ev.context.argKeys).toEqual(["email", "phone"]);
		expect(typeof ev.context.argBytes).toBe("number");
		const blob = JSON.stringify(events);
		expect(blob).not.toContain("jane@example.com");
		expect(blob).not.toContain("0400000000");
	});

	it("never writes the bearer token into the trace", async () => {
		mockRpc({ "tools/call": { body: textResult({}) } });
		const { ctx, events } = makeCtx({ token: "sk-live-supersecrettoken12345" });
		await callTool.handler(ctx, { url: "https://example.com/mcp", tool: "x" });
		expect(JSON.stringify(events)).not.toContain("supersecrettoken");
	});

	it("logs the endpoint without its query string, because that query is often the credential", async () => {
		mockRpc({ "tools/call": { body: textResult({}) } });
		const { ctx, events } = makeCtx();
		await callTool.handler(ctx, { url: "https://example.com/mcp?key=sk-live-abcdefghijklmnop", tool: "x" });
		const blob = JSON.stringify(events);
		expect(blob).toContain("https://example.com/mcp");
		expect(blob).not.toContain("abcdefghijklmnop");
	});

	it("logs a refusal BEFORE dispatch, with the reason", async () => {
		mockRpc({ "tools/call": { body: textResult({}) } });
		const { ctx, events } = makeCtx({ grants: [] });
		await callTool.handler(ctx, { url: "https://example.com/mcp", tool: "create_site" });

		const ev = events.find((e) => e.event === "mcp.denied")!;
		expect(ev).toBeTruthy();
		expect(ev.level).toBe("warn");
		expect(ev.context.failure).toBe("denied");
		expect(ev.context.endpoint).toBe("https://example.com/mcp");
		expect(ev.context.tool).toBe("create_site");
		// Nothing was attempted, so there is no call event to confuse a reader of the timeline.
		expect(events.some((e) => e.event === "mcp.call")).toBe(false);
	});

	it("classifies a remote failure so a timeline can be filtered by failure kind", async () => {
		mockRpc({ "tools/call": { body: { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "unknown tool" } } } });
		const { ctx, events } = makeCtx();
		await callTool.handler(ctx, { url: "https://example.com/mcp", tool: "nope" });
		const ev = events.find((e) => e.event === "mcp.call")!;
		expect(ev.context.ok).toBe(false);
		expect(ev.context.failure).toBe("rpc_error");
		expect(ev.level).toBe("warn");
	});

	it("distinguishes a failed TOOL from a failed RPC", async () => {
		// `isError` means the call worked and the tool refused — a different thing to debug than
		// a transport or protocol failure, so it gets its own class.
		mockRpc({ "tools/call": { body: textResult({ error: "slug taken" }, true) } });
		const { ctx, events } = makeCtx();
		const r = await callTool.handler(ctx, { url: "https://example.com/mcp", tool: "create_site" });
		expect(r.success).toBe(false);
		expect(events.some((e) => e.context.failure === "tool_error")).toBe(true);
	});
});

// ─── behaviour preserved from before the dual-era work ──────────────────────────────────

describe("mcp_call_tool — credentials, errors and input validation", () => {
	it('omits the credential entirely when auth is "none"', async () => {
		const calls = mockRpc({ "tools/call": { body: textResult({}) } });
		// A ctx whose vault would THROW — proves the open-server path never consults it.
		const { ctx } = makeCtx({ token: null });
		const r = await callTool.handler(ctx, { url: "https://example.com/mcp", tool: "list_templates", auth: "none" });
		expect(r.success).toBe(true);
		expect(calls[0].headers.get("Authorization")).toBeNull();
	});

	it("reports a missing credential instead of calling out unauthenticated", async () => {
		const calls = mockRpc({});
		const { ctx } = makeCtx({ token: null });
		const r = await callTool.handler(ctx, { url: "https://example.com/mcp", tool: "create_site" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/No credential connected/);
		expect(calls).toHaveLength(0); // nothing hit the network
	});

	it("fails the step when the server reports the TOOL failed (isError), not just RPC errors", async () => {
		mockRpc({ "tools/call": { body: textResult({ error: "slug taken" }, true) } });
		const r = await callTool.handler(makeCtx().ctx, { url: "https://example.com/mcp", tool: "create_site" });
		expect(r.success).toBe(false);
		expect(JSON.parse(r.content).ok).toBe(false);
	});

	it("surfaces a JSON-RPC error with the server's message", async () => {
		mockRpc({ "tools/call": { body: { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "unknown tool" } } } });
		const r = await callTool.handler(makeCtx().ctx, { url: "https://example.com/mcp", tool: "nope" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/unknown tool/);
	});

	it("explains a 401 as a credential problem, and stops before retrying anything", async () => {
		const calls = mockRpc({ "tools/call": { status: 401, body: { error: "unauthorized" } } });
		const r = await callTool.handler(makeCtx().ctx, { url: "https://example.com/mcp", tool: "create_site" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/rejected the credential/);
		expect(r.content).toMatch(/OAuth/); // points at the real cause for OAuth-only servers
		// #180: a 401 also probes the server's published OAuth metadata (GETs, no JSON-RPC body)
		// to say WHICH auth model it wants. What must not happen is a second attempt at the tool,
		// so assert on the RPC methods rather than on the raw request count.
		expect(calls.map((c) => c.body.method).filter(Boolean)).toEqual(["tools/call"]);
	});

	it("reports an unparseable response with the status and a body excerpt", async () => {
		// 502 is not a 4xx, so it is not era evidence — it is reported as-is rather than
		// triggering a pointless handshake retry.
		mockRpc({ "tools/call": { status: 502, contentType: "text/html", body: "<html>bad gateway</html>" } });
		const r = await callTool.handler(makeCtx().ctx, { url: "https://example.com/mcp", tool: "deploy" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/unparseable/);
		expect(r.content).toMatch(/502/);
	});

	it("redacts a secret echoed back inside a server error page", async () => {
		// A server that reflects the Authorization header into its error body would otherwise
		// put the token straight into the model's transcript and the trace.
		mockRpc({ "tools/call": { status: 500, contentType: "text/html", body: "<html>rejected Bearer sk-live-abcdefghijklmnop</html>" } });
		const r = await callTool.handler(makeCtx().ctx, { url: "https://example.com/mcp", tool: "x" });
		expect(r.content).not.toContain("sk-live-abcdefghijklmnop");
		expect(r.content).toMatch(/redacted/);
	});

	it("requires a tool name and an https endpoint", async () => {
		const calls = mockRpc({});
		const { ctx } = makeCtx();
		expect((await callTool.handler(ctx, { url: "https://example.com/mcp" })).success).toBe(false);
		expect((await callTool.handler(ctx, { url: "http://example.com/mcp", tool: "x" })).content).toMatch(/https/);
		expect((await callTool.handler(ctx, { tool: "x" })).content).toMatch(/https/);
		expect(calls).toHaveLength(0);
	});
});

describe("mcp_list_tools", () => {
	it("returns the server's published tool schemas verbatim", async () => {
		const tools = { tools: [{ name: "create_site", description: "…", inputSchema: { type: "object" } }] };
		const calls = mockRpc({ "tools/list": { body: { jsonrpc: "2.0", id: 1, result: tools } } });
		const r = await listTools.handler(makeCtx().ctx, { url: "https://example.com/mcp" });
		expect(r.success).toBe(true);
		expect(JSON.parse(r.content)).toEqual(tools);
		// tools/list has no name to mirror, so the header must be absent rather than empty.
		expect(calls[0].headers.get("Mcp-Name")).toBeNull();
		expect(calls[0].headers.get("Mcp-Method")).toBe("tools/list");
	});
});
