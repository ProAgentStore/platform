/**
 * A session that reads, writes and reads again stays one session, and a write whose reply is lost
 * can still be settled (#1038).
 *
 * The live report: `mcp-remote` sessions completed one or two calls and then dropped
 * (`SSE stream disconnected: TypeError: terminated`), leaving writes uncertain. Three things are
 * held here:
 *
 *  1. a real `PagsMcp` (its real `init()`, registration pipeline and tools) driven by a real MCP
 *     `Client` through initialize → tools/list → read → write → read, with every audit row carrying
 *     the JSON-RPC id and the session id of the call that wrote it;
 *  2. a FORCED DISCONNECT: the client goes away while a connector write is in flight, the write
 *     lands anyway, and a new session finds it in `mcp_audit_log` by `request_id` + `session_id` —
 *     and a write whose upstream reply is lost answers `outcome: "unknown"` with what to poll;
 *  3. the SSE keep-alive (`sse-keepalive.ts`): a stream that stays silent while a slow tool runs
 *     carries `: ping` comments, never inside an event, and a cancelled stream stops pinging.
 *
 * Not covered here: the Workers runtime itself — `PagsMcp.serve`'s Worker→DO WebSocket bridge
 * cannot run under Node. The bridge's contract (reply lost when its socket closes) is what (2)
 * recovers from; the transport-level drop was not reproduced end-to-end.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { keepSseAlive, withSseKeepAlive } from "./sse-keepalive.js";

vi.mock("@cloudflare/workers-oauth-provider", () => ({ OAuthProvider: class {} }));
vi.mock("agents/mcp", () => ({
	McpAgent: class {
		env: unknown;
		props: unknown;
		static serve() {
			return { fetch: () => new Response("mock") };
		}
	},
}));

const { PagsMcp } = await import("./index.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { putRepoFileConfirmed, putRepoFilesConfirmed } = await import("./repo-tools.js");

function memoryKv() {
	const data = new Map<string, string>();
	return {
		data,
		kv: {
			get: async (k: string) => data.get(k) ?? null,
			put: async (k: string, v: string) => void data.set(k, v),
			delete: async (k: string) => void data.delete(k),
			list: async ({ prefix = "", limit = 1000 }: { prefix?: string; limit?: number } = {}) => {
				const all = [...data.keys()].filter((n) => n.startsWith(prefix)).sort();
				return { keys: all.slice(0, limit).map((name) => ({ name })), list_complete: all.length <= limit, cursor: undefined, cacheStatus: null };
			},
		} as unknown as KVNamespace,
	};
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** One `PagsMcp` DO, as the agents runtime keeps it: one server, reconnected per session. */
async function server(api: (url: string, init?: RequestInit) => Promise<Response> | Response) {
	const { kv } = memoryKv();
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => api(typeof input === "string" ? input : input.toString(), init));
	// biome-ignore lint/suspicious/noExplicitAny: constructing the mocked-base subclass
	const inst = new (PagsMcp as any)();
	inst.env = { API_BASE: "https://api.test", OAUTH_KV: kv, GITHUB_ORG: "ProAgentStore" };
	inst.props = { authToken: "session-token", mcpScopes: ["read", "write", "runtime"], mcpSubject: "user-1" };
	await inst.init();
	return {
		/** Open a session: what an `initialize` over Streamable HTTP does, with its `mcp-session-id`. */
		async connect(sessionId: string) {
			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
			serverTransport.sessionId = sessionId;
			const client = new Client({ name: "session-lifecycle", version: "0.0.0" });
			await Promise.all([client.connect(clientTransport), inst.server.connect(serverTransport)]);
			return client;
		},
	};
}

// biome-ignore lint/suspicious/noExplicitAny: the SDK client's result type is a union
const textOf = (r: any): string => r.content?.[0]?.text ?? "";
// biome-ignore lint/suspicious/noExplicitAny: same
const auditEvents = async (client: any, args: Record<string, unknown>) =>
	JSON.parse(textOf(await client.callTool({ name: "mcp_audit_log", arguments: args }))).events as Array<Record<string, unknown>>;

afterEach(() => {
	vi.unstubAllGlobals();
});

const INSTANCES = { instances: [{ id: "inst-1", name: "Coder", capabilities: { surfaces: [] } }] };

describe("one session: read → write → read (#1038)", () => {
	it("keeps the session, and every write's audit row carries its own request id and the session id", async () => {
		const s = await server((url) => {
			const path = new URL(url).pathname;
			if (path === "/v1/instances/my/instances") return json(INSTANCES);
			if (path === "/v1/instances/inst-1/tools/github_create_issue") return json({ success: true, content: "Created issue #42" });
			return json({});
		});
		const client = await s.connect("sess-A");
		expect((await client.listTools()).tools.length).toBeGreaterThan(0);

		expect(textOf(await client.callTool({ name: "my_instances", arguments: {} }))).toContain("inst-1");
		const write = await client.callTool({ name: "call_instance_tool", arguments: { instance_id: "inst-1", tool: "github_create_issue", input: { title: "x" } } });
		expect(textOf(write)).toContain("Created issue #42");
		expect(textOf(await client.callTool({ name: "my_instances", arguments: {} }))).toContain("inst-1");

		const [row] = await auditEvents(client, { tool: "call_instance_tool" });
		expect(row).toMatchObject({ action: "completed", mcpSessionId: "sess-A", input: { invoked: "github_create_issue" } });
		expect(typeof row.requestId).toBe("string");

		// Exactly that request, and only in its own session: ids restart per session.
		const found = await auditEvents(client, { request_id: row.requestId, session_id: "sess-A" });
		expect(found.map((e) => e.id)).toEqual([row.id]);
		expect(await auditEvents(client, { request_id: row.requestId, session_id: "sess-B" })).toEqual([]);
	});
});

describe("forced disconnect mid-write (#1038)", () => {
	it("a write whose client went away still lands, and a new session finds it by request_id + session_id", async () => {
		let release!: () => void;
		const held = new Promise<void>((r) => {
			release = r;
		});
		let reached!: () => void;
		const inFlight = new Promise<void>((r) => {
			reached = r;
		});
		const s = await server(async (url) => {
			const path = new URL(url).pathname;
			if (path === "/v1/instances/my/instances") return json(INSTANCES);
			if (path === "/v1/instances/inst-1/tools/github_create_issue") {
				reached();
				await held; // the write is in flight upstream when the client disappears
				return json({ success: true, content: "Created issue #43" });
			}
			return json({});
		});

		const first = await s.connect("sess-lost");
		const call = first.callTool({ name: "call_instance_tool", arguments: { instance_id: "inst-1", tool: "github_create_issue", input: { title: "y" } } });
		await inFlight;
		await first.close(); // the stream is cut: this client never gets a reply
		await expect(call).rejects.toThrow();
		release();
		await new Promise((r) => setTimeout(r, 20)); // the handler finishes with nobody listening

		const second = await s.connect("sess-new");
		const [lost] = await auditEvents(second, { session_id: "sess-lost", tool: "call_instance_tool" });
		expect(lost).toMatchObject({ action: "completed", mcpSessionId: "sess-lost", result: { ok: true } });
		const byRequest = await auditEvents(second, { request_id: lost.requestId, session_id: "sess-lost" });
		expect(byRequest.map((e) => e.id)).toEqual([lost.id]);
	});

	it("a write whose upstream reply is lost answers unknown with what to poll, and audits it as unknown", async () => {
		const s = await server((url) => {
			const path = new URL(url).pathname;
			if (path === "/v1/instances/my/instances") return json(INSTANCES);
			if (path === "/v1/instances/inst-1/tools/github_create_issue") return json({ error: "upstream" }, 504);
			return json({});
		});
		const client = await s.connect("sess-504");
		const out = JSON.parse(textOf(await client.callTool({ name: "call_instance_tool", arguments: { instance_id: "inst-1", tool: "github_create_issue", input: {} } })));
		expect(out).toMatchObject({
			outcome: "unknown",
			confirmation: { reason: "gateway-error", httpStatus: 504 },
			poll: { tool: "list_instance_tools", input: { instance_id: "inst-1" } },
		});
		expect(out.detail).toMatch(/does not prove failure.*request_id \+ session_id/);
		const [row] = await auditEvents(client, { tool: "call_instance_tool", session_id: "sess-504" });
		expect(row).toMatchObject({ action: "unknown", result: { ok: null, outcome: "unknown" } });
	});
});

describe("SSE keep-alive (#1038)", () => {
	const enc = new TextEncoder();
	const sse = (body: ReadableStream<Uint8Array>) => new Response(body, { headers: { "Content-Type": "text/event-stream" } });
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	it("pings a stream that stays silent while a slow tool runs, before the result arrives", async () => {
		const upstream = new ReadableStream<Uint8Array>({
			async start(c) {
				await sleep(120); // the tool is still running
				c.enqueue(enc.encode('event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{}}\n\n'));
				c.close();
			},
		});
		const text = await withSseKeepAlive(sse(upstream), 20).text();
		expect(text.indexOf(": ping\n\n")).toBeGreaterThanOrEqual(0);
		expect(text.indexOf(": ping")).toBeLessThan(text.indexOf("event: message"));
		expect(text.endsWith('"result":{}}\n\n')).toBe(true);
	});

	it("never writes a ping inside an event", async () => {
		const upstream = new ReadableStream<Uint8Array>({
			async start(c) {
				c.enqueue(enc.encode("event: message\n"));
				await sleep(100);
				c.enqueue(enc.encode('data: {"ok":true}\n\n'));
				c.close();
			},
		});
		const text = await withSseKeepAlive(sse(upstream), 20).text();
		expect(text).toContain('event: message\ndata: {"ok":true}\n\n');
	});

	it("a client that goes away stops the pings and closes the upstream bridge", async () => {
		const cancelled = vi.fn();
		const upstream = new ReadableStream<Uint8Array>({ cancel: cancelled });
		const res = withSseKeepAlive(sse(upstream), 10);
		const reader = res.body!.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toBe(": ping\n\n");
		await reader.cancel("client gone");
		expect(cancelled).toHaveBeenCalledWith("client gone");
	});

	it("leaves non-SSE responses alone, and wraps the handler without changing status or headers", async () => {
		const plain = new Response("{}", { status: 202, headers: { "Content-Type": "application/json" } });
		expect(withSseKeepAlive(plain)).toBe(plain);
		const handler = keepSseAlive({ fetch: async () => sse(new ReadableStream({ start: (c) => c.close() })) });
		const res = await handler.fetch();
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		expect(res.status).toBe(200);
	});
});

describe("GitHub writes with no answer in time (#1038)", () => {
	const env = { API_BASE: "https://api.test", GITHUB_TOKEN: "gh", GITHUB_ORG: "ProAgentStore" } as never;

	it("write_agent_file: unknown, with read_agent_file to settle it — never a failure", async () => {
		vi.useFakeTimers();
		try {
			vi.stubGlobal("fetch", () => new Promise<Response>(() => {})); // GitHub never answers
			const pending = putRepoFileConfirmed(env, "ProAgentStore", "my-agent", "src/a.ts", "x");
			await vi.advanceTimersByTimeAsync(20_000);
			expect(await pending).toMatchObject({ outcome: "unknown", confirmation: { reason: "deadline-exceeded" }, poll: { tool: "read_agent_file", input: { agent_id: "my-agent", path: "src/a.ts" } } });
		} finally {
			vi.useRealTimers();
		}
	});

	it("batch_write_agent_files: unknown names the files already confirmed", async () => {
		vi.useFakeTimers();
		try {
			let puts = 0;
			vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
				if (init?.method !== "PUT") return Promise.resolve(json({}, 404)); // no existing file
				return ++puts === 1 ? Promise.resolve(json({ content: {} })) : new Promise<Response>(() => {});
			});
			const pending = putRepoFilesConfirmed(env, "ProAgentStore", "my-agent", [{ path: "a.ts", content: "1" }, { path: "b.ts", content: "2" }]);
			await vi.advanceTimersByTimeAsync(60_000);
			const out = await pending;
			expect(out.unknown).toMatchObject({ outcome: "unknown", poll: { tool: "list_agent_repo_files" } });
			expect(out.lines).toEqual(["+ Created a.ts"]);
		} finally {
			vi.useRealTimers();
		}
	});
});
