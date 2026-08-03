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
// Transport: Streamable HTTP (the current MCP remote transport). One JSON-RPC POST per call.
// Servers may answer with `application/json` OR an SSE-framed `text/event-stream` body, so
// both are parsed. Stateless servers need no session; for stateful ones the `Mcp-Session-Id`
// handed back by `initialize` is echoed on the follow-up call.
//
// Auth: `Authorization: Bearer <token>` from the vault (user_api_keys, provider "mcp") via
// ctx.connectorClient("mcp").token(). Used on the wire only — never in inputs, schema, or
// result. Servers fronted by OAuth 2.1 + dynamic client registration cannot be reached
// headlessly this way; those need the generic connector-OAuth flow (#147) pointed at them.
//
// Every request goes through safeFetch (lib/ssrf.ts) — https-only, redirect-revalidated — so
// a pipeline-supplied endpoint can't be aimed at cloud metadata or an internal address.
import type { ToolDef, RegistryToolCtx } from "../tool-registry.js";
import { safeFetch, SsrfError } from "../ssrf.js";

/** MCP protocol version we advertise on the handshake. */
const PROTOCOL_VERSION = "2025-06-18";
/** How we identify ourselves to the remote server. */
const CLIENT_INFO = { name: "proagentstore", version: "1.0.0" };

interface JsonRpcResponse {
	jsonrpc?: string;
	id?: unknown;
	result?: unknown;
	error?: { code?: number; message?: string; data?: unknown };
}

/**
 * Parse a Streamable-HTTP response body into a JSON-RPC response. A server with
 * `enableJsonResponse` answers with a plain JSON object; otherwise the body is an SSE
 * stream whose `data:` frames each carry one message. We take the LAST frame that has a
 * `result` or `error` (notifications/progress frames come first and carry neither).
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
	sessionId?: string | null;
}

/** One JSON-RPC POST. Returns the parsed response plus any session id the server assigned. */
async function rpc(call: RpcCall): Promise<{ res: JsonRpcResponse | null; status: number; sessionId: string | null; rawBody: string }> {
	const headers = new Headers({
		"Content-Type": "application/json",
		// Both are advertised: a server may answer either way, and one that streams will
		// reject a request that doesn't accept text/event-stream.
		Accept: "application/json, text/event-stream",
		"MCP-Protocol-Version": PROTOCOL_VERSION,
	});
	if (call.token) headers.set("Authorization", `Bearer ${call.token}`);
	if (call.sessionId) headers.set("Mcp-Session-Id", call.sessionId);

	const res = await safeFetch(call.url, {
		method: "POST",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", id: call.id, method: call.method, params: call.params }),
	});
	const rawBody = await res.text();
	return {
		res: parseRpcBody(res.headers.get("Content-Type") ?? "", rawBody),
		status: res.status,
		sessionId: res.headers.get("Mcp-Session-Id"),
		rawBody,
	};
}

/**
 * Run `initialize` then the real call. The handshake is cheap (one extra round trip) and is
 * what makes this work against a stateful server too: whatever session id `initialize`
 * returns is echoed on the follow-up. A server that rejects the handshake but would have
 * served the call directly is not worth optimizing for — the spec requires it.
 */
async function mcpCall(
	ctx: RegistryToolCtx,
	input: Record<string, unknown>,
	method: string,
	params: Record<string, unknown>,
): Promise<{ content: string; success: boolean }> {
	let endpoint: { url: string; useAuth: boolean };
	try {
		endpoint = readEndpoint(input);
	} catch (e) {
		return { content: e instanceof Error ? e.message : String(e), success: false };
	}

	let token: string | null = null;
	if (endpoint.useAuth) {
		token = (await ctx.connectorClient?.("mcp").token().catch(() => null)) ?? null;
		if (!token) {
			return {
				content: "No credential connected for the mcp connector — add the server's access token in the instance's Connections settings, or pass auth:\"none\" for an open server.",
				success: false,
			};
		}
	}

	try {
		const init = await rpc({
			url: endpoint.url,
			token,
			method: "initialize",
			id: 1,
			params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
		});
		if (init.status === 401 || init.status === 403) {
			return { content: `MCP server rejected the credential (HTTP ${init.status}). If it requires OAuth, a stored token will not work.`, success: false };
		}
		if (init.res?.error) {
			return { content: `MCP initialize failed: ${init.res.error.message ?? "unknown error"}`, success: false };
		}

		const out = await rpc({ url: endpoint.url, token, method, params, id: 2, sessionId: init.sessionId });
		if (!out.res) {
			return { content: `MCP server returned an unparseable response (HTTP ${out.status}): ${out.rawBody.slice(0, 300)}`, success: false };
		}
		if (out.res.error) {
			return { content: `MCP error: ${out.res.error.message ?? "unknown error"}`, success: false };
		}
		return { content: JSON.stringify(out.res.result ?? null, null, 2), success: true };
	} catch (e) {
		if (e instanceof SsrfError) return { content: `Blocked: ${e.message}`, success: false };
		return { content: `MCP request failed: ${e instanceof Error ? e.message : String(e)}`, success: false };
	}
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
		handler: (ctx, input) => mcpCall(ctx, input, "tools/list", {}),
	},
	{
		name: "mcp_call_tool",
		tier: "connector",
		connector: "mcp",
		// write: an MCP tool call can mutate the remote system, so it goes through the same
		// per-instance write-consent gate (#90) every other mutating connector tool does.
		scope: "write",
		description:
			"Call one tool on a remote MCP server (`tools/call`) and return its result. `args` is the tool's own input object — check mcp_list_tools for the schema. The result's text content is parsed as JSON when it is JSON, so a later pipeline step can $ref fields off it (e.g. an id returned by a create-style tool). Returns the tool result; a tool that reports failure comes back unsuccessful.",
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
			const out = await mcpCall(ctx, input, "tools/call", { name: tool, arguments: args });
			if (!out.success) return out;

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
			return {
				content: JSON.stringify({ tool, ok: !isError, data }, null, 2),
				success: !isError,
			};
		},
	},
];
