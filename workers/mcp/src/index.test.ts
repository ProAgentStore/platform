import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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
	/** The full `registerTool` config — description, title, annotations, output schema. */
	config: Record<string, unknown>;
}

const captured = vi.hoisted(() => ({
	options: undefined as Record<string, unknown> | undefined,
	serverOptions: undefined as Record<string, unknown> | undefined,
}));

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
	// double; this stub just needs to exist so the field initializer doesn't throw — and
	// to record the constructor's second argument, which is where server `instructions` go.
	McpServer: class {
		constructor(_info: unknown, options?: Record<string, unknown>) {
			captured.serverOptions = options;
		}
		tool() {}
		registerTool() {}
	},
}));

const { PagsMcp } = await import("./index.js");
const { MCP_TOOL_ALWAYS_ON, MCP_TOOL_COUNT, MCP_TOOL_GATED } = await import("./tool-count.js");
const { annotationsFor, MCP_RISK_COUNTS, SERVER_INSTRUCTIONS, TOOL_RISK } = await import("./tool-metadata.js");

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
	// The double implements `registerTool`, because that is the call the registration
	// pipeline makes (#561) — the SDK's tuple `tool(...)` overload is frozen and cannot
	// carry a title, annotations or an output schema. Capturing the config is what lets
	// the tests below assert the published metadata, not just the handler.
	const fakeServer = {
		tool() {
			throw new Error("registration must go through the pipeline, not server.tool");
		},
		registerTool(name: string, config: Record<string, unknown>, handler: Handler) {
			tools.set(name, {
				name,
				schema: (config.inputSchema as Record<string, unknown>) ?? {},
				handler,
				config,
			});
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
		expect(withCoding.has("coding_loop_trace")).toBe(true);
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
		// `{agents: […]}`, not the bare array it answered with before #561: a tool that
		// declares an outputSchema must return an OBJECT as structuredContent, and the text
		// block carries the same JSON so an existing caller reads the same data.
		expect(JSON.parse(res.content[0].text)).toEqual({ agents: [{ id: "a1" }, { id: "a2" }] });
		expect((res as { structuredContent?: unknown }).structuredContent).toEqual({ agents: [{ id: "a1" }, { id: "a2" }] });
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

	it("platform_guide + sdk_reference return static docs without fetching any content", async () => {
		// These answer from constants — no API round-trip for the content itself. The only
		// call they may make is the suspension probe every tool goes through (#273), so the
		// assertion is "nothing but /v1/auth/me" rather than "no calls at all".
		const h = await setup();
		const before = h.fetchStub.calls.length;
		const guide = await h.tools.get("platform_guide")!.handler({});
		const sdk = await h.tools.get("sdk_reference")!.handler({});
		expect(guide.content[0].text).toContain("ProAgentStore Platform Guide");
		expect(sdk.content[0].text).toContain("@proagentstore/sdk");
		expect(h.fetchStub.calls.slice(before).every((c) => c.url.endsWith("/v1/auth/me"))).toBe(true);
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
		// A bare array until #595. It answers `{total, roster, page, agents}` now: 41 owned agents
		// were 66,013 bytes against a calling host's 64 KiB limit, so the records are paged — and
		// the count and the names ride in front of the page, where a truncating reader still sees
		// them (the #503 rule). The full record, `config` included, is still what `agents` carries;
		// `agent-listing.test.ts` holds that, because no other tool can read that field.
		expect(JSON.parse(res.content[0].text)).toEqual({
			total: 1,
			roster: [{ id: "a1", slug: "x", name: undefined, status: undefined, visibility: undefined }],
			page: { offset: 0, count: 1, of: 1, nextOffset: null, hasMore: false },
			agents: [{ id: "a1", slug: "x" }],
		});
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

	// A JSON *string* is accepted on purpose (models send one for an object param). A
	// string that is not valid JSON is a different case: it used to collapse to
	// `undefined`, so the agent was created with no surfaces, no runtime and no tools[]
	// allowlist — the plain chat agent the tool description promises you avoid — and the
	// call still answered `Created: <id>`. Fail loudly instead. (#325)
	it("accepts capabilities as a JSON string", async () => {
		const h = await setup();
		h.fetchStub.respond((u, m) => u.endsWith("/v1/agents") && m === "POST", { body: { id: "ag-1" } });
		const res = await h.tools.get("create_agent")!.handler({
			slug: "x",
			name: "X",
			capabilities: '{"surfaces":["repo"]}',
		});
		expect(res.content[0].text).toContain("Created: ag-1");
		const call = h.fetchStub.calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/agents"))!;
		expect(JSON.parse(call.body!).capabilities).toEqual({ surfaces: ["repo"] });
	});

	it("refuses malformed capabilities rather than creating a capability-less agent", async () => {
		const h = await setup();
		const res = await h.tools.get("create_agent")!.handler({ slug: "x", name: "X", capabilities: "{surfaces: repo" });
		expect(res.content[0].text).toContain("capabilities must be a JSON object");
		expect(h.fetchStub.calls.some((c) => c.method === "POST" && c.url.endsWith("/v1/agents"))).toBe(false);
	});

	it("refuses malformed settings_schema the same way", async () => {
		const h = await setup();
		const res = await h.tools.get("create_agent")!.handler({ slug: "x", name: "X", settings_schema: "[{id:" });
		expect(res.content[0].text).toContain("settings_schema must be a JSON array");
		expect(h.fetchStub.calls.some((c) => c.method === "POST" && c.url.endsWith("/v1/agents"))).toBe(false);
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

	// ── Waking a sleeping repo (#696) ────────────────────────────────────────
	//
	// This used to answer "No active coding session found." — a caller who asked to talk to an
	// agent, told a fact about our process lifecycle. After the idle reaper has run that is the
	// state a repo spends most of its life in, so the refusal was the common case.

	it("wakes the only repo when nothing is running, and says which conversation it got", async () => {
		const h = await setup({ groups: ["coding"] });
		h.fetchStub.respond((u, m) => u.endsWith("/coding/sessions") && m === "GET", { body: { sessions: [] } });
		h.fetchStub.respond((u, m) => u.endsWith("/coding/repos") && m === "GET", { body: { repos: [{ id: "repo-1", name: "platform" }] } });
		h.fetchStub.respond((u, m) => u.endsWith("/coding/sessions") && m === "POST", {
			body: { session: { id: "sess-9" }, runnerConnected: true, resumed: true, continuity: { mode: "resume", reason: "the previous conversation on this repo was last touched 3 hours ago" } },
		});
		h.fetchStub.respond((u, m) => u.endsWith("/sess-9/message") && m === "POST", { body: { ok: true } });
		const res = await h.tools.get("coding_session_message")!.handler({ instance_id: "i1", message: "keep going" });
		// The wake goes through the continuity policy — no `fresh` flag anywhere near it.
		const open = h.fetchStub.calls.find((c) => c.url.endsWith("/coding/sessions") && c.method === "POST")!;
		expect(JSON.parse(open.body!)).toEqual({ repoId: "repo-1" });
		expect(res.content[0].text).toContain("the previous conversation on this repo was last touched 3 hours ago");
		expect(res.content[0].text).toContain('Sent to session sess-9: "keep going"');
		expect(h.auditEvents().some((e) => e.tool === "coding_session_message" && (e.input as Record<string, unknown>).woke === true)).toBe(true);
	});

	it("asks WHICH repo when several are idle, opening nothing and sending nothing", async () => {
		// Guessing here would type someone's instruction into the wrong checkout and report success.
		const h = await setup({ groups: ["coding"] });
		h.fetchStub.respond((u, m) => u.endsWith("/coding/sessions") && m === "GET", { body: { sessions: [] } });
		h.fetchStub.respond((u, m) => u.endsWith("/coding/repos") && m === "GET", {
			body: { repos: [{ id: "repo-1", name: "platform" }, { id: "repo-2", name: "console" }] },
		});
		const res = await h.tools.get("coding_session_message")!.handler({ instance_id: "i1", message: "x" });
		expect(res.content[0].text).toContain("repo_id: repo-1");
		expect(res.content[0].text).toContain("repo_id: repo-2");
		expect(h.fetchStub.calls.some((c) => c.url.endsWith("/coding/sessions") && c.method === "POST")).toBe(false);
		expect(h.fetchStub.calls.some((c) => c.url.endsWith("/message"))).toBe(false);
	});

	it("says there is no repo at all rather than inventing one", async () => {
		const h = await setup({ groups: ["coding"] });
		h.fetchStub.respond((u, m) => u.endsWith("/coding/sessions") && m === "GET", { body: { sessions: [] } });
		h.fetchStub.respond((u, m) => u.endsWith("/coding/repos") && m === "GET", { body: { repos: [] } });
		const res = await h.tools.get("coding_session_message")!.handler({ instance_id: "i1", message: "x" });
		expect(res.content[0].text).toContain("no repo attached");
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

// ── coding_session_open: the door #408's continuity was behind (#696) ────────

describe("coding_session_open", () => {
	/** One repo, and a server answer the test can vary. */
	function withOneRepo(h: Awaited<ReturnType<typeof setup>>, open: Record<string, unknown>) {
		h.fetchStub.respond((u, m) => u.endsWith("/coding/repos") && m === "GET", { body: { repos: [{ id: "repo-1", name: "platform" }] } });
		h.fetchStub.respond((u, m) => u.endsWith("/coding/sessions") && m === "POST", { body: open });
	}

	it("POSTs WITHOUT `fresh`, so the server's continuity policy decides", async () => {
		// The whole point of the tool. `coding_session_fresh` hardcodes `fresh: true` — correctly,
		// that is what it is for — which left #408's four-day continuity reachable only from the
		// console. `engineId` is absent too: omitting it lets the API fall through to the
		// INSTANCE default, the setting the owner actually controls (#549).
		const h = await setup({ groups: ["coding"] });
		withOneRepo(h, { session: { id: "sess-2" }, runnerConnected: true, resumed: true, continuity: { mode: "resume", reason: "the previous conversation on this repo was last touched 2 hours ago" } });
		const res = await h.tools.get("coding_session_open")!.handler({ instance_id: "i1" });
		const post = h.fetchStub.calls.find((c) => c.url.endsWith("/coding/sessions") && c.method === "POST")!;
		expect(JSON.parse(post.body!)).toEqual({ repoId: "repo-1" });
		// The reason is quoted VERBATIM — the route computes it, and a second phrasing here is how
		// the console and MCP end up telling one user two different stories about one open.
		expect(res.content[0].text).toContain("the previous conversation on this repo was last touched 2 hours ago");
		expect(res.content[0].text).toContain("Continuing this repo's previous conversation on platform");
		expect(res.content[0].text).toContain("session_id sess-2");
		expect(h.auditEvents().some((e) => e.tool === "coding_session_open")).toBe(true);
	});

	it("passes an explicit engine when the caller names one", async () => {
		const h = await setup({ groups: ["coding"] });
		withOneRepo(h, { session: { id: "sess-2" }, continuity: { mode: "fresh", reason: "there was no earlier session on this repo to continue" } });
		await h.tools.get("coding_session_open")!.handler({ instance_id: "i1", repo_id: "repo-7", engine_id: "codex" });
		const post = h.fetchStub.calls.find((c) => c.url.endsWith("/coding/sessions") && c.method === "POST")!;
		expect(JSON.parse(post.body!)).toEqual({ repoId: "repo-7", engineId: "codex" });
	});

	it("reports a clean start as a clean start, with the server's reason", async () => {
		const h = await setup({ groups: ["coding"] });
		withOneRepo(h, { session: { id: "sess-3" }, continuity: { mode: "fresh", reason: "the previous session on this repo ran a different engine" } });
		const res = await h.tools.get("coding_session_open")!.handler({ instance_id: "i1" });
		expect(res.content[0].text).toContain("Started a fresh conversation on platform — the previous session on this repo ran a different engine");
	});

	it("does not claim continuity the runner never confirmed", async () => {
		// `continuity.mode` is a DECISION; `resumed` is the runner saying the engine came up
		// carrying it. Reporting the decision as the outcome is worse than the cold start it hides.
		const h = await setup({ groups: ["coding"] });
		withOneRepo(h, { session: { id: "sess-4" }, resumed: false, continuity: { mode: "resume", reason: "the previous conversation on this repo was last touched 5 hours ago" } });
		const res = await h.tools.get("coding_session_open")!.handler({ instance_id: "i1" });
		expect(res.content[0].text).toContain("the runner did not confirm it came up with it");
	});

	it("asks which repo when several exist, rather than opening one of them", async () => {
		const h = await setup({ groups: ["coding"] });
		h.fetchStub.respond((u, m) => u.endsWith("/coding/repos") && m === "GET", {
			body: { repos: [{ id: "repo-1", name: "platform" }, { id: "repo-2" }] },
		});
		const res = await h.tools.get("coding_session_open")!.handler({ instance_id: "i1" });
		expect(res.content[0].text).toContain("repo_id: repo-1");
		expect(res.content[0].text).toContain("(unnamed) (repo_id: repo-2)");
		expect(h.fetchStub.calls.some((c) => c.url.endsWith("/coding/sessions") && c.method === "POST")).toBe(false);
	});

	it("says a conversation was already open rather than reporting a new one", async () => {
		const h = await setup({ groups: ["coding"] });
		withOneRepo(h, { session: { id: "sess-1" }, reused: true, notice: "It is running codex." });
		const res = await h.tools.get("coding_session_open")!.handler({ instance_id: "i1" });
		expect(res.content[0].text).toContain("Already talking to platform");
		expect(res.content[0].text).toContain("It is running codex.");
	});

	it("warns when no runner is connected instead of implying work is happening", async () => {
		const h = await setup({ groups: ["coding"] });
		withOneRepo(h, { session: { id: "sess-5" }, runnerConnected: false, continuity: { mode: "fresh", reason: "there was no earlier session on this repo to continue" } });
		const res = await h.tools.get("coding_session_open")!.handler({ instance_id: "i1" });
		expect(res.content[0].text).toContain("pags up");
	});

	it("is blocked in read-only mode (opening one launches a CLI on someone's machine)", async () => {
		const h = await setup({ groups: ["coding"], env: { MCP_READ_ONLY: "1" } });
		const res = await h.tools.get("coding_session_open")!.handler({ instance_id: "i1" });
		expect(res.content[0].text).toContain("read-only mode");
		expect(h.fetchStub.calls.some((c) => c.url.endsWith("/coding/sessions") && c.method === "POST")).toBe(false);
	});
});

describe("coding_session_fresh", () => {
	it("asks for a CLEAN session explicitly — the default now continues the last conversation (#408)", async () => {
		// This tool's contract is "clean state, no --resume", and since #408 a new session continues
		// the repo's recent conversation by default. The session it ends a line earlier is the most
		// recent one there is, so without `fresh: true` this tool would hand back the very state it
		// exists to escape — a feature deleted silently by someone else's default.
		const h = await setup({ groups: ["coding"] });
		h.fetchStub.respond((u, m) => u.endsWith("/coding/sessions") && m === "GET", {
			body: { sessions: [{ id: "sess-1", status: "active", repoId: "repo-1" }] },
		});
		h.fetchStub.respond((u, m) => u.endsWith("/sess-1/end") && m === "POST", { body: { ok: true } });
		h.fetchStub.respond((u, m) => u.endsWith("/coding/sessions") && m === "POST", { body: { session: { id: "sess-2" } } });
		await h.tools.get("coding_session_fresh")!.handler({ instance_id: "i1" });
		const post = h.fetchStub.calls.find((c) => c.url.endsWith("/coding/sessions") && c.method === "POST")!;
		expect(JSON.parse(post.body!)).toMatchObject({ repoId: "repo-1", fresh: true });
	});
});

// ── coding_instance_deploy_status (#683) ────────────────────────────────────

describe("coding_instance_deploy_status (coding surface)", () => {
	const RUNS_RESPONSE = {
		workflow_runs: [
			{
				name: "CI",
				conclusion: "success",
				status: "completed",
				updated_at: "2026-08-29T10:00:00Z",
				html_url: "https://github.com/ProAgentStore/platform/actions/runs/1",
				head_sha: "abc1234def",
				head_branch: "main",
				event: "push",
			},
			{
				name: "Deploy API",
				conclusion: null,
				status: "in_progress",
				updated_at: "2026-08-29T10:01:00Z",
				html_url: "https://github.com/ProAgentStore/platform/actions/runs/2",
				head_sha: "abc1234def",
				head_branch: "main",
				event: "push",
			},
		],
	};

	it("returns workflow runs for the instance's registered repo", async () => {
		const h = await setup({ groups: ["coding"], env: { GITHUB_TOKEN: "gh-token" } });
		h.fetchStub.respond((u) => u.includes("/coding/repos"), {
			body: { repos: [{ id: "repo-1", name: "platform", instanceId: "i1", githubRepo: "ProAgentStore/platform" }] },
		});
		h.fetchStub.respond((u) => u.includes("api.github.com"), { body: RUNS_RESPONSE });

		const res = await h.tools.get("coding_instance_deploy_status")!.handler({ instance_id: "i1" });
		expect(res.content[0].text).toContain("ProAgentStore/platform");
		expect(res.content[0].text).toContain("CI");
		expect(res.content[0].text).toContain("success");
		expect(res.content[0].text).toContain("Deploy API");
		expect(res.content[0].text).toContain("in_progress");
		// Should hit GitHub with per_page=10
		const ghCall = h.fetchStub.calls.find((c) => c.url.includes("api.github.com"));
		expect(ghCall?.url).toContain("ProAgentStore/platform");
		expect(ghCall?.url).toContain("per_page=10");
	});

	it("filters by SHA when sha is provided", async () => {
		const h = await setup({ groups: ["coding"], env: { GITHUB_TOKEN: "gh-token" } });
		h.fetchStub.respond((u) => u.includes("/coding/repos"), {
			body: { repos: [{ id: "repo-1", name: "platform", instanceId: "i1", githubRepo: "ProAgentStore/platform" }] },
		});
		h.fetchStub.respond((u) => u.includes("api.github.com"), { body: RUNS_RESPONSE });

		await h.tools.get("coding_instance_deploy_status")!.handler({ instance_id: "i1", sha: "abc1234" });
		const ghCall = h.fetchStub.calls.find((c) => c.url.includes("api.github.com"));
		expect(ghCall?.url).toContain("head_sha=abc1234");
	});

	it("asks which repo when there are several and no repo_id given", async () => {
		const h = await setup({ groups: ["coding"], env: { GITHUB_TOKEN: "gh-token" } });
		h.fetchStub.respond((u) => u.includes("/coding/repos"), {
			body: {
				repos: [
					{ id: "repo-1", name: "platform", instanceId: "i1", githubRepo: "ProAgentStore/platform" },
					{ id: "repo-2", name: "api", instanceId: "i1", githubRepo: "ProAgentStore/api" },
				],
			},
		});

		const res = await h.tools.get("coding_instance_deploy_status")!.handler({ instance_id: "i1" });
		expect(res.content[0].text).toContain("repo_id");
		// Must not touch GitHub when ambiguous
		expect(h.fetchStub.calls.some((c) => c.url.includes("api.github.com"))).toBe(false);
	});

	it("rejects a repo_id not found on the instance", async () => {
		const h = await setup({ groups: ["coding"], env: { GITHUB_TOKEN: "gh-token" } });
		h.fetchStub.respond((u) => u.includes("/coding/repos"), {
			body: { repos: [{ id: "repo-1", name: "platform", instanceId: "i1", githubRepo: "ProAgentStore/platform" }] },
		});

		const res = await h.tools.get("coding_instance_deploy_status")!.handler({ instance_id: "i1", repo_id: "wrong-id" });
		expect(res.content[0].text).toContain("Error");
		expect(res.content[0].text).toContain("wrong-id");
		expect(h.fetchStub.calls.some((c) => c.url.includes("api.github.com"))).toBe(false);
	});

	it("says so when the repo has no GitHub coordinate (local-only checkout)", async () => {
		const h = await setup({ groups: ["coding"], env: { GITHUB_TOKEN: "gh-token" } });
		h.fetchStub.respond((u) => u.includes("/coding/repos"), {
			body: { repos: [{ id: "repo-1", name: "local-project", instanceId: "i1" }] },
		});

		const res = await h.tools.get("coding_instance_deploy_status")!.handler({ instance_id: "i1" });
		expect(res.content[0].text).toContain("local-only");
		expect(h.fetchStub.calls.some((c) => c.url.includes("api.github.com"))).toBe(false);
	});

	it("works in read-only mode — it is a read-only tool, so the scope gate does not block it", async () => {
		const h = await setup({ groups: ["coding"], env: { MCP_READ_ONLY: "1", GITHUB_TOKEN: "gh-token" } });
		h.fetchStub.respond((u) => u.includes("/coding/repos"), {
			body: { repos: [{ id: "repo-1", name: "platform", instanceId: "i1", githubRepo: "ProAgentStore/platform" }] },
		});
		h.fetchStub.respond((u) => u.includes("api.github.com"), { body: { workflow_runs: [] } });

		const res = await h.tools.get("coding_instance_deploy_status")!.handler({ instance_id: "i1" });
		// Should NOT be blocked — read-only mode only blocks write/runtime/destructive.
		expect(res.content[0].text).not.toContain("read-only mode");
		// The GitHub call should still have been made.
		expect(h.fetchStub.calls.some((c) => c.url.includes("api.github.com"))).toBe(true);
	});

	it("is not registered when the user has no coding surface", async () => {
		const h = await setup({ groups: [] });
		expect(h.tools.has("coding_instance_deploy_status")).toBe(false);
	});
});

// ── Operator suspension (#273) ───────────────────────────────────────────────

describe("suspension gate", () => {
	/** Answer /v1/auth/me with 403 — the API's "this account is suspended" verdict. */
	function suspend(h: Awaited<ReturnType<typeof setup>>) {
		h.fetchStub.respond((u) => u.endsWith("/v1/auth/me"), { status: 403, body: { error: "Account suspended" } });
	}

	it("blocks EVERY registered tool, not a hand-picked list", async () => {
		// Prevents the bug this gate exists for: a check written per handler, which left the
		// GitHub-backed tools (they never call the API) uncovered and would leave the next
		// tool added uncovered too. The gate wraps the registrar, so this assertion keeps
		// holding for tools that do not exist yet.
		const h = await setup({ groups: ["apply", "coding", "repo"] });
		suspend(h);
		expect(h.tools.size).toBe(MCP_TOOL_COUNT);
		const escaped: string[] = [];
		for (const [name, tool] of h.tools) {
			const res = await tool.handler({ instance_id: "i1", agent_id: "a1", message: "x", confirm: name });
			if (!res.content?.[0]?.text?.includes("account is suspended")) escaped.push(name);
		}
		expect(escaped).toEqual([]);
	});

	it("stops the GitHub-backed tools before they touch GitHub", async () => {
		// agent_deploy_status is the proof the old coverage was accidental: it takes no
		// token and calls GitHub with the WORKER's credential, so nothing in its request
		// path could ever have consulted users.suspended.
		const h = await setup({ env: { GITHUB_TOKEN: "gh-token" } });
		suspend(h);
		const res = await h.tools.get("agent_deploy_status")!.handler({ agent_id: "my-agent" });
		expect(res.content[0].text).toContain("suspended");
		expect(h.fetchStub.calls.some((c) => c.url.includes("api.github.com"))).toBe(false);
	});

	it("does not block an account in good standing", async () => {
		// Prevents the gate becoming an outage: /v1/auth/me answers 200 by default here and
		// every tool must behave exactly as it did before.
		const h = await setup();
		h.fetchStub.respond((u, m) => u.endsWith("/v1/agents") && m === "GET", { body: { agents: [{ slug: "a" }] } });
		const res = await h.tools.get("list_agents")!.handler({});
		expect(res.content[0].text).toContain("a");
	});

	it("fails open when the API cannot answer", async () => {
		// Prevents an API blip from taking the whole MCP surface down — the same call the
		// API's own suspension gate makes when D1 errors.
		const h = await setup();
		h.fetchStub.respond((u) => u.endsWith("/v1/auth/me"), { status: 500, body: { error: "boom" } });
		const res = await h.tools.get("platform_guide")!.handler({});
		expect(res.content[0].text).toContain("ProAgentStore Platform Guide");
	});
});

// ── Published tool metadata (#561) ───────────────────────────────────────────

describe("registration pipeline", () => {
	it("registers EVERY tool through registerTool, with a description and a title", async () => {
		// The SDK froze the tuple `tool(name, description, shape, cb)` overload at protocol
		// 2025-03-26: on that path `title` is unreachable and `outputSchema` is declared and
		// never assigned. So this is not a style preference — a server registering through it
		// cannot publish anything the spec added since, whatever its call sites say. The
		// pipeline translates all 135 at once, and this asserts across the whole surface
		// rather than a sample, because one tool registered the old way would silently lose
		// its metadata AND its suspension gate.
		const h = await setup({ groups: ["apply", "coding", "repo"] });
		expect(h.tools.size).toBe(MCP_TOOL_COUNT);
		const missing = Array.from(h.tools.values()).filter(
			(t) => typeof t.config.description !== "string" || typeof t.config.title !== "string",
		);
		expect(missing.map((t) => t.name)).toEqual([]);
	});

	it("derives each title from the tool's own name", async () => {
		// Derived, not written down: a renamed tool retitles itself, and no test has to hold
		// 135 strings to the names they belong to.
		const h = await setup({ groups: ["coding"] });
		expect(h.tools.get("list_agents")!.config.title).toBe("List agents");
		expect(h.tools.get("coding_session_capture")!.config.title).toBe("Coding session capture");
		expect(h.tools.get("mcp_audit_log")!.config.title).toBe("MCP audit log");
		expect(h.tools.get("sdk_reference")!.config.title).toBe("SDK reference");
	});

	it("publishes server instructions that name the id-first sequence", async () => {
		// Before #561 the second McpServer argument was absent, so `initialize` carried no
		// instructions at all: 135 tools with no stated ordering, and nothing telling a model
		// that almost every one of them needs an instance id it can only get from my_instances.
		await setup();
		const instructions = captured.serverOptions?.instructions as string | undefined;
		expect(instructions).toBe(SERVER_INSTRUCTIONS);
		// OpenAI's guidance is that the most important details go in the first 512 characters,
		// so the sequence has to survive the cut — not just appear somewhere in the string.
		expect(instructions!.slice(0, 512)).toContain("my_instances");
	});
});

// ── Tool annotations (#561) ──────────────────────────────────────────────────
//
// MCP's annotation defaults are the pessimistic ones (readOnlyHint false, destructiveHint
// true), so publishing nothing presented `list_agents` and `delete_supervision` to a host
// as equally dangerous. What the server now publishes is its OWN enforced classification —
// and these tests hold the published line to the enforced one across the whole registered
// surface, by driving every handler rather than reading the table back to itself.

/** A value the tool's own schema would accept, so a probe fails on the thing it is probing
 *  and not on a missing argument. Same technique as instance-tools/contract.test.ts —
 *  duplicated rather than shared because that file probes the instance registrars directly
 *  and this one probes the whole assembled server. */
// biome-ignore lint/suspicious/noExplicitAny: reading zod's internals is the point
function sampleValue(t: any, bools: boolean): unknown {
	const d = t?._def;
	switch (d?.typeName) {
		case "ZodOptional":
		case "ZodNullable":
		case "ZodDefault":
			return sampleValue(d.innerType, bools);
		case "ZodNumber":
			return 1;
		case "ZodBoolean":
			return bools;
		case "ZodEnum":
			return d.values[0];
		case "ZodArray":
			return [];
		case "ZodRecord":
		case "ZodObject":
			return {};
		case "ZodUnion":
			return sampleValue(d.options[0], bools);
		default:
			return "x";
	}
}

/** `token`, `confirm` and `dry_run` are the probe's own controls. Every other argument is
 *  generated, and booleans are swept BOTH ways: a tool can pick its scope from its
 *  arguments (`apply_to_job` escalates to destructive on a real submit), and the annotation
 *  has to answer for the worst branch. */
function probeArgs(schema: Record<string, unknown>, bools: boolean): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, t] of Object.entries(schema)) {
		if (key === "token" || key === "confirm" || key === "dry_run") continue;
		out[key] = sampleValue(t, bools);
	}
	return out;
}

interface ToolProbe {
	/** The scope the handler actually demands, read out of its refusal. */
	enforced: string;
	/** The exact string it demands in `confirm`, or null. */
	confirm: string | null;
	/** Every HTTP method it issued when driven with full scopes. */
	methods: string[];
}

const ALL_SURFACES = ["apply", "coding", "repo"];

async function probeSurface(): Promise<Map<string, ToolProbe>> {
	const probes = new Map<string, ToolProbe>();
	const rank: Record<string, number> = { none: 0, read: 1, write: 2, runtime: 2, destructive: 3 };

	// Refusals: hold only `read`, then hold everything BUT `read`, and read the demanded
	// scope out of whichever denial comes back.
	for (const scopes of [["read"], ["write", "runtime", "destructive"]]) {
		const h = await setup({ groups: ALL_SURFACES, scopes });
		for (const [name, tool] of h.tools) {
			for (const bools of [false, true]) {
				const res = await tool.handler(probeArgs(tool.schema, bools));
				const demanded = res.content?.[0]?.text?.match(/requires MCP scope "(\w+)"/)?.[1] ?? "none";
				const seen = probes.get(name);
				if (!seen) probes.set(name, { enforced: demanded, confirm: null, methods: [] });
				else if (rank[demanded] > rank[seen.enforced]) seen.enforced = demanded;
			}
		}
	}

	// Full scopes: what it demands in `confirm`, and what it does to the network.
	const h = await setup({ groups: ALL_SURFACES });
	for (const [name, tool] of h.tools) {
		const probe = probes.get(name)!;
		for (const bools of [false, true]) {
			const before = h.fetchStub.calls.length;
			const res = await tool.handler(probeArgs(tool.schema, bools));
			probe.confirm ??= res.content?.[0]?.text?.match(/requires confirm="([^"]+)"/)?.[1] ?? null;
			probe.methods.push(...h.fetchStub.calls.slice(before).map((c) => c.method));
		}
	}
	return probes;
}

describe("tool annotations", () => {
	let probes: Map<string, ToolProbe>;
	beforeAll(async () => {
		probes = await probeSurface();
	});

	it("classifies EVERY registered tool, and classifies nothing else", async () => {
		// ADR 0002: the denominator is available, so use it. A tool added without a class
		// would otherwise be published under the spec's defaults — read-only false,
		// destructive true — silently, which is the state this issue exists to end.
		expect(probes.size).toBe(MCP_TOOL_COUNT);
		const unclassified = Array.from(probes.keys()).filter((name) => !TOOL_RISK[name]);
		expect(unclassified).toEqual([]);
		const orphans = Object.keys(TOOL_RISK).filter((name) => !probes.has(name));
		expect(orphans).toEqual([]);
	});

	it("never announces a tool as safer than the gate it enforces", async () => {
		// The load-bearing assertion. The announced class may be STRICTER than the gate —
		// `remove_repo` is destructive on one argument path and gets the worse annotation —
		// but never laxer, in either direction of the pair.
		const allowed: Record<string, string[]> = {
			none: ["read", "write", "runtime", "destructive"],
			read: ["read", "write", "runtime", "destructive"],
			write: ["write", "runtime", "destructive"],
			runtime: ["runtime", "destructive"],
			destructive: ["destructive"],
		};
		const lax: string[] = [];
		for (const [name, probe] of probes) {
			if (!allowed[probe.enforced].includes(TOOL_RISK[name])) {
				lax.push(`${name}: enforces ${probe.enforced}, announces ${TOOL_RISK[name]}`);
			}
		}
		expect(lax).toEqual([]);
	});

	it("lets no read-only tool touch the network with anything but a GET", async () => {
		// The only mechanical check on the 58 tools that carry no gate at all: "ungated" is
		// not "read-only", and this is what tells the two apart. It falsifies in the
		// dangerous direction only — a GET-only probe proves nothing, a POST disproves the
		// claim. `chat_with_agent` is ungated and POSTs, which is exactly why it is not
		// announced read-only.
		//
		// Two exemptions, because the API expresses a vector query as a request BODY. Each
		// is asserted to still be necessary, so it cannot outlive the POST that justified it.
		const QUERY_BY_POST = ["search_agent_knowledge", "search_instance_knowledge"];
		const writers: string[] = [];
		for (const [name, probe] of probes) {
			if (annotationsFor(name)?.readOnlyHint !== true) continue;
			if (QUERY_BY_POST.includes(name)) continue;
			const nonGet = probe.methods.filter((m) => m !== "GET");
			if (nonGet.length > 0) writers.push(`${name}: ${nonGet.join(",")}`);
		}
		expect(writers).toEqual([]);
		for (const name of QUERY_BY_POST) {
			expect(TOOL_RISK[name]).toBe("read");
			expect(probes.get(name)!.methods).toContain("POST");
		}
	});

	it("promises non-destructive only where the server itself grants the call by default", async () => {
		// `destructiveHint: false` is a claim, and this is what backs it: the tool is not
		// destructive-scoped (so a DEFAULT connection may run it — `DEFAULT_SCOPES` excludes
		// `destructive` deliberately) and it demands no confirmation string. Both were the
		// server's own judgement long before a host could read it.
		const overclaimed: string[] = [];
		for (const [name, probe] of probes) {
			if (annotationsFor(name)?.destructiveHint !== false) continue;
			if (probe.enforced === "destructive" || probe.confirm) {
				overclaimed.push(`${name}: enforced ${probe.enforced}, confirm ${probe.confirm}`);
			}
		}
		expect(overclaimed).toEqual([]);
	});

	it("publishes the annotations on the registration itself", async () => {
		const h = await setup({ groups: ALL_SURFACES });
		expect(h.tools.get("list_agents")!.config.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
		expect(h.tools.get("add_knowledge")!.config.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
		// A runtime tool states only what it can stand behind: it types into a live CLI, so
		// "MAY perform destructive updates" is true of it and is declared, not left to the
		// spec's default — Anthropic's directory policy asks for the declaration.
		expect(h.tools.get("coding_session_message")!.config.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
		expect(h.tools.get("cancel_instance")!.config.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
		// Never guessed, anywhere on the surface: PAGS has no notion of idempotency and no
		// per-tool record of which tools reach an external system.
		for (const tool of h.tools.values()) {
			expect(tool.config.annotations).not.toHaveProperty("idempotentHint");
			expect(tool.config.annotations).not.toHaveProperty("openWorldHint");
		}
	});

	it("keeps the split where it is, in both directions", async () => {
		// Losing a read-only annotation is as much a regression as gaining a wrong one, and
		// neither shows up in a per-tool assertion. A count has to be moved on purpose.
		const counts: Record<string, number> = { read: 0, write: 0, runtime: 0, destructive: 0 };
		for (const name of probes.keys()) counts[TOOL_RISK[name]]++;
		expect(counts).toEqual(MCP_RISK_COUNTS);
	});

	it("is advisory: nothing that gates or handles a call reads the annotation", async () => {
		// AC#5. The annotation is a claim ABOUT the gate, and the moment something consults
		// it instead of `safety.ts`, a wrong table entry stops being a mislabelled tool and
		// becomes an open door. Only the registration seam and the /surface informational
		// route may import this module.
		//
		// `oauth-provider.ts` is the one exception: its /surface route serves SERVER_INSTRUCTIONS
		// verbatim so an owner can read what their MCP clients are told (#753). It reads no
		// annotation (TOOL_RISK, annotationsFor) — only the instructions string. That is a
		// read-only data serve, not a gate, and the test below could be tightened to check
		// TOOL_RISK / annotationsFor specifically if the module grows further non-advisory exports.
		const dir = new URL(".", import.meta.url).pathname;
		const files: string[] = [];
		const walk = (path: string) => {
			for (const entry of readdirSync(path, { withFileTypes: true })) {
				if (entry.isDirectory()) walk(`${path}${entry.name}/`);
				else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) files.push(`${path}${entry.name}`);
			}
		};
		walk(dir);
		const importers = files
			.filter((f) => readFileSync(f, "utf8").includes('from "./tool-metadata.js"'))
			.map((f) => f.slice(dir.length));
		expect(importers.sort()).toEqual(["index.ts", "oauth-provider.ts", "registration.ts"]);
	});
});
