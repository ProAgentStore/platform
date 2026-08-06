import { afterEach, describe, expect, it, vi } from "vitest";
import { getRegistryTool } from "../tool-registry.js";
import type { RegistryToolCtx } from "../tool-registry.js";
import type { ConnectorClient } from "./client.js";
import { extractToolResult, parseRpcBody } from "./mcp.js";

// Both tools resolved from the REGISTRY (proves they're wired, so a pipeline step / the
// runtime / POST …/tools/<name> can reach them with no bespoke route).
const listTools = getRegistryTool("mcp_list_tools")!;
const callTool = getRegistryTool("mcp_call_tool")!;

/** A ctx whose vault hands back a token, like a user with the mcp credential connected. */
function ctxWithToken(token: string | null = "tok-abc"): RegistryToolCtx {
	return {
		env: {} as never,
		connectorClient: () =>
			({
				token: async () => {
					if (!token) throw new Error("no key");
					return token;
				},
			}) as unknown as ConnectorClient,
	} as RegistryToolCtx;
}

/**
 * Mock the network with a per-JSON-RPC-method script. Records every request so the tests can
 * assert on the handshake, headers, and the params actually put on the wire.
 */
function mockRpc(script: Record<string, { status?: number; contentType?: string; body: unknown }>, opts: { sessionId?: string } = {}) {
	const calls: Array<{ url: string; headers: Headers; body: any }> = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init: any) => {
		const parsedBody = JSON.parse(String(init?.body ?? "{}"));
		calls.push({ url: String(url), headers: new Headers(init?.headers), body: parsedBody });
		const entry = script[parsedBody.method] ?? { body: { jsonrpc: "2.0", id: parsedBody.id, result: {} } };
		const headers: Record<string, string> = { "Content-Type": entry.contentType ?? "application/json" };
		if (opts.sessionId && parsedBody.method === "initialize") headers["Mcp-Session-Id"] = opts.sessionId;
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

const OK_INIT = { body: { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "s", version: "1" } } } };

afterEach(() => vi.restoreAllMocks());

describe("parseRpcBody — both Streamable-HTTP response shapes", () => {
	it("parses a plain JSON response (enableJsonResponse servers)", () => {
		expect(parseRpcBody("application/json", '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')).toEqual({
			jsonrpc: "2.0",
			id: 1,
			result: { ok: true },
		});
	});

	it("parses an SSE-framed response, taking the frame that answers", () => {
		const sse = ['event: message', 'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}', "", "event: message", 'data: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}', ""].join("\n");
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

describe("mcp_call_tool", () => {
	it("handshakes with initialize, then calls the tool with its args", async () => {
		const calls = mockRpc({ initialize: OK_INIT, "tools/call": { body: textResult({ session_id: "s-1" }) } });
		const r = await callTool.handler(ctxWithToken(), {
			url: "https://example.com/mcp",
			tool: "create_site",
			args: { template_slug: "neon-ai" },
		});

		expect(r.success).toBe(true);
		expect(JSON.parse(r.content)).toEqual({ tool: "create_site", ok: true, data: { session_id: "s-1" } });

		expect(calls.map((c) => c.body.method)).toEqual(["initialize", "tools/call"]);
		expect(calls[1].body.params).toEqual({ name: "create_site", arguments: { template_slug: "neon-ai" } });
	});

	it("sends the vault token as a bearer and advertises both response encodings", async () => {
		const calls = mockRpc({ initialize: OK_INIT, "tools/call": { body: textResult({}) } });
		await callTool.handler(ctxWithToken("tok-xyz"), { url: "https://example.com/mcp", tool: "get_status" });

		expect(calls[1].headers.get("Authorization")).toBe("Bearer tok-xyz");
		expect(calls[1].headers.get("Accept")).toContain("text/event-stream");
		expect(calls[1].headers.get("Accept")).toContain("application/json");
		expect(calls[1].headers.get("MCP-Protocol-Version")).toBeTruthy();
	});

	it("echoes a session id back on the follow-up call (stateful servers)", async () => {
		const calls = mockRpc({ initialize: OK_INIT, "tools/call": { body: textResult({}) } }, { sessionId: "sess-9" });
		await callTool.handler(ctxWithToken(), { url: "https://example.com/mcp", tool: "get_status" });
		expect(calls[1].headers.get("Mcp-Session-Id")).toBe("sess-9");
	});

	it("omits the credential entirely when auth is \"none\"", async () => {
		const calls = mockRpc({ initialize: OK_INIT, "tools/call": { body: textResult({}) } });
		// A ctx whose vault would THROW — proves the open-server path never consults it.
		const r = await callTool.handler(ctxWithToken(null), { url: "https://example.com/mcp", tool: "list_templates", auth: "none" });
		expect(r.success).toBe(true);
		expect(calls[1].headers.get("Authorization")).toBeNull();
	});

	it("reports a missing credential instead of calling out unauthenticated", async () => {
		const calls = mockRpc({ initialize: OK_INIT });
		const r = await callTool.handler(ctxWithToken(null), { url: "https://example.com/mcp", tool: "create_site" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/No credential connected/);
		expect(calls).toHaveLength(0); // nothing hit the network
	});

	it("fails the step when the server reports the TOOL failed (isError), not just RPC errors", async () => {
		mockRpc({ initialize: OK_INIT, "tools/call": { body: textResult({ error: "slug taken" }, true) } });
		const r = await callTool.handler(ctxWithToken(), { url: "https://example.com/mcp", tool: "create_site" });
		expect(r.success).toBe(false);
		expect(JSON.parse(r.content).ok).toBe(false);
	});

	it("surfaces a JSON-RPC error with the server's message", async () => {
		mockRpc({ initialize: OK_INIT, "tools/call": { body: { jsonrpc: "2.0", id: 2, error: { code: -32602, message: "unknown tool" } } } });
		const r = await callTool.handler(ctxWithToken(), { url: "https://example.com/mcp", tool: "nope" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/unknown tool/);
	});

	it("explains a 401 as a credential problem, and stops before the tool call", async () => {
		const calls = mockRpc({ initialize: { status: 401, body: { error: "unauthorized" } } });
		const r = await callTool.handler(ctxWithToken(), { url: "https://example.com/mcp", tool: "create_site" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/rejected the credential/);
		expect(r.content).toMatch(/OAuth/); // points at the real cause for OAuth-only servers
		// #180: a 401 now also probes the server's published OAuth metadata (GETs, no JSON-RPC
		// body) to say WHICH auth model it wants. What must not happen is the tool call itself,
		// so assert on the RPC methods rather than on the raw request count.
		expect(calls.map((c) => c.body.method).filter(Boolean)).toEqual(["initialize"]);
	});

	it("reports an unparseable response with the status and a body excerpt", async () => {
		mockRpc({ initialize: OK_INIT, "tools/call": { status: 502, contentType: "text/html", body: "<html>bad gateway</html>" } });
		const r = await callTool.handler(ctxWithToken(), { url: "https://example.com/mcp", tool: "deploy" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/unparseable/);
		expect(r.content).toMatch(/502/);
	});

	it("requires a tool name and an https endpoint", async () => {
		const calls = mockRpc({ initialize: OK_INIT });
		expect((await callTool.handler(ctxWithToken(), { url: "https://example.com/mcp" })).success).toBe(false);
		expect((await callTool.handler(ctxWithToken(), { url: "http://example.com/mcp", tool: "x" })).content).toMatch(/https/);
		expect((await callTool.handler(ctxWithToken(), { tool: "x" })).content).toMatch(/`url` is required/);
		expect(calls).toHaveLength(0);
	});
});

describe("mcp_list_tools", () => {
	it("returns the server's published tool schemas verbatim", async () => {
		const tools = { tools: [{ name: "create_site", description: "…", inputSchema: { type: "object" } }] };
		mockRpc({ initialize: OK_INIT, "tools/list": { body: { jsonrpc: "2.0", id: 2, result: tools } } });
		const r = await listTools.handler(ctxWithToken(), { url: "https://example.com/mcp" });
		expect(r.success).toBe(true);
		expect(JSON.parse(r.content)).toEqual(tools);
	});
});
