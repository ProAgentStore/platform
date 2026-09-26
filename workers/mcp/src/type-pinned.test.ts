import { afterEach, describe, expect, it, vi } from "vitest";

// ── The agent-type pin (#771) ─────────────────────────────────────────────────
//
// `/mcp/t/<agentSlug>` registers what an agent TYPE declares, each tool under its real name with its
// real fields plus `instance_id`, and routes every call to the named instance with `?agent=<slug>` so
// the API refuses an instance of another type. Held here, like the instance pin in `pinned.test.ts`,
// because its names are data. The same harness as that file.

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
const { withPinnedInstance } = await import("./pinned.js");
const { pinnedTypeFromPath, withPinnedType } = await import("./type-pinned.js");

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

/** `GET /v1/agents/coder/tools?allowed=true&schemas=true`, as the API answers it. */
const TYPE_LISTING = {
	agent: { id: "a-coder", slug: "coder" },
	tools: [
		{
			name: "github_read_issue",
			description: "Read one issue by number.",
			allowed: true,
			mutates: false,
			invocableBy: ["chat", "call_instance_tool"],
			jsonSchema: { type: "object", properties: { repo: { type: "string" }, number: { type: "number" } }, required: ["repo", "number"] },
		},
		{
			name: "github_create_issue",
			description: "Open an issue.",
			allowed: true,
			mutates: true,
			invocableBy: ["chat", "call_instance_tool"],
			jsonSchema: { type: "object", properties: { repo: { type: "string" }, title: { type: "string" } }, required: ["repo", "title"] },
		},
		// Chat-only: the invoker route cannot reach it.
		{ name: "write_memory", allowed: true, mutates: true, invocableBy: ["chat"], jsonSchema: { type: "object" } },
		// A tool with its own instance_id field cannot also take the injected one.
		{ name: "delegate_to", allowed: true, mutates: true, invocableBy: ["call_instance_tool"], jsonSchema: { type: "object", properties: { instance_id: { type: "string" } } } },
	],
};

async function setup(opts: { type?: string; instance?: string; scopes?: string[]; authToken?: string | null; listing?: { status?: number; body?: unknown } } = {}) {
	const fetchStub = makeFetchStub();
	const store = new Map<string, string>();
	const kv = {
		get: async (k: string) => store.get(k) ?? null,
		put: async (k: string, v: string) => void store.set(k, v),
		delete: async (k: string) => void store.delete(k),
		list: async () => ({ keys: [], list_complete: true, cursor: undefined, cacheStatus: null }),
	} as unknown as KVNamespace;
	fetchStub.respond((u) => u.includes("/v1/agents/coder/tools?allowed=true&schemas=true"), opts.listing ?? { body: TYPE_LISTING });
	fetchStub.respond((u) => u.includes("/v1/instances/inst-1/tools?allowed=true&schemas=true"), { body: { tools: [TYPE_LISTING.tools[0]] } });
	fetchStub.respond((u) => new URL(u).pathname === "/v1/instances/my/instances", { body: { instances: [{ capabilities: { surfaces: ["coding"] } }] } });

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
		...(opts.type ? { pinnedType: opts.type } : {}),
		...(opts.instance ? { pinnedInstance: opts.instance } : {}),
	};
	inst.server = fakeServer;
	await inst.init();
	return { inst, tools, fetchStub, auditEvents: () => Array.from(store.values()).map((v) => JSON.parse(v) as Record<string, unknown>) };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("the agent-type path (#771)", () => {
	it("reads a slug off /mcp/t/<slug> and nothing else", () => {
		expect(pinnedTypeFromPath("/mcp/t/coder")).toBe("coder");
		expect(pinnedTypeFromPath("/mcp/t/repo-coder/")).toBe("repo-coder");
		for (const p of ["/mcp", "/mcp/t/", "/mcp/t/a/b", "/mcp/t/Coder", "/mcp/t/../x", "/mcp/i/inst-1"]) expect(pinnedTypeFromPath(p), p).toBeNull();
	});

	it("composed with the instance pin, each path reaches the transport with its OWN prop — and /mcp is untouched", async () => {
		const seen: Array<{ url: string; props: unknown }> = [];
		const inner = { fetch: async (req: Request, _env: unknown, ctx: { props?: Record<string, unknown> }) => { seen.push({ url: req.url, props: ctx.props }); return new Response("ok"); } };
		const wrapped = withPinnedType(withPinnedInstance(inner as never));
		const grant = { authToken: "t" };
		await wrapped.fetch(new Request("https://mcp.test/mcp/t/coder", { method: "POST", body: "{}" }) as never, {} as never, { props: { ...grant } } as never);
		await wrapped.fetch(new Request("https://mcp.test/mcp/i/inst-9", { method: "POST", body: "{}" }) as never, {} as never, { props: { ...grant } } as never);
		const ctx = { props: { ...grant } };
		await wrapped.fetch(new Request("https://mcp.test/mcp", { method: "POST", body: "{}" }) as never, {} as never, ctx as never);
		expect(seen.map((s) => s.url)).toEqual(["https://mcp.test/mcp", "https://mcp.test/mcp", "https://mcp.test/mcp"]);
		expect(seen[0].props).toEqual({ ...grant, pinnedType: "coder" });
		expect(seen[1].props).toEqual({ ...grant, pinnedInstance: "inst-9" });
		expect(seen[2].props).toBe(ctx.props);
	});
});

describe("PagsMcp.init on an agent-type session (#771)", () => {
	it("registers the type's invocable tools plus call_instance_tool — nothing platform-wide, no chat/guide/messages", async () => {
		const { tools, fetchStub } = await setup({ type: "coder" });
		expect([...tools.keys()].sort()).toEqual(["call_instance_tool", "github_create_issue", "github_read_issue"]);
		for (const name of ["my_instances", "list_instance_tools", "chat", "guide", "messages", "chat_with_instance"]) expect(tools.has(name), name).toBe(false);
		expect(fetchStub.calls.filter((c) => c.url.includes("/v1/agents/coder/tools?allowed=true&schemas=true"))).toHaveLength(1);
		expect(fetchStub.calls.some((c) => new URL(c.url).pathname === "/v1/instances/my/instances")).toBe(false);
	});

	it("each tool publishes its real fields and instance_id LAST", async () => {
		const { tools } = await setup({ type: "coder" });
		expect(Object.keys(tools.get("github_read_issue")!.schema)).toEqual(["repo", "number", "instance_id"]);
		expect(Object.keys(tools.get("call_instance_tool")!.schema)).toEqual(["instance_id", "tool", "input"]);
		expect(String(tools.get("call_instance_tool")!.config.description)).toMatch(/delegate_to \(has its own instance_id field/);
	});

	it("announces each tool by its own mutates, and the escape hatch as a write", async () => {
		const { tools } = await setup({ type: "coder" });
		expect(tools.get("github_read_issue")!.config.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
		expect(tools.get("github_create_issue")!.config.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
		expect(tools.get("call_instance_tool")!.config.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
	});

	it("a call goes to the NAMED instance with ?agent=<type>, its own arguments as the body, and is audited", async () => {
		const h = await setup({ type: "coder" });
		h.fetchStub.respond((u) => u.includes("/tools/github_read_issue"), { body: { success: true, content: "issue body" } });
		const res = await h.tools.get("github_read_issue")!.handler({ repo: "a/b", number: 7, instance_id: "inst-2" });
		expect(res.content[0].text).toContain("issue body");
		const call = h.fetchStub.calls.find((c) => c.url.includes("/tools/github_read_issue"))!;
		expect(call.method).toBe("POST");
		expect(call.url).toBe("https://api.test/v1/instances/inst-2/tools/github_read_issue?agent=coder");
		expect(JSON.parse(call.body!)).toEqual({ repo: "a/b", number: 7 });
		const events = h.auditEvents().filter((e) => e.tool === "github_read_issue");
		expect(events[0].input).toMatchObject({ instance_id: "inst-2", agentType: "coder", argKeys: ["repo", "number"] });
	});

	it("an instance of another type is refused by the API, and the refusal reaches the caller", async () => {
		const h = await setup({ type: "coder" });
		h.fetchStub.respond((u) => u.includes("/v1/instances/inst-helper/tools/"), { status: 400, body: { error: "This instance is helper, not coder — a /mcp/t/coder session runs only coder instances. Use /mcp/t/helper for it." } });
		const res = await h.tools.get("github_read_issue")!.handler({ repo: "a/b", number: 1, instance_id: "inst-helper" });
		expect(res.content[0].text).toMatch(/helper, not coder/);
		expect(h.auditEvents().find((e) => e.tool === "github_read_issue")?.result).toEqual({ ok: false });
	});

	it("gates a mutating tool as write — nothing is sent without it", async () => {
		const h = await setup({ type: "coder", scopes: ["read"] });
		const denied = await h.tools.get("github_create_issue")!.handler({ repo: "a/b", title: "t", instance_id: "inst-2" });
		expect(denied.content[0].text).toMatch(/write/);
		expect(h.fetchStub.calls.some((c) => c.url.includes("/tools/github_create_issue"))).toBe(false);
	});

	it("call_instance_tool reaches a tool the type does not declare, still held to the type; a JSON-string input is accepted", async () => {
		const h = await setup({ type: "coder" });
		await h.tools.get("call_instance_tool")!.handler({ instance_id: "inst-2", tool: "find_confirmation_link", input: '{"q":"x"}' });
		const call = h.fetchStub.calls.find((c) => c.url.includes("/tools/find_confirmation_link"))!;
		expect(call.url).toBe("https://api.test/v1/instances/inst-2/tools/find_confirmation_link?agent=coder");
		expect(JSON.parse(call.body!)).toEqual({ q: "x" });
	});

	it("an unknown or unreadable type registers exactly one explanatory tool", async () => {
		const h = await setup({ type: "coder", listing: { status: 404, body: { error: "Agent type not found" } } });
		expect([...h.tools.keys()]).toEqual(["agent_type_unavailable"]);
		expect((await h.tools.get("agent_type_unavailable")!.handler({})).content[0].text).toMatch(/^Error: .*coder/);
	});
});

describe("the other surfaces are unchanged (#771)", () => {
	it("a /mcp/i/<id> session still publishes no instance_id and its own instance's tools", async () => {
		const { tools } = await setup({ instance: "inst-1" });
		expect([...tools.keys()].sort()).toEqual(["chat", "github_read_issue", "guide", "messages"]);
		expect(Object.keys(tools.get("github_read_issue")!.schema)).toEqual(["repo", "number"]);
	});

	it("the platform-wide /mcp still has the two-step list_instance_tools → call_instance_tool, with instance_id", async () => {
		const { tools } = await setup({});
		expect(tools.has("list_instance_tools")).toBe(true);
		expect(Object.keys(tools.get("call_instance_tool")!.schema)).toContain("instance_id");
		expect(tools.has("github_read_issue")).toBe(false);
	});
});
