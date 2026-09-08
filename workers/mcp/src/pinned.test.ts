import { afterEach, describe, expect, it, vi } from "vitest";

// ── Why a separate harness ────────────────────────────────────────────────────
//
// `index.test.ts` holds the PLATFORM-WIDE surface to one static shape: every registered name
// classified in `TOOL_RISK`, the count equal to `MCP_TOOL_COUNT`. A pinned session (#783)
// registers names that come from an instance's policy rows — data, not literals — so it is a
// different surface with a different contract, and it is held here: which rows become tools,
// that `instance_id` is nowhere in any schema, that annotations follow each row's `mutates`,
// that a mutating pinned tool is gated as `write` and a read as `read`, that an unreadable pin
// registers exactly one explanatory tool, and that the transport wrapper touches nothing but
// `/mcp/i/<id>`.

type ToolContent = { content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolContent>;
interface CapturedTool {
	name: string;
	schema: Record<string, unknown>;
	handler: Handler;
	config: Record<string, unknown>;
}

vi.mock("@cloudflare/workers-oauth-provider", () => ({
	OAuthProvider: class {},
}));
vi.mock("agents/mcp", () => ({
	McpAgent: class {
		env: unknown;
		props: unknown;
		static serve() {
			return { fetch: () => new Response("mock") };
		}
	},
}));
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
	McpServer: class {
		tool() {}
		registerTool() {}
	},
}));

const { PagsMcp } = await import("./index.js");
const { pinnedInstanceFromPath, withPinnedInstance, loadPinnedSurface, pinnedRiskFor } = await import("./pinned.js");

interface FetchStub {
	calls: Array<{ url: string; method: string; body: string | null }>;
	respond: (matcher: (url: string, method: string) => boolean, res: { status?: number; body?: unknown }) => void;
}
function makeFetchStub(): FetchStub {
	const rules: Array<{ match: (u: string, m: string) => boolean; status: number; body: unknown }> = [];
	const stub: FetchStub = {
		calls: [],
		respond(matcher, res) {
			rules.push({ match: matcher, status: res.status ?? 200, body: res.body ?? {} });
		},
	};
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const method = (init?.method || "GET").toUpperCase();
		stub.calls.push({ url, method, body: (init?.body as string | undefined) ?? null });
		const rule = rules.find((r) => r.match(url, method));
		return new Response(JSON.stringify(rule ? rule.body : { ok: true }), {
			status: rule?.status ?? 200,
			headers: { "Content-Type": "application/json" },
		});
	});
	return stub;
}

/** A listing shaped like `GET /v1/instances/:id/tools?allowed=true&schemas=true` answers. */
const LISTING = {
	tools: [
		{
			name: "github_read_issue",
			description: "Read one issue by number.",
			allowed: true,
			mutates: false,
			scope: "read",
			invocableBy: ["chat", "call_instance_tool"],
			jsonSchema: {
				type: "object",
				properties: {
					repo: { type: "string", description: 'The repository, "owner/name".' },
					number: { type: "number", description: "The issue number." },
				},
				required: ["repo", "number"],
			},
		},
		{
			name: "github_create_issue",
			description: "Open an issue.",
			allowed: true,
			mutates: true,
			scope: "write",
			invocableBy: ["chat", "call_instance_tool"],
			jsonSchema: { type: "object", properties: { repo: { type: "string" }, title: { type: "string" } }, required: ["repo", "title"] },
		},
		// Chat-only: the invoker route cannot reach it, so a pinned tool would refuse every call.
		{ name: "write_memory", description: "Remember.", allowed: true, mutates: true, invocableBy: ["chat"], jsonSchema: { type: "object" } },
		// Disallowed rows are not sent by `?allowed=true`, but the registrar must not trust that.
		{ name: "gmail_search", description: "Search mail.", allowed: false, mutates: false, invocableBy: ["chat", "call_instance_tool"] },
		// A row whose name collides with a fixed tool is skipped rather than registered twice.
		{ name: "chat", description: "collides", allowed: true, mutates: false, invocableBy: ["call_instance_tool"] },
	],
};

async function setup(opts: { pinned?: string; scopes?: string[]; authToken?: string | null; listing?: { status?: number; body?: unknown } } = {}) {
	const fetchStub = makeFetchStub();
	const store = new Map<string, string>();
	const kv = {
		get: async (k: string) => store.get(k) ?? null,
		put: async (k: string, v: string) => void store.set(k, v),
		delete: async (k: string) => void store.delete(k),
		list: async () => ({ keys: [], list_complete: true, cursor: undefined, cacheStatus: null }),
	} as unknown as KVNamespace;
	fetchStub.respond((u) => u.includes("/tools?allowed=true&schemas=true"), opts.listing ?? { body: LISTING });
	// The platform-wide path must never be consulted by a pinned session.
	fetchStub.respond((u) => u.endsWith("/v1/instances/my/instances"), { body: { instances: [{ capabilities: { surfaces: ["coding"] } }] } });

	const tools = new Map<string, CapturedTool>();
	const fakeServer = {
		tool() {
			throw new Error("registration must go through the pipeline, not server.tool");
		},
		registerTool(name: string, config: Record<string, unknown>, handler: Handler) {
			tools.set(name, { name, schema: (config.inputSchema as Record<string, unknown>) ?? {}, handler, config });
		},
	};
	// biome-ignore lint/suspicious/noExplicitAny: constructing the mocked-base subclass
	const inst = new (PagsMcp as any)();
	inst.env = { API_BASE: "https://api.test", OAUTH_KV: kv, GITHUB_ORG: "ProAgentStore" };
	inst.props = {
		authToken: opts.authToken === undefined ? "session-token" : opts.authToken,
		mcpScopes: opts.scopes ?? ["read", "write", "runtime", "destructive"],
		mcpSubject: "user-1",
		...(opts.pinned ? { pinnedInstance: opts.pinned } : {}),
	};
	inst.server = fakeServer;
	await inst.init();
	return { inst, tools, fetchStub, auditEvents: () => Array.from(store.values()).map((v) => JSON.parse(v) as Record<string, unknown>) };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("the pinned path (#783)", () => {
	it("reads the instance id off /mcp/i/<id> and nothing else", () => {
		expect(pinnedInstanceFromPath("/mcp/i/inst-123")).toBe("inst-123");
		expect(pinnedInstanceFromPath("/mcp/i/inst-123/")).toBe("inst-123");
		expect(pinnedInstanceFromPath("/mcp")).toBeNull();
		expect(pinnedInstanceFromPath("/mcp/")).toBeNull();
		expect(pinnedInstanceFromPath("/mcp/i/")).toBeNull();
		expect(pinnedInstanceFromPath("/mcp/i/a/b")).toBeNull();
		expect(pinnedInstanceFromPath("/mcp/i/../etc")).toBeNull();
		expect(pinnedInstanceFromPath("/mcp/instances/x")).toBeNull();
	});

	it("rewrites a pinned URL to /mcp and puts the id on ctx.props; passes every other path through untouched", async () => {
		const seen: Array<{ url: string; props: unknown }> = [];
		const inner = {
			fetch: async (req: Request, _env: unknown, ctx: { props?: Record<string, unknown> }) => {
				seen.push({ url: req.url, props: ctx.props });
				return new Response("ok");
			},
		};
		const wrapped = withPinnedInstance(inner as never);
		const grant = { authToken: "t", mcpScopes: ["read"] };

		await wrapped.fetch(new Request("https://mcp.test/mcp/i/inst-9", { method: "POST", body: "{}" }) as never, {} as never, { props: { ...grant } } as never);
		expect(seen[0].url).toBe("https://mcp.test/mcp");
		expect(seen[0].props).toEqual({ ...grant, pinnedInstance: "inst-9" });

		const plain = new Request("https://mcp.test/mcp", { method: "POST", body: "{}" });
		const ctx = { props: { ...grant } };
		await wrapped.fetch(plain as never, {} as never, ctx as never);
		expect(seen[1].url).toBe("https://mcp.test/mcp");
		// Same object, same props: the platform-wide connector is not touched.
		expect(seen[1].props).toBe(ctx.props);
		expect(ctx.props).toEqual(grant);
	});

	it("keeps the query string and method of the rewritten request", async () => {
		let got: Request | undefined;
		const wrapped = withPinnedInstance({ fetch: async (req: Request) => { got = req; return new Response("ok"); } } as never);
		await wrapped.fetch(new Request("https://mcp.test/mcp/i/inst-9?sessionId=abc", { method: "DELETE" }) as never, {} as never, {} as never);
		expect(got?.url).toBe("https://mcp.test/mcp?sessionId=abc");
		expect(got?.method).toBe("DELETE");
	});
});

describe("PagsMcp.init on a pinned session", () => {
	it("registers the instance's invocable tools under their real names plus chat/guide/messages, and NOTHING platform-wide", async () => {
		const { tools, fetchStub } = await setup({ pinned: "inst-1" });
		expect([...tools.keys()].sort()).toEqual(["chat", "github_create_issue", "github_read_issue", "guide", "messages"]);
		// The whole platform-wide surface is absent — not gated, absent.
		for (const name of ["my_instances", "list_agents", "list_instance_tools", "call_instance_tool", "chat_with_instance", "create_agent", "platform_guide"]) {
			expect(tools.has(name), name).toBe(false);
		}
		// It never asked the platform-wide question either.
		expect(fetchStub.calls.some((c) => c.url.endsWith("/v1/instances/my/instances"))).toBe(false);
		expect(fetchStub.calls.filter((c) => c.url.includes("/v1/instances/inst-1/tools?allowed=true&schemas=true"))).toHaveLength(1);
	});

	it("publishes the row's real field names and no instance_id anywhere", async () => {
		const { tools } = await setup({ pinned: "inst-1" });
		const read = tools.get("github_read_issue")!;
		expect(Object.keys(read.schema).sort()).toEqual(["number", "repo"]);
		expect((read.schema.repo as { description?: string }).description).toBe('The repository, "owner/name".');
		for (const [name, t] of tools) {
			expect(Object.keys(t.schema), `${name} publishes instance_id`).not.toContain("instance_id");
			expect(Object.keys(t.schema), `${name} publishes token`).not.toContain("token");
		}
		expect(Object.keys(tools.get("chat")!.schema).sort()).toEqual(["dry_run", "message"]);
		expect(Object.keys(tools.get("messages")!.schema).sort()).toEqual(["before", "limit"]);
		expect(tools.get("guide")!.schema).toEqual({});
	});

	it("announces each row by its own `mutates`, and the fixed three like the tools they stand in for", async () => {
		const { tools } = await setup({ pinned: "inst-1" });
		expect(tools.get("github_read_issue")!.config.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
		expect(tools.get("github_create_issue")!.config.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
		expect(tools.get("chat")!.config.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
		expect(tools.get("guide")!.config.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
		expect(tools.get("messages")!.config.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
		// Every pinned tool carries a title through the same pipeline the platform surface uses.
		for (const [, t] of tools) expect(typeof t.config.title).toBe("string");
		// No pinned tool declares an output schema: the shapes belong to workers/api.
		for (const [, t] of tools) expect(t.config.outputSchema).toBeUndefined();
	});

	it("gates a mutating pinned tool as write and a read as read, and proxies to the invoker route", async () => {
		const readOnly = await setup({ pinned: "inst-1", scopes: ["read"] });
		const denied = await readOnly.tools.get("github_create_issue")!.handler({ repo: "a/b", title: "t" });
		expect(denied.content[0].text).toMatch(/write/);
		expect(readOnly.fetchStub.calls.some((c) => c.url.includes("/tools/github_create_issue"))).toBe(false);

		readOnly.fetchStub.respond((u) => u.includes("/tools/github_read_issue"), { body: { success: true, content: "issue body" } });
		const ok = await readOnly.tools.get("github_read_issue")!.handler({ repo: "a/b", number: 7 });
		expect(ok.content[0].text).toContain("issue body");
		const call = readOnly.fetchStub.calls.find((c) => c.url.includes("/tools/github_read_issue"))!;
		expect(call.method).toBe("POST");
		expect(call.url).toBe("https://api.test/v1/instances/inst-1/tools/github_read_issue");
		// The nested arguments go through as the body, unwrapped — exactly what the route expects.
		expect(JSON.parse(call.body!)).toEqual({ repo: "a/b", number: 7 });
		// Audited under the tool's own name, marked pinned, with the invoker's vocabulary.
		const events = readOnly.auditEvents().filter((e) => e.tool === "github_read_issue");
		expect(events).toHaveLength(1);
		expect(events[0].input).toMatchObject({ instance_id: "inst-1", pinned: true, argKeys: ["repo", "number"] });
		expect(events[0].result).toEqual({ ok: true });
	});

	it("audits a refused call as not ok, the way call_instance_tool does since #726", async () => {
		const h = await setup({ pinned: "inst-1" });
		h.fetchStub.respond((u) => u.includes("/tools/github_create_issue"), { body: { success: false, content: "write consent required" } });
		await h.tools.get("github_create_issue")!.handler({ repo: "a/b", title: "t" });
		expect(h.auditEvents().find((e) => e.tool === "github_create_issue")?.result).toEqual({ ok: false });
	});

	it("chat is gated as runtime, previews on dry_run without touching the network, and posts with origin mcp", async () => {
		const h = await setup({ pinned: "inst-1" });
		const preview = await h.tools.get("chat")!.handler({ message: "hello", dry_run: true });
		expect(JSON.parse(preview.content[0].text)).toMatchObject({ dryRun: true, tool: "chat", wouldDo: { endpoint: "/v1/instances/inst-1/chat", method: "POST" } });
		// The only network the preview may touch is the pipeline's suspension probe (`/v1/auth/me`),
		// which every gated call pays; the instance itself was not asked anything.
		expect(h.fetchStub.calls.filter((c) => !c.url.endsWith("/v1/auth/me")).map((c) => c.url)).toEqual([
			"https://api.test/v1/instances/inst-1/tools?allowed=true&schemas=true",
		]);

		h.fetchStub.respond((u) => u.endsWith("/v1/instances/inst-1/chat"), { body: { message: { content: "hi back", traceId: "tr-1" } } });
		const res = await h.tools.get("chat")!.handler({ message: "hello" });
		expect(res.content[0].text).toBe("hi back");
		const call = h.fetchStub.calls.find((c) => c.url.endsWith("/v1/instances/inst-1/chat"))!;
		expect(JSON.parse(call.body!)).toEqual({ message: "hello", origin: "mcp" });
		// Two `chat` rows by now — the dry run's and the real send's; the trace id is on the second.
		expect(h.auditEvents().find((e) => e.tool === "chat" && e.action === "completed")?.input).toMatchObject({ traceId: "tr-1", pinned: true });

		const noRuntime = await setup({ pinned: "inst-1", scopes: ["read", "write"] });
		const denied = await noRuntime.tools.get("chat")!.handler({ message: "x" });
		expect(denied.content[0].text).toMatch(/runtime/);
	});

	it("guide renders the instance's connection guide and names what this session did NOT register", async () => {
		const h = await setup({ pinned: "inst-1" });
		h.fetchStub.respond((u) => u.endsWith("/v1/instances/inst-1/connection-guide"), { body: { guide: "# Guide" } });
		const res = await h.tools.get("guide")!.handler({});
		expect(res.content[0].text).toContain("# Guide");
		expect(res.content[0].text).toContain("write_memory (chat-only");
		expect(res.content[0].text).toContain("gmail_search (not allowed");
		expect(res.content[0].text).toContain("chat (name reserved");
	});

	it("messages pages with before/limit like instance_messages", async () => {
		const h = await setup({ pinned: "inst-1" });
		await h.tools.get("messages")!.handler({ before: "msg:2026:x y", limit: 5 });
		const call = h.fetchStub.calls.find((c) => c.url.includes("/v1/instances/inst-1/messages"))!;
		expect(call.url).toBe("https://api.test/v1/instances/inst-1/messages?limit=5&before=msg%3A2026%3Ax%20y");
	});

	it("registers exactly one explanatory tool when the instance is not the caller's (403/404)", async () => {
		for (const status of [403, 404]) {
			const h = await setup({ pinned: "not-mine", listing: { status, body: { error: "Not found" } } });
			expect([...h.tools.keys()]).toEqual(["pinned_instance_unavailable"]);
			const res = await h.tools.get("pinned_instance_unavailable")!.handler({});
			expect(res.content[0].text).toMatch(/^Error: /);
			expect(res.content[0].text).toContain("not-mine");
			expect(h.tools.get("pinned_instance_unavailable")!.config.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
			vi.unstubAllGlobals();
		}
	});

	it("registers only the explanatory tool when the session has no token at all", async () => {
		const h = await setup({ pinned: "inst-1", authToken: null });
		expect([...h.tools.keys()]).toEqual(["pinned_instance_unavailable"]);
		expect(h.fetchStub.calls).toHaveLength(0);
	});

	it("registers once even if init runs again", async () => {
		const h = await setup({ pinned: "inst-1" });
		const before = h.tools.size;
		await h.inst.init();
		expect(h.tools.size).toBe(before);
	});
});

describe("loadPinnedSurface / pinnedRiskFor (pure over a fetched listing)", () => {
	it("drops rows the invoker cannot reach, disallowed rows, and reserved names — and says why", async () => {
		makeFetchStub().respond((u) => u.includes("/tools?"), { body: LISTING });
		const surface = await loadPinnedSurface({ API_BASE: "https://api.test" }, "tok", "inst-1");
		expect(surface.rows.map((r) => r.name)).toEqual(["github_read_issue", "github_create_issue"]);
		expect(surface.skipped).toEqual([
			"write_memory (chat-only — ask for it through chat)",
			"gmail_search (not allowed on this instance)",
			"chat (name reserved or not an MCP tool name)",
		]);
		const risk = pinnedRiskFor(surface);
		expect(risk("github_read_issue")).toBe("read");
		expect(risk("github_create_issue")).toBe("write");
		expect(risk("chat")).toBe("runtime");
		expect(risk("guide")).toBe("read");
		expect(risk("messages")).toBe("read");
		expect(risk("nope")).toBeUndefined();
	});

	it("treats a listing without a `tools` array as unavailable rather than as empty", async () => {
		makeFetchStub().respond((u) => u.includes("/tools?"), { body: { something: "else" } });
		const surface = await loadPinnedSurface({ API_BASE: "https://api.test" }, "tok", "inst-1");
		expect(surface.error).toBe("tool listing unavailable");
		expect(surface.rows).toEqual([]);
	});
});
