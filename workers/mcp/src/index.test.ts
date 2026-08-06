import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Test harness ────────────────────────────────────────────────────────────
//
// PagsMcp extends agents/mcp's McpAgent, which needs the Workers runtime. We mock
// the base class as a plain object (so we can construct PagsMcp and drive init()),
// mock the MCP SDK / OAuth provider (they only matter at module load), and stub
// `fetch` (the network boundary). registerInstanceTools / registerStorageTools are
// real (they have their own coverage); here we focus on the tools index.ts itself
// registers + their dispatch, auth, safety gating, and audit.

type ToolContent = { content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolContent>;
interface CapturedTool {
	name: string;
	schema: Record<string, unknown>;
	handler: Handler;
}

const captured = vi.hoisted(() => ({ options: undefined as Record<string, unknown> | undefined }));

vi.mock("@cloudflare/workers-oauth-provider", () => ({
	OAuthProvider: class {
		constructor(options: Record<string, unknown>) {
			captured.options = options;
		}
	},
}));

vi.mock("agents/mcp", () => ({
	// Minimal base: PagsMcp reads this.env / this.props / this.server. We provide a
	// constructor that stores nothing (the subclass field initializers set server),
	// plus the static serve() the module entry calls.
	McpAgent: class {
		env: unknown;
		props: unknown;
		static serve() {
			return { fetch: () => new Response("mock") };
		}
	},
}));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
	// The real McpServer is replaced per-instance in the tests below with a capturing
	// double; this stub just needs to exist so the field initializer doesn't throw.
	McpServer: class {
		tool() {}
	},
}));

const { PagsMcp } = await import("./index.js");
const { MCP_TOOL_ALWAYS_ON, MCP_TOOL_COUNT, MCP_TOOL_GATED } = await import("./tool-count.js");

// A fetch stub with programmable per-path responses (shared shape with the
// instance-tools test).
interface FetchStub {
	calls: Array<{ url: string; method: string; body: string | null; headers: Headers }>;
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
		stub.calls.push({ url, method, body: (init?.body as string | undefined) ?? null, headers: new Headers(init?.headers) });
		const rule = rules.find((r) => r.match(url, method));
		return new Response(JSON.stringify(rule ? rule.body : { ok: true }), {
			status: rule?.status ?? 200,
			headers: { "Content-Type": "application/json" },
		});
	});
	return stub;
}

function makeKv(): { kv: KVNamespace; store: Map<string, string> } {
	const store = new Map<string, string>();
	const kv = {
		get: async (k: string) => store.get(k) ?? null,
		put: async (k: string, v: string) => void store.set(k, v),
		delete: async (k: string) => void store.delete(k),
		list: async ({ prefix = "", limit = 1000 }: { prefix?: string; limit?: number } = {}) => ({
			keys: Array.from(store.keys()).filter((n) => n.startsWith(prefix)).slice(0, limit).map((name) => ({ name })),
			list_complete: true,
			cursor: undefined,
			cacheStatus: null,
		}),
	} as unknown as KVNamespace;
	return { kv, store };
}

interface HarnessOpts {
	groups?: string[]; // console surfaces the connected user has
	scopes?: string[] | null;
	subject?: string;
	authToken?: string | null;
	env?: Record<string, unknown>;
}

async function setup(opts: HarnessOpts = {}) {
	const fetchStub = makeFetchStub();
	const { kv, store } = makeKv();
	const env = {
		API_BASE: "https://api.test",
		OAUTH_KV: kv,
		GITHUB_ORG: "ProAgentStore",
		...opts.env,
	};

	// The user's surfaces are resolved via /v1/instances/my/instances in userGroups().
	fetchStub.respond(
		(u) => u.endsWith("/v1/instances/my/instances"),
		{ body: { instances: (opts.groups ?? []).map((s) => ({ capabilities: { surfaces: [s] } })) } },
	);

	const tools = new Map<string, CapturedTool>();
	const fakeServer = {
		tool(name: string, _desc: string, schema: Record<string, unknown>, handler: Handler) {
			tools.set(name, { name, schema, handler });
		},
	};

	// biome-ignore lint/suspicious/noExplicitAny: constructing the mocked-base subclass
	const inst = new (PagsMcp as any)();
	inst.env = env;
	inst.props = {
		authToken: opts.authToken === undefined ? "session-token" : opts.authToken,
		mcpScopes: opts.scopes ?? ["read", "write", "runtime", "destructive"],
		mcpSubject: opts.subject ?? "user-1",
	};
	inst.server = fakeServer; // replace the real McpServer with our capturing double

	await inst.init();

	return {
		inst,
		tools,
		fetchStub,
		auditStore: store,
		auditEvents: () => Array.from(store.values()).map((v) => JSON.parse(v) as Record<string, unknown>),
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

// ── Registration ─────────────────────────────────────────────────────────────

describe("PagsMcp.init — tool registration", () => {
	it("registers the always-on catalog + creator + account tools", async () => {
		const { tools } = await setup();
		for (const name of [
			"list_agents",
			"agent_info",
			"chat_with_agent",
			"my_agents",
			"mcp_audit_log",
			"get_agent_board_config",
			"update_agent_board_config",
			"create_agent",
			"scaffold_agent",
			"update_agent",
			"add_knowledge",
			"list_knowledge",
			"agent_analytics",
			"platform_guide",
			"sdk_reference",
			"agent_deploy_status",
			"trigger_agent_deploy",
		]) {
			expect(tools.has(name)).toBe(true);
		}
	});

	it("also mounts the instance + storage tool groups (delegated registration)", async () => {
		const { tools } = await setup();
		// from registerInstanceTools
		expect(tools.has("my_instances")).toBe(true);
		expect(tools.has("chat_with_instance")).toBe(true);
		// from registerStorageTools
		expect(tools.has("list_instance_collections")).toBe(true);
	});

	it("gates the coding session tools behind the user's coding surface", async () => {
		const withoutCoding = (await setup({ groups: [] })).tools;
		expect(withoutCoding.has("coding_session_capture")).toBe(false);
		expect(withoutCoding.has("coding_overseer")).toBe(false);

		const withCoding = (await setup({ groups: ["coding"] })).tools;
		expect(withCoding.has("coding_session_capture")).toBe(true);
		expect(withCoding.has("coding_session_message")).toBe(true);
		expect(withCoding.has("coding_diagnostics")).toBe(true);
	});

	it("registers exactly the number of tools it advertises (/health + three docs quote it)", async () => {
		// `GET /health` answered `tools: 41` while 124 were registered, and the test that
		// covered it asserted the 41. A count nobody derives from the registration is a
		// count that rots. These constants are that derivation's fixed point: this test
		// holds them to the REAL init, and scripts/docs-drift.mjs holds every prose claim
		// to the constants. Adding a tool fails here until the number moves.
		const everySurface = (await setup({ groups: ["apply", "repo", "coding"] })).tools;
		expect(everySurface.size).toBe(MCP_TOOL_COUNT);

		// Surface-gated tools are the difference: a user with no matching agent gets the
		// always-on set, which is what makes the surface per-connection.
		const noSurface = (await setup({ groups: [] })).tools;
		expect(noSurface.size).toBe(MCP_TOOL_ALWAYS_ON);
		expect(MCP_TOOL_ALWAYS_ON + MCP_TOOL_GATED).toBe(MCP_TOOL_COUNT);
	});

	it("registers tools only once even if init runs again (idempotent guard)", async () => {
		const h = await setup();
		const before = h.tools.size;
		// Second init must be a no-op (toolsRegistered guard) — re-registering would
		// throw on a real McpServer and hang the stream.
		await h.inst.init();
		expect(h.tools.size).toBe(before);
	});
});

// ── Public (unauthenticated) tools ───────────────────────────────────────────

describe("public catalog tools", () => {
	it("list_agents returns the agents array from the public endpoint (no auth header)", async () => {
		const h = await setup();
		h.fetchStub.respond((u) => u.endsWith("/v1/agents"), { body: { agents: [{ id: "a1" }, { id: "a2" }] } });
		const res = await h.tools.get("list_agents")!.handler({});
		const call = h.fetchStub.calls.find((c) => c.url.endsWith("/v1/agents"))!;
		expect(call.headers.has("Authorization")).toBe(false);
		expect(JSON.parse(res.content[0].text)).toEqual([{ id: "a1" }, { id: "a2" }]);
	});

	it("chat_with_agent posts to the public try endpoint and surfaces the session id", async () => {
		const h = await setup();
		h.fetchStub.respond((u, m) => u.includes("/public/agents/") && u.endsWith("/try") && m === "POST", {
			body: { message: { content: "hello!" }, sessionId: "s-42" },
		});
		const res = await h.tools.get("chat_with_agent")!.handler({ agent_id: "demo", message: "hi" });
		expect(res.content[0].text).toContain("hello!");
		expect(res.content[0].text).toContain("Session: s-42");
		const call = h.fetchStub.calls.find((c) => c.url.includes("/try"))!;
		expect(JSON.parse(call.body!)).toEqual({ message: "hi", sessionId: undefined });
	});

	it("platform_guide + sdk_reference return static docs without any network call", async () => {
		const h = await setup();
		const before = h.fetchStub.calls.length;
		const guide = await h.tools.get("platform_guide")!.handler({});
		const sdk = await h.tools.get("sdk_reference")!.handler({});
		expect(guide.content[0].text).toContain("ProAgentStore Platform Guide");
		expect(sdk.content[0].text).toContain("@proagentstore/sdk");
		expect(h.fetchStub.calls.length).toBe(before);
	});
});

// ── Auth-required tools ──────────────────────────────────────────────────────

describe("authentication", () => {
	it("my_agents refuses without a session token and makes no authed call", async () => {
		const h = await setup({ authToken: null });
		const res = await h.tools.get("my_agents")!.handler({});
		expect(res.content[0].text).toContain("authentication required");
		// only the userGroups() probe (which is also empty for no token) may have run
		expect(h.fetchStub.calls.some((c) => c.url.endsWith("/agents/my/agents"))).toBe(false);
	});

	it("my_agents lists owned agents and reports emptiness distinctly", async () => {
		const empty = await setup();
		empty.fetchStub.respond((u) => u.endsWith("/agents/my/agents"), { body: { agents: [] } });
		expect((await empty.tools.get("my_agents")!.handler({})).content[0].text).toContain("No owned agents");

		const some = await setup();
		some.fetchStub.respond((u) => u.endsWith("/agents/my/agents"), { body: { agents: [{ id: "a1", slug: "x" }] } });
		const res = await some.tools.get("my_agents")!.handler({});
		expect(JSON.parse(res.content[0].text)).toEqual([{ id: "a1", slug: "x" }]);
	});
});

// ── create_agent: write gating + audit + dry-run ─────────────────────────────

describe("create_agent", () => {
	it("POSTs the agent body and audits success", async () => {
		const h = await setup();
		h.fetchStub.respond((u, m) => u.endsWith("/v1/agents") && m === "POST", { body: { id: "ag-1" } });
		const res = await h.tools.get("create_agent")!.handler({
			slug: "job-helper",
			name: "Job Helper",
			description: "Helps.",
		});
		expect(res.content[0].text).toContain("Created: ag-1");
		expect(res.content[0].text).toContain("proagentstore.online/agents/job-helper/");
		const call = h.fetchStub.calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/agents"))!;
		expect(JSON.parse(call.body!)).toMatchObject({ slug: "job-helper", name: "Job Helper" });
		expect(h.auditEvents().some((e) => e.tool === "create_agent" && e.action === "completed")).toBe(true);
	});

	it("is blocked without write scope and does not POST", async () => {
		const h = await setup({ scopes: ["read"] });
		const res = await h.tools.get("create_agent")!.handler({ slug: "x", name: "X" });
		expect(res.content[0].text).toContain('requires MCP scope "write"');
		expect(h.fetchStub.calls.some((c) => c.method === "POST" && c.url.endsWith("/v1/agents"))).toBe(false);
	});

	it("dry-run describes the create without POSTing", async () => {
		const h = await setup();
		const res = await h.tools.get("create_agent")!.handler({ slug: "x", name: "X", dry_run: true });
		const body = JSON.parse(res.content[0].text);
		expect(body).toMatchObject({ dryRun: true, tool: "create_agent" });
		expect(body.wouldDo).toMatchObject({ endpoint: "/v1/agents", method: "POST" });
		expect(h.fetchStub.calls.some((c) => c.method === "POST" && c.url.endsWith("/v1/agents"))).toBe(false);
	});

	it("reports the upstream error when create fails", async () => {
		const h = await setup();
		h.fetchStub.respond((u, m) => u.endsWith("/v1/agents") && m === "POST", { status: 400, body: { error: "slug taken" } });
		const res = await h.tools.get("create_agent")!.handler({ slug: "x", name: "X" });
		expect(res.content[0].text).toContain("Error");
		expect(res.content[0].text).toContain("slug taken");
	});
});

// ── update_agent: only truthy fields are sent ────────────────────────────────

describe("update_agent", () => {
	it("sends only the provided (truthy) fields", async () => {
		const h = await setup();
		h.fetchStub.respond((u, m) => u.includes("/v1/agents/a1") && m === "PUT", { body: { success: true } });
		const res = await h.tools.get("update_agent")!.handler({
			agent_id: "a1",
			name: "New Name",
			description: "",
		});
		const call = h.fetchStub.calls.find((c) => c.method === "PUT")!;
		const body = JSON.parse(call.body!);
		expect(body).toEqual({ name: "New Name" }); // empty description dropped
		expect(res.content[0].text).toBe("Updated");
	});
});

// ── update_agent_board_config: write to /v1/auth/me ──────────────────────────

describe("board config", () => {
	it("get_agent_board_config reads boardConfig from /v1/auth/me", async () => {
		const h = await setup();
		h.fetchStub.respond((u) => u.endsWith("/v1/auth/me"), { body: { boardConfig: { columns: [{ id: "c" }] } } });
		const res = await h.tools.get("get_agent_board_config")!.handler({});
		expect(JSON.parse(res.content[0].text)).toEqual({ columns: [{ id: "c" }] });
	});

	it("update_agent_board_config PUTs board_config and audits", async () => {
		const h = await setup();
		h.fetchStub.respond((u, m) => u.endsWith("/v1/auth/me") && m === "PUT", { body: { success: true } });
		const config = { columns: [{ id: "todo", title: "Todo" }] };
		const res = await h.tools.get("update_agent_board_config")!.handler({ config });
		const call = h.fetchStub.calls.find((c) => c.method === "PUT")!;
		expect(JSON.parse(call.body!)).toEqual({ board_config: config });
		expect(res.content[0].text).toContain("Updated agent board config");
		expect(h.auditEvents().some((e) => e.tool === "update_agent_board_config")).toBe(true);
	});
});

// ── mcp_audit_log: reads back the audit KV, respects read scope ───────────────

describe("mcp_audit_log", () => {
	it("returns audit events written by prior tool calls", async () => {
		const h = await setup();
		// Perform an audited write so there is at least one event.
		h.fetchStub.respond((u, m) => u.endsWith("/v1/agents") && m === "POST", { body: { id: "ag-x" } });
		await h.tools.get("create_agent")!.handler({ slug: "x", name: "X" });

		const res = await h.tools.get("mcp_audit_log")!.handler({ limit: 10 });
		const events = JSON.parse(res.content[0].text) as Array<{ tool?: string }>;
		expect(Array.isArray(events)).toBe(true);
		expect(events.some((e) => e.tool === "create_agent")).toBe(true);
	});

	it("refuses without a token", async () => {
		const h = await setup({ authToken: null });
		const res = await h.tools.get("mcp_audit_log")!.handler({});
		expect(res.content[0].text).toContain("authentication required");
	});
});

// ── coding_session_message: resolves active session, gates as runtime ────────

describe("coding_session_message (coding surface)", () => {
	it("resolves the active session and types into it, auditing on success", async () => {
		const h = await setup({ groups: ["coding"] });
		h.fetchStub.respond((u, m) => u.endsWith("/coding/sessions") && m === "GET", {
			body: { sessions: [{ id: "sess-1", status: "active" }] },
		});
		h.fetchStub.respond((u, m) => u.endsWith("/sess-1/message") && m === "POST", { body: { ok: true } });
		const res = await h.tools.get("coding_session_message")!.handler({ instance_id: "i1", message: "npm test" });
		expect(res.content[0].text).toContain("Sent to session sess-1");
		const post = h.fetchStub.calls.find((c) => c.url.endsWith("/sess-1/message"))!;
		expect(JSON.parse(post.body!)).toEqual({ text: "npm test" });
		expect(h.auditEvents().some((e) => e.tool === "coding_session_message")).toBe(true);
	});

	it("reports no session when none is active, without POSTing", async () => {
		const h = await setup({ groups: ["coding"] });
		h.fetchStub.respond((u, m) => u.endsWith("/coding/sessions") && m === "GET", { body: { sessions: [] } });
		const res = await h.tools.get("coding_session_message")!.handler({ instance_id: "i1", message: "x" });
		expect(res.content[0].text).toContain("No active coding session");
		expect(h.fetchStub.calls.some((c) => c.url.endsWith("/message"))).toBe(false);
	});

	it("surfaces a runner error instead of falsely reporting the command ran", async () => {
		const h = await setup({ groups: ["coding"] });
		h.fetchStub.respond((u, m) => u.endsWith("/coding/sessions") && m === "GET", {
			body: { sessions: [{ id: "sess-1", status: "active" }] },
		});
		h.fetchStub.respond((u, m) => u.endsWith("/sess-1/message") && m === "POST", { status: 502, body: { error: "runner offline" } });
		const res = await h.tools.get("coding_session_message")!.handler({ instance_id: "i1", message: "x" });
		expect(res.content[0].text).toContain("Error sending to session sess-1");
		expect(res.content[0].text).toContain("runner offline");
		// A failed send must NOT be audited as completed.
		expect(h.auditEvents().some((e) => e.tool === "coding_session_message" && e.action === "completed")).toBe(false);
	});

	it("is blocked in read-only mode (typing into a CLI is runtime-scoped)", async () => {
		const h = await setup({ groups: ["coding"], env: { MCP_READ_ONLY: "1" } });
		const res = await h.tools.get("coding_session_message")!.handler({ instance_id: "i1", message: "x" });
		expect(res.content[0].text).toContain("read-only mode");
		expect(h.fetchStub.calls.some((c) => c.url.endsWith("/message"))).toBe(false);
	});
});
