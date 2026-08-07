import { afterEach, describe, expect, it, vi } from "vitest";
import { registerInstanceTools } from "./instance-tools/index.js";
import type { McpEnv } from "./http.js";
import type { SafetyContext } from "./safety.js";

// ── Test harness ────────────────────────────────────────────────────────────
//
// The instance tools are thin authenticated proxies over the REST API with a
// safety gate (scope / read-only / confirmation / dry-run) and audit logging.
// We drive them end-to-end through the REAL safety helpers and the REAL http.ts
// `authedCall`, mocking only the true boundaries: `fetch` (the network) and a KV
// (the audit store). That exercises the tool logic, the gate, and the audit path
// for real — nothing under test is stubbed out.

type ToolContent = { content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolContent>;
interface CapturedTool {
	name: string;
	description: string;
	schema: Record<string, unknown>;
	handler: Handler;
}

/** A fetch stub whose per-path responses tests can program. */
interface FetchStub {
	calls: Array<{ url: string; method: string; body: string | null; headers: Headers }>;
	respond: (matcher: (url: string, method: string) => boolean, res: { status?: number; body?: unknown }) => void;
	default: { status: number; body: unknown };
}

function makeFetchStub(): FetchStub {
	const rules: Array<{ match: (u: string, m: string) => boolean; status: number; body: unknown }> = [];
	const stub: FetchStub = {
		calls: [],
		default: { status: 200, body: { ok: true } },
		respond(matcher, res) {
			rules.push({ match: matcher, status: res.status ?? 200, body: res.body ?? {} });
		},
	};
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const method = (init?.method || "GET").toUpperCase();
		const body = (init?.body as string | undefined) ?? null;
		stub.calls.push({ url, method, body, headers: new Headers(init?.headers) });
		const rule = rules.find((r) => r.match(url, method));
		const status = rule?.status ?? stub.default.status;
		const payload = rule ? rule.body : stub.default.body;
		return new Response(JSON.stringify(payload), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	});
	return stub;
}

/** In-memory KV that captures audit writes so we can assert on them. */
function makeKv(): { kv: KVNamespace; store: Map<string, string> } {
	const store = new Map<string, string>();
	const kv = {
		get: async (key: string) => store.get(key) ?? null,
		put: async (key: string, value: string) => {
			store.set(key, value);
		},
		delete: async (key: string) => {
			store.delete(key);
		},
		list: async ({ prefix = "", limit = 1000 }: { prefix?: string; limit?: number } = {}) => ({
			keys: Array.from(store.keys())
				.filter((n) => n.startsWith(prefix))
				.slice(0, limit)
				.map((name) => ({ name })),
			list_complete: true,
			cursor: undefined,
			cacheStatus: null,
		}),
	} as unknown as KVNamespace;
	return { kv, store };
}

interface HarnessOpts {
	groups?: string[];
	scopes?: string[] | null;
	readOnly?: boolean;
	subject?: string;
	env?: McpEnv;
	token?: string | null;
}

interface Harness {
	tools: Map<string, CapturedTool>;
	fetchStub: FetchStub;
	auditStore: Map<string, string>;
	auditEvents(): Record<string, unknown>[];
}

function setup(opts: HarnessOpts = {}): Harness {
	const fetchStub = makeFetchStub();
	const { kv, store } = makeKv();
	const env: McpEnv = { API_BASE: "https://api.test", OAUTH_KV: kv, ...opts.env };
	if (opts.readOnly) env.MCP_READ_ONLY = "1";

	const tools = new Map<string, CapturedTool>();
	const fakeServer = {
		tool(name: string, description: string, schema: Record<string, unknown>, handler: Handler) {
			tools.set(name, { name, description, schema, handler });
		},
	};

	const token = opts.token === undefined ? "session-token" : opts.token;
	const tokenFor = (provided?: string) => provided || token;
	const safetyFor = (provided?: string): SafetyContext => ({
		env,
		subject: provided ? undefined : opts.subject ?? "user-1",
		scopes: provided ? null : opts.scopes ?? ["read", "write", "runtime", "destructive"],
	});

	registerInstanceTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server
		fakeServer as any,
		env,
		tokenFor,
		safetyFor,
		new Set(opts.groups ?? []),
	);

	return {
		tools,
		fetchStub,
		auditStore: store,
		auditEvents() {
			return Array.from(store.values()).map((v) => JSON.parse(v) as Record<string, unknown>);
		},
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

// ── Registration / gating shape ──────────────────────────────────────────────

describe("registerInstanceTools — registration + surface gating", () => {
	it("always registers the core (surface-independent) instance tools", () => {
		const { tools } = setup();
		for (const name of [
			"list_instance_tools",
			"call_instance_tool",
			"subscribe_agent",
			"my_instances",
			"chat_with_instance",
			"instance_board",
			"get_instance_memory",
			"write_instance_memory",
			"delete_instance_memory",
		]) {
			expect(tools.has(name)).toBe(true);
		}
		// A core tool exposes its documented input fields to the client.
		expect(Object.keys(tools.get("chat_with_instance")!.schema)).toEqual(
			expect.arrayContaining(["token", "instance_id", "message", "dry_run"]),
		);
	});

	it("gates apply/repo/coding tools behind the user's console surfaces", () => {
		const none = setup({ groups: [] }).tools;
		expect(none.has("apply_to_job")).toBe(false);
		expect(none.has("upload_resume")).toBe(false);
		expect(none.has("get_profile")).toBe(false);
		expect(none.has("ingest_repo")).toBe(false);
		expect(none.has("system_status")).toBe(false);
		expect(none.has("get_apply_tips")).toBe(false);

		const apply = setup({ groups: ["apply"] }).tools;
		expect(apply.has("apply_to_job")).toBe(true);
		expect(apply.has("upload_resume")).toBe(true);
		expect(apply.has("get_apply_tips")).toBe(true);
		expect(apply.has("ingest_repo")).toBe(false); // repo tools still hidden

		const repo = setup({ groups: ["repo"] }).tools;
		expect(repo.has("ingest_repo")).toBe(true);
		expect(repo.has("ingest_repo_status")).toBe(true);
		expect(repo.has("remove_repo")).toBe(true);
		expect(repo.has("apply_to_job")).toBe(false);

		const coding = setup({ groups: ["coding"] }).tools;
		expect(coding.has("system_status")).toBe(true);
		expect(coding.has("apply_to_job")).toBe(false);
	});
});

// ── Auth: no session token → authRequired, no network ────────────────────────

describe("authentication", () => {
	it("returns the auth-required error and makes no API call when unauthenticated", async () => {
		const h = setup({ token: null });
		const res = await h.tools.get("my_instances")!.handler({});
		expect(res.content[0].text).toContain("authentication required");
		expect(h.fetchStub.calls).toHaveLength(0);
	});

	it("prefers an explicitly provided token over the connection token", async () => {
		const h = setup({ token: "conn-token" });
		h.fetchStub.respond((u) => u.endsWith("/knowledge"), { body: { documents: [] } });
		await h.tools.get("list_instance_knowledge")!.handler({ instance_id: "i1", token: "explicit-token" });
		expect(h.fetchStub.calls).toHaveLength(1);
		expect(h.fetchStub.calls[0].headers.get("Authorization")).toBe("Bearer explicit-token");
	});
});

// ── Read proxies: correct route + method, bearer header ──────────────────────

describe("read proxies", () => {
	it("my_instances GETs the instances route and returns the array", async () => {
		const h = setup();
		const instances = [{ id: "i1", agent_id: "a1", status: "active" }];
		h.fetchStub.respond((u) => u.endsWith("/v1/instances/my/instances"), { body: { instances } });
		const res = await h.tools.get("my_instances")!.handler({});
		expect(h.fetchStub.calls[0].url).toBe("https://api.test/v1/instances/my/instances");
		expect(h.fetchStub.calls[0].method).toBe("GET");
		expect(h.fetchStub.calls[0].headers.get("Authorization")).toBe("Bearer session-token");
		expect(JSON.parse(res.content[0].text)).toEqual(instances);
	});

	it("my_instances reports a friendly message when there are no instances", async () => {
		const h = setup();
		h.fetchStub.respond((u) => u.endsWith("/my/instances"), { body: { instances: [] } });
		const res = await h.tools.get("my_instances")!.handler({});
		expect(res.content[0].text).toContain("No subscribed instances");
		expect(h.fetchStub.calls).toHaveLength(1);
	});

	it("my_instances surfaces an upstream error string", async () => {
		const h = setup();
		h.fetchStub.respond((u) => u.endsWith("/my/instances"), { status: 500, body: { error: "boom" } });
		const res = await h.tools.get("my_instances")!.handler({});
		expect(res.content[0].text).toContain("Error");
		expect(res.content[0].text).toContain("boom");
	});

	it("instance_messages encodes the limit query param", async () => {
		const h = setup();
		h.fetchStub.respond((u) => u.includes("/messages"), { body: { messages: [] } });
		await h.tools.get("instance_messages")!.handler({ instance_id: "i1", limit: 7 });
		expect(h.fetchStub.calls[0].url).toBe("https://api.test/v1/instances/i1/messages?limit=7");
	});

	it("agent_trace builds a filtered query string", async () => {
		const h = setup();
		h.fetchStub.respond((u) => u.includes("/trace"), { body: { events: [] } });
		await h.tools.get("agent_trace")!.handler({
			instance_id: "i/1",
			trace_id: "t1",
			source: "apply",
			level: "error",
			limit: 50,
		});
		const url = new URL(h.fetchStub.calls[0].url);
		// instance id is URL-encoded into the path (encodeURIComponent → %2F)
		expect(url.pathname).toBe("/v1/instances/i%2F1/trace");
		expect(url.searchParams.get("trace_id")).toBe("t1");
		expect(url.searchParams.get("source")).toBe("apply");
		expect(url.searchParams.get("level")).toBe("error");
		expect(url.searchParams.get("limit")).toBe("50");
	});

	it("list_errors only sets query params that were provided", async () => {
		const h = setup();
		h.fetchStub.respond((u) => u.includes("/v1/errors"), { body: { errors: [] } });
		await h.tools.get("list_errors")!.handler({ scope: "all", source: "auth" });
		const url = new URL(h.fetchStub.calls[0].url);
		expect(url.searchParams.get("scope")).toBe("all");
		expect(url.searchParams.get("source")).toBe("auth");
		expect(url.searchParams.has("limit")).toBe(false);
	});

	it("list_errors defaults to your own scope (no scope param) when scope=me", async () => {
		const h = setup();
		h.fetchStub.respond((u) => u.includes("/v1/errors"), { body: { errors: [] } });
		await h.tools.get("list_errors")!.handler({ scope: "me" });
		expect(h.fetchStub.calls[0].url).toBe("https://api.test/v1/errors");
	});
});

// ── search_instance_knowledge: POST body shape ───────────────────────────────

describe("search_instance_knowledge", () => {
	it("POSTs the query with a default top_k", async () => {
		const h = setup();
		h.fetchStub.respond((u) => u.endsWith("/search"), { body: { matches: [] } });
		await h.tools.get("search_instance_knowledge")!.handler({ instance_id: "i1", query: "how does auth work" });
		const call = h.fetchStub.calls[0];
		expect(call.url).toBe("https://api.test/v1/instances/i1/search");
		expect(call.method).toBe("POST");
		expect(JSON.parse(call.body!)).toEqual({ query: "how does auth work", top_k: 5 });
	});

	it("honors an explicit top_k", async () => {
		const h = setup();
		h.fetchStub.respond((u) => u.endsWith("/search"), { body: {} });
		await h.tools.get("search_instance_knowledge")!.handler({ instance_id: "i1", query: "x", top_k: 12 });
		expect(JSON.parse(h.fetchStub.calls[0].body!).top_k).toBe(12);
	});
});

// ── Write tools: scope gating + audit ────────────────────────────────────────

describe("write tools — scope gating + audit", () => {
	it("add_instance_knowledge POSTs the doc and audits a completed write", async () => {
		const h = setup();
		h.fetchStub.respond((u, m) => u.endsWith("/knowledge") && m === "POST", { body: { id: "doc-9" } });
		const res = await h.tools.get("add_instance_knowledge")!.handler({
			instance_id: "i1",
			title: "Notes",
			content: "hello world",
		});
		const call = h.fetchStub.calls[0];
		expect(call.url).toBe("https://api.test/v1/instances/i1/knowledge");
		expect(call.method).toBe("POST");
		expect(JSON.parse(call.body!)).toMatchObject({ title: "Notes", content: "hello world", source: "mcp" });
		expect(res.content[0].text).toContain("Added to instance: Notes");
		const events = h.auditEvents();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ tool: "add_instance_knowledge", action: "completed" });
	});

	it("add_instance_knowledge does NOT audit when the API returns an error", async () => {
		const h = setup();
		h.fetchStub.respond((u) => u.endsWith("/knowledge"), { status: 400, body: { error: "bad" } });
		const res = await h.tools.get("add_instance_knowledge")!.handler({
			instance_id: "i1",
			title: "T",
			content: "c",
		});
		expect(res.content[0].text).toContain("Error");
		expect(h.auditEvents()).toHaveLength(0);
	});

	it("blocks a write when the scope is missing, and never calls the API", async () => {
		const h = setup({ scopes: ["read"] });
		const res = await h.tools.get("add_instance_knowledge")!.handler({
			instance_id: "i1",
			title: "T",
			content: "c",
		});
		expect(res.content[0].text).toContain('requires MCP scope "write"');
		expect(h.fetchStub.calls).toHaveLength(0);
		// the denial itself is audited
		const events = h.auditEvents();
		expect(events.some((e) => e.action === "denied" && e.reason === "missing_scope")).toBe(true);
	});

	it("blocks a write in read-only mode", async () => {
		const h = setup({ readOnly: true });
		const res = await h.tools.get("write_instance_memory")!.handler({
			instance_id: "i1",
			key: "k",
			type: "context",
			content: "v",
		});
		expect(res.content[0].text).toContain("read-only mode");
		expect(h.fetchStub.calls).toHaveLength(0);
	});

	it("write_instance_memory PUTs the entry tagged source:user", async () => {
		const h = setup();
		h.fetchStub.respond((u, m) => u.endsWith("/memory") && m === "PUT", { body: { ok: true } });
		await h.tools.get("write_instance_memory")!.handler({
			instance_id: "i1",
			key: "fav_color",
			type: "preference",
			content: "blue",
		});
		const call = h.fetchStub.calls[0];
		expect(call.method).toBe("PUT");
		expect(JSON.parse(call.body!)).toEqual({ key: "fav_color", type: "preference", content: "blue", source: "user" });
	});

	it("set_instance_model PUTs the model to the instance /state and audits (#151)", async () => {
		const h = setup();
		h.fetchStub.respond((u, m) => u.endsWith("/state") && m === "PUT", { body: { ok: true } });
		const res = await h.tools.get("set_instance_model")!.handler({
			instance_id: "i1",
			model: "@cf/meta/llama-4-scout-17b-16e-instruct",
		});
		const call = h.fetchStub.calls[0];
		expect(call.url).toBe("https://api.test/v1/instances/i1/state");
		expect(call.method).toBe("PUT");
		expect(JSON.parse(call.body!)).toEqual({ model: "@cf/meta/llama-4-scout-17b-16e-instruct" });
		expect((res as { content: { text: string }[] }).content[0].text).not.toContain("Error");
		expect(h.auditEvents().some((e) => e.tool === "set_instance_model" && e.action === "completed")).toBe(true);
	});

	it("set_instance_model rejects an empty model without calling the API", async () => {
		const h = setup();
		const res = await h.tools.get("set_instance_model")!.handler({ instance_id: "i1", model: "   " });
		expect((res as { content: { text: string }[] }).content[0].text).toContain("non-empty");
		expect(h.fetchStub.calls).toHaveLength(0);
	});

	it("set_instance_model is gated behind the write scope", async () => {
		const h = setup({ scopes: ["read"] });
		const res = await h.tools.get("set_instance_model")!.handler({ instance_id: "i1", model: "claude-sonnet-4-6" });
		expect((res as { content: { text: string }[] }).content[0].text).toContain('requires MCP scope "write"');
		expect(h.fetchStub.calls).toHaveLength(0);
	});

	it("set_translation_config sends only the patched fields", async () => {
		const h = setup();
		h.fetchStub.respond((u) => u.endsWith("/translation"), { body: { ok: true } });
		await h.tools.get("set_translation_config")!.handler({
			instance_id: "i1",
			enabled: true,
			target: "English",
			word_tap: false,
		});
		const body = JSON.parse(h.fetchStub.calls[0].body!);
		expect(body).toEqual({ enabled: true, target: "English", wordTap: false });
		expect(body).not.toHaveProperty("fontSize");
	});

	it("create_instance_trigger normalizes the snake_case config into camelCase", async () => {
		const h = setup();
		h.fetchStub.respond((u) => u.endsWith("/v1/triggers") , { body: { id: "trg1" } });
		await h.tools.get("create_instance_trigger")!.handler({
			instance_id: "i1",
			name: "Daily sync",
			type: "cron",
			action: "sync_connector",
			schedule: "@daily",
			config: { provider: "google_drive", grant_id: "g1", folder_id: "f1", source_url: "http://x" },
		});
		const body = JSON.parse(h.fetchStub.calls[0].body!);
		expect(body).toMatchObject({
			instanceId: "i1",
			name: "Daily sync",
			type: "cron",
			action: "sync_connector",
			schedule: "@daily",
			config: { provider: "google_drive", grantId: "g1", folderId: "f1", sourceUrl: "http://x" },
		});
	});
});

// ── Dry run: no API call, audited as dry_run ─────────────────────────────────

describe("dry-run mode", () => {
	it("returns a wouldDo plan and never calls the API", async () => {
		const h = setup();
		const res = await h.tools.get("add_instance_knowledge")!.handler({
			instance_id: "i1",
			title: "T",
			content: "some content here",
			dry_run: true,
		});
		const body = JSON.parse(res.content[0].text);
		expect(body).toMatchObject({ dryRun: true, tool: "add_instance_knowledge" });
		expect(body.wouldDo).toMatchObject({ endpoint: "/v1/instances/i1/knowledge", title: "T", source: "mcp" });
		expect(h.fetchStub.calls).toHaveLength(0);
		expect(h.auditEvents().some((e) => e.action === "dry_run")).toBe(true);
	});

	it("apply_to_job dry-run describes a fill-only vs submit run and does not hit /apply", async () => {
		const h = setup({ groups: ["apply"] });
		const res = await h.tools.get("apply_to_job")!.handler({
			instance_id: "i1",
			url: "https://jobs.example/apply/1",
			submit: false,
			dry_run: true,
		});
		const body = JSON.parse(res.content[0].text);
		expect(body.dryRun).toBe(true);
		expect(body.action).toContain("stops before submit");
		expect(h.fetchStub.calls).toHaveLength(0);
	});
});

// ── Destructive tools: require confirmation ──────────────────────────────────

describe("destructive tools — confirmation gate", () => {
	it("cancel_instance refuses without the exact confirm string", async () => {
		const h = setup();
		const res = await h.tools.get("cancel_instance")!.handler({ instance_id: "i1" });
		expect(res.content[0].text).toContain('confirm="cancel_instance"');
		expect(h.fetchStub.calls).toHaveLength(0);
		expect(h.auditEvents().some((e) => e.reason === "missing_confirmation")).toBe(true);
	});

	it("cancel_instance proceeds with the confirm string and audits success", async () => {
		const h = setup();
		h.fetchStub.respond((u, m) => u.endsWith("/cancel") && m === "POST", { body: { success: true } });
		const res = await h.tools.get("cancel_instance")!.handler({ instance_id: "i1", confirm: "cancel_instance" });
		expect(res.content[0].text).toBe("Canceled");
		expect(h.fetchStub.calls[0].url).toBe("https://api.test/v1/instances/i1/cancel");
		expect(h.auditEvents().some((e) => e.tool === "cancel_instance" && e.action === "completed")).toBe(true);
	});

	it("delete_instance_knowledge requires destructive scope AND confirmation", async () => {
		// Missing destructive scope → blocked before confirmation is even considered.
		const noScope = setup({ scopes: ["read", "write", "runtime"] });
		const denied = await noScope.tools.get("delete_instance_knowledge")!.handler({
			instance_id: "i1",
			document_id: "d1",
		});
		expect(denied.content[0].text).toContain('requires MCP scope "destructive"');
		expect(noScope.fetchStub.calls).toHaveLength(0);

		// With scope but no confirm → confirmation error.
		const ok = setup();
		const needsConfirm = await ok.tools.get("delete_instance_knowledge")!.handler({
			instance_id: "i1",
			document_id: "d1",
		});
		expect(needsConfirm.content[0].text).toContain('confirm="delete_instance_knowledge"');

		// With scope + confirm → DELETE fires.
		ok.fetchStub.respond((_u, m) => m === "DELETE", { body: { ok: true } });
		await ok.tools.get("delete_instance_knowledge")!.handler({
			instance_id: "i1",
			document_id: "d1",
			confirm: "delete_instance_knowledge",
		});
		expect(ok.fetchStub.calls[0].method).toBe("DELETE");
		expect(ok.fetchStub.calls[0].url).toBe("https://api.test/v1/instances/i1/knowledge/d1");
	});
});

// ── subscribe_agent: happy path + already-subscribed fallback ─────────────────

describe("subscribe_agent", () => {
	it("subscribes and reports the new instance", async () => {
		const h = setup();
		h.fetchStub.respond((u, m) => u.endsWith("/subscribe") && m === "POST", {
			body: { instanceId: "inst-5", agentId: "a1", status: "active" },
		});
		const res = await h.tools.get("subscribe_agent")!.handler({ agent_id: "a1" });
		expect(res.content[0].text).toContain("Instance: inst-5");
		expect(res.content[0].text).toContain("Status: active");
		expect(h.auditEvents().some((e) => e.tool === "subscribe_agent" && e.action === "completed")).toBe(true);
	});

	it("falls back to finding the existing instance on 'Already subscribed'", async () => {
		const h = setup();
		h.fetchStub.respond((u, m) => u.endsWith("/subscribe") && m === "POST", {
			status: 409,
			body: { error: "Already subscribed to this agent" },
		});
		h.fetchStub.respond((u) => u.endsWith("/my/instances"), {
			body: { instances: [{ id: "inst-existing", agent_id: "a1", status: "active" }] },
		});
		const res = await h.tools.get("subscribe_agent")!.handler({ agent_id: "a1" });
		expect(res.content[0].text).toContain("Already subscribed");
		expect(res.content[0].text).toContain("inst-existing");
	});
});

// ── chat_with_instance: runtime scope + response extraction ───────────────────

describe("chat_with_instance", () => {
	it("posts the message and returns the assistant content", async () => {
		const h = setup();
		h.fetchStub.respond((u, m) => u.endsWith("/chat") && m === "POST", {
			body: { message: { content: "Hi there" } },
		});
		const res = await h.tools.get("chat_with_instance")!.handler({ instance_id: "i1", message: "hello" });
		expect(res.content[0].text).toBe("Hi there");
		expect(JSON.parse(h.fetchStub.calls[0].body!)).toEqual({ message: "hello" });
	});

	it("requires runtime scope (blocked with only read+write)", async () => {
		const h = setup({ scopes: ["read", "write"] });
		const res = await h.tools.get("chat_with_instance")!.handler({ instance_id: "i1", message: "hi" });
		expect(res.content[0].text).toContain('requires MCP scope "runtime"');
		expect(h.fetchStub.calls).toHaveLength(0);
	});
});

// ── instance_board: grouping of the flat board into configured columns ────────

describe("instance_board grouping", () => {
	it("buckets items into their configured columns and counts jobs", async () => {
		const h = setup();
		h.fetchStub.respond((u) => u.endsWith("/board"), {
			body: {
				columns: [
					{ id: "waiting", title: "Waiting", statuses: ["queued"] },
					{ id: "done", title: "Submitted", statuses: ["submitted"] },
					{ id: "other", title: "Other", catchAll: true },
				],
				items: [
					{ jobKey: "j1", title: "Job A", subtitle: "Acme", status: "queued", attempts: [1] },
					{ jobKey: "j2", title: "Job B", status: "submitted", userStatus: "submitted" },
					{ jobKey: "j3", title: "Job C", status: "weird" },
				],
			},
		});
		const res = await h.tools.get("instance_board")!.handler({ instance_id: "i1" });
		const out = JSON.parse(res.content[0].text);
		expect(out.jobCount).toBe(3);
		expect(out.columns).toEqual(["Waiting", "Submitted", "Other"]);
		expect(out.board.Waiting[0]).toMatchObject({ jobKey: "j1", label: "Job A (Acme)", attempts: 1 });
		expect(out.board.Submitted[0]).toMatchObject({ jobKey: "j2", moved: true });
		// unmatched status lands in the catchAll column
		expect(out.board.Other[0].jobKey).toBe("j3");
	});

	it("returns a structured error object when the board fetch reports an error", async () => {
		const h = setup();
		h.fetchStub.respond((u) => u.endsWith("/board"), { status: 500, body: { error: "no board" } });
		const res = await h.tools.get("instance_board")!.handler({ instance_id: "i1" });
		expect(JSON.parse(res.content[0].text)).toEqual({ error: "no board" });
	});
});

// ── Per-ticket conversation over MCP (#150) ──────────────────────────────────
//
// These exist so agent review is symmetric with human review: a supervisor could read a
// subordinate's board but not question anything on it. The two properties that make the
// thread trustworthy are what these tests pin — that it is GROUNDED in one ticket's record,
// and that it cannot ACT.

describe("ticket_thread / ask_ticket (#150 — a ticket a supervisor can question)", () => {
	it("ticket_thread reads ONE ticket's turns, scoped to that task id", async () => {
		// Scoping is the point: the same question on two tickets must get two answers, so the
		// tool must never fall back to the instance-wide event stream.
		const h = setup();
		h.fetchStub.respond((u, m) => u.endsWith("/tasks/t1/thread") && m === "GET", {
			body: { turns: [{ id: "q1", role: "user", text: "why?" }, { id: "a1", role: "agent", text: "because X" }] },
		});
		const res = await h.tools.get("ticket_thread")!.handler({ instance_id: "i1", task_id: "t1" });
		expect(h.fetchStub.calls[0].url).toBe("https://api.test/v1/instances/i1/tasks/t1/thread");
		expect(h.fetchStub.calls[0].method).toBe("GET");
		const out = JSON.parse(res.content[0].text);
		expect(out.turnCount).toBe(2);
		expect(out.turns[1]).toMatchObject({ role: "agent", text: "because X" });
	});

	it("both tools carry the grounding rule in the PAYLOAD, not only the description", async () => {
		// The caller here is a model. A tool description is read once at registration; the note
		// travels next to the answer it is about to summarise, which is where "not recorded"
		// gets smoothed into a plausible account of what happened.
		const h = setup();
		h.fetchStub.respond((u, m) => u.endsWith("/tasks/t1/thread") && m === "GET", { body: { turns: [] } });
		h.fetchStub.respond((u, m) => u.endsWith("/tasks/t1/thread") && m === "POST", {
			body: { answer: { id: "a1", role: "agent", text: "That isn't in this ticket's record." } },
		});
		const read = JSON.parse((await h.tools.get("ticket_thread")!.handler({ instance_id: "i1", task_id: "t1" })).content[0].text);
		const ask = JSON.parse((await h.tools.get("ask_ticket")!.handler({ instance_id: "i1", task_id: "t1", question: "did it merge?" })).content[0].text);
		for (const note of [read.note, ask.note]) {
			expect(note).toContain("not recorded");
			expect(note).toContain("cannot act");
		}
		// The answer itself is passed through verbatim — the tool must not soften a refusal.
		expect(ask.answer.text).toBe("That isn't in this ticket's record.");
	});

	it("ask_ticket POSTs the question to that ticket's thread and audits it", async () => {
		const h = setup();
		h.fetchStub.respond((u, m) => u.endsWith("/tasks/t1/thread") && m === "POST", {
			body: { question: { id: "q1" }, answer: { id: "a1", role: "agent", text: "because X" } },
		});
		await h.tools.get("ask_ticket")!.handler({ instance_id: "i1", task_id: "t1", question: "why?" });
		const call = h.fetchStub.calls[0];
		expect(call.url).toBe("https://api.test/v1/instances/i1/tasks/t1/thread");
		expect(call.method).toBe("POST");
		expect(JSON.parse(call.body!)).toEqual({ message: "why?" });
		expect(h.auditEvents()).toMatchObject([{ tool: "ask_ticket", action: "completed" }]);
	});

	it("ask_ticket takes NO argument that could act on the ticket", () => {
		// The no-action rule has to be structural, not a promise in prose: a thread that could
		// run a ticket's declared work would hand the approval gate a free-text bypass. Approving
		// stays with approve_instance_task / run_instance_task.
		const h = setup();
		const schema = h.tools.get("ask_ticket")!.schema;
		expect(Object.keys(schema).sort()).toEqual(["dry_run", "instance_id", "question", "task_id", "token"]);
		for (const forbidden of ["action", "approve", "status", "config", "params", "run"]) {
			expect(schema).not.toHaveProperty(forbidden);
		}
		// ticket_thread is a pure read — no dry_run, because it changes nothing to preview.
		expect(Object.keys(h.tools.get("ticket_thread")!.schema).sort()).toEqual(["instance_id", "task_id", "token"]);
	});

	it("ask_ticket needs the write scope (it persists a turn and spends the owner's tokens)", async () => {
		const h = setup({ scopes: ["read"] });
		const res = await h.tools.get("ask_ticket")!.handler({ instance_id: "i1", task_id: "t1", question: "why?" });
		expect(res.content[0].text).toContain('requires MCP scope "write"');
		expect(h.fetchStub.calls).toHaveLength(0);
	});

	it("ticket_thread stays readable under a read-only connection", async () => {
		// Reading the audit trail must survive MCP_READ_ONLY — that mode exists to stop writes,
		// not to blind a reviewer.
		const h = setup({ readOnly: true });
		h.fetchStub.respond((u) => u.endsWith("/thread"), { body: { turns: [{ id: "q1", role: "user", text: "why?" }] } });
		const out = JSON.parse((await h.tools.get("ticket_thread")!.handler({ instance_id: "i1", task_id: "t1" })).content[0].text);
		expect(out.turnCount).toBe(1);
	});

	it("ask_ticket dry-run names the endpoint without asking anything", async () => {
		const h = setup();
		const res = await h.tools.get("ask_ticket")!.handler({ instance_id: "i1", task_id: "t1", question: "why?", dry_run: true });
		expect(res.content[0].text).toContain("/v1/instances/i1/tasks/t1/thread");
		expect(h.fetchStub.calls).toHaveLength(0);
	});

	it("neither tool invents a thread when the API errors", async () => {
		// A fabricated empty thread reads as "nobody asked anything", which is a claim about the
		// audit trail. Surface the error instead, and do not audit a write that never happened.
		const h = setup();
		h.fetchStub.respond((u) => u.endsWith("/thread"), { status: 404, body: { error: "Task not found" } });
		const read = JSON.parse((await h.tools.get("ticket_thread")!.handler({ instance_id: "i1", task_id: "gone" })).content[0].text);
		const ask = JSON.parse((await h.tools.get("ask_ticket")!.handler({ instance_id: "i1", task_id: "gone", question: "why?" })).content[0].text);
		expect(read).toEqual({ error: "Task not found" });
		expect(ask).toEqual({ error: "Task not found" });
		expect(h.auditEvents().filter((e) => e.action === "completed")).toHaveLength(0);
	});
});

// ── coding_loop: in-memory orchestration state machine ───────────────────────

describe("coding loop state machine", () => {
	it("runs the objective then stops when loop-decide says done, tracking status", async () => {
		const h = setup();
		// findInstanceForAgent → my/instances (used to resolve the id)
		h.fetchStub.respond((u) => u.endsWith("/my/instances"), {
			body: { instances: [{ id: "i1", agent_id: "coder", status: "active" }] },
		});
		h.fetchStub.respond((u, m) => u.endsWith("/i1/chat") && m === "POST", {
			body: { message: { content: "starting" } },
		});
		h.fetchStub.respond((u, m) => u.endsWith("/loop-decide") && m === "POST", {
			body: { decision: "done", reason: "Objective met" },
		});
		const res = await h.tools.get("coding_loop_start")!.handler({
			instance_id: "coder",
			objective: "do the thing",
			max_iterations: 5,
		});
		expect(res.content[0].text).toContain("Iteration 0: sent objective");
		expect(res.content[0].text).toContain("Done: Objective met");
		// The loop was audited as started.
		expect(h.auditEvents().some((e) => e.tool === "coding_loop_start")).toBe(true);
		// After completion the active-loop map is cleared → status reports none.
		const status = await h.tools.get("coding_loop_status")!.handler({ instance_id: "coder" });
		expect(status.content[0].text).toContain("No active loop");
	});

	it("coding_loop_stop reports no active loop when nothing is running", async () => {
		const h = setup();
		h.fetchStub.respond((u) => u.endsWith("/my/instances"), {
			body: { instances: [{ id: "i1", agent_id: "coder", status: "active" }] },
		});
		const res = await h.tools.get("coding_loop_stop")!.handler({ instance_id: "coder" });
		expect(res.content[0].text).toContain("No active loop to stop");
	});
});

// ── delete_supervision: the destructive gate, asserted as an absence ─────────
//
// `contract.test.ts` derives that this tool demands `confirm` and previews with `dry_run`,
// by reading its refusal text. What it cannot say is whether the DELETE was nevertheless
// sent — a tool that refuses in words and mutates anyway reads identical from there. That
// is the failure mode worth pinning here, because cutting a supervision edge is silent:
// `delegate_goal` re-checks membership on the resolved id, so afterwards nothing errors,
// the subordinate merely stops being reachable.

describe("delete_supervision requires confirmation before it cuts anything", () => {
	const args = { supervisor_instance_id: "sup-1", supervision_id: "link-9" };

	it("sends no DELETE when confirm is missing or wrong", async () => {
		const h = setup();
		const missing = await h.tools.get("delete_supervision")!.handler({ ...args });
		expect(missing.content[0].text).toContain('requires confirm="delete_supervision"');
		const wrong = await h.tools.get("delete_supervision")!.handler({ ...args, confirm: "yes" });
		expect(wrong.content[0].text).toContain('requires confirm="delete_supervision"');
		expect(h.fetchStub.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
	});

	it("previews the link without confirm and without touching the network", async () => {
		// Dry run runs BEFORE the confirmation on purpose and in every tool: asking what a
		// destructive call would do must not itself require the destructive token.
		const h = setup();
		const res = await h.tools.get("delete_supervision")!.handler({ ...args, dry_run: true });
		const body = JSON.parse(res.content[0].text) as { dryRun: boolean; wouldDo: { method: string } };
		expect(body.dryRun).toBe(true);
		expect(body.wouldDo.method).toBe("DELETE");
		expect(h.fetchStub.calls).toHaveLength(0);
		expect(h.auditEvents().some((e) => e.tool === "delete_supervision" && e.action === "dry_run")).toBe(true);
	});

	it("deletes and audits once confirmed", async () => {
		const h = setup();
		const res = await h.tools.get("delete_supervision")!.handler({ ...args, confirm: "delete_supervision" });
		expect(res.content[0].text).toContain("ok");
		const del = h.fetchStub.calls.filter((c) => c.method === "DELETE");
		expect(del).toHaveLength(1);
		expect(del[0].url).toContain("/v1/instances/sup-1/supervision/link-9");
		expect(h.auditEvents().some((e) => e.tool === "delete_supervision" && e.action === "completed")).toBe(true);
	});

	it("refuses on a connection holding write but not destructive", async () => {
		const h = setup({ scopes: ["read", "write", "runtime"] });
		const res = await h.tools.get("delete_supervision")!.handler({ ...args, confirm: "delete_supervision" });
		expect(res.content[0].text).toContain('requires MCP scope "destructive"');
		expect(h.fetchStub.calls).toHaveLength(0);
	});
});

// ── coding_loop_start: the gate runs before the server does any work ─────────

describe("coding_loop_start dry run", () => {
	it("commits no model spend and does not even resolve the instance", async () => {
		// The instance lookup is a network call, so it has to sit AFTER the dry-run branch
		// (and after the scope check) or a preview would still make the server fetch.
		const h = setup({ groups: ["coding"] });
		const res = await h.tools.get("coding_loop_start")!.handler({
			instance_id: "coder",
			objective: "do the thing",
			max_iterations: 50,
			dry_run: true,
		});
		const body = JSON.parse(res.content[0].text) as { dryRun: boolean; wouldDo: { spend: string } };
		expect(body.dryRun).toBe(true);
		// The number a caller is really committing to when it leaves max_iterations at the cap.
		expect(body.wouldDo.spend).toContain("50 agent turns");
		expect(h.fetchStub.calls).toHaveLength(0);
	});

	it("refuses without the runtime scope before making any call", async () => {
		const h = setup({ groups: ["coding"], scopes: ["read"] });
		const res = await h.tools.get("coding_loop_start")!.handler({ instance_id: "coder", objective: "x" });
		expect(res.content[0].text).toContain('requires MCP scope "runtime"');
		expect(h.fetchStub.calls).toHaveLength(0);
	});
});

// ── upload_resume: input validation before any network / audit ────────────────

describe("upload_resume validation", () => {
	it("rejects invalid base64 without calling the API", async () => {
		const h = setup({ groups: ["apply"] });
		const res = await h.tools.get("upload_resume")!.handler({
			instance_id: "i1",
			content_base64: "%%%not-base64%%%",
		});
		expect(res.content[0].text).toContain("not valid base64");
		expect(h.fetchStub.calls).toHaveLength(0);
	});

	it("rejects a non-http(s) url", async () => {
		const h = setup({ groups: ["apply"] });
		const res = await h.tools.get("upload_resume")!.handler({
			instance_id: "i1",
			url: "ftp://evil/resume.pdf",
		});
		expect(res.content[0].text).toContain("must be an http(s) URL");
		expect(h.fetchStub.calls).toHaveLength(0);
	});

	it("re-parses the on-file résumé when no source is given", async () => {
		const h = setup({ groups: ["apply"] });
		h.fetchStub.respond((u, m) => u.endsWith("/apply-resume/parse") && m === "POST", { body: { parsed: true } });
		const res = await h.tools.get("upload_resume")!.handler({ instance_id: "i1" });
		expect(h.fetchStub.calls[0].url).toBe("https://api.test/v1/instances/i1/apply-resume/parse");
		expect(JSON.parse(res.content[0].text)).toEqual({ parsed: true });
	});
});

// ── call_instance_tool: generic connector invoker gated as a write ────────────

describe("call_instance_tool proxy", () => {
	it("POSTs the input to the url-encoded tool route", async () => {
		const h = setup();
		h.fetchStub.respond((u, m) => u.includes("/tools/") && m === "POST", { body: { result: "ok" } });
		await h.tools.get("call_instance_tool")!.handler({
			instance_id: "i1",
			tool: "github list issues",
			input: { repo: "a/b" },
		});
		const call = h.fetchStub.calls[0];
		expect(call.url).toBe("https://api.test/v1/instances/i1/tools/github%20list%20issues");
		expect(call.method).toBe("POST");
		expect(JSON.parse(call.body!)).toEqual({ repo: "a/b" });
	});

	it("is blocked in read-only mode (it is a write-scoped invoker)", async () => {
		const h = setup({ readOnly: true });
		const res = await h.tools.get("call_instance_tool")!.handler({
			instance_id: "i1",
			tool: "github_list_issues",
		});
		expect(res.content[0].text).toContain("read-only mode");
		expect(h.fetchStub.calls).toHaveLength(0);
	});
});

// ── Drive / WorkDrive connector grants (#15) ─────────────────────────────────
//
// A `sync_connector` trigger needs a `grantId`, and that id was only obtainable from the
// console or a hand-rolled REST call — so an MCP-first operator could create the trigger but
// never find the value it requires.
describe("connector grant tools", () => {
	it("registers all four, surface-independently", () => {
		const { tools } = setup({ groups: [] });
		for (const n of ["connector_status", "list_instance_connector_grants", "grant_instance_connector_folder", "delete_instance_connector_grant"]) {
			expect(tools.has(n)).toBe(true);
		}
	});

	it("routes each provider at its own API base", async () => {
		const h = setup();
		h.fetchStub.respond((u) => u.includes("/v1/drive/status"), { body: { connected: true, configured: true } });
		h.fetchStub.respond((u) => u.includes("/v1/workdrive/status"), { body: { connected: false, configured: true } });

		await h.tools.get("connector_status")!.handler({ provider: "google_drive" });
		expect(h.fetchStub.calls.at(-1)!.url).toContain("/v1/drive/status");
		await h.tools.get("connector_status")!.handler({ provider: "zoho_workdrive" });
		expect(h.fetchStub.calls.at(-1)!.url).toContain("/v1/workdrive/status");
	});

	it("surfaces the grant id, which is the whole reason these tools exist", async () => {
		const h = setup();
		h.fetchStub.respond((u) => u.includes("/instances/i1/grants"), {
			body: { grants: [{ id: "grant_abc", resourceName: "Invoices", resourceType: "folder" }] },
		});
		const res = await h.tools.get("list_instance_connector_grants")!.handler({ instance_id: "i1", provider: "google_drive" });
		expect(res.content[0].text).toContain("grant_abc");
	});

	it("refuses a grant with neither url nor resource_id, without calling the API", async () => {
		const h = setup();
		const before = h.fetchStub.calls.length;
		const res = await h.tools.get("grant_instance_connector_folder")!.handler({ instance_id: "i1", provider: "google_drive" });
		expect(res.content[0].text).toMatch(/url.*resource_id/i);
		expect(h.fetchStub.calls.length).toBe(before);
	});

	// Granting widens what an agent can read, so a read-only MCP session must not do it.
	it("blocks granting in read-only mode", async () => {
		const h = setup({ readOnly: true });
		const res = await h.tools.get("grant_instance_connector_folder")!.handler({ instance_id: "i1", provider: "google_drive", url: "https://drive.google.com/x" });
		expect(res.content[0].text.toLowerCase()).toContain("read-only");
	});

	it("revoking requires the exact confirm string", async () => {
		const h = setup();
		h.fetchStub.respond((u, m) => u.includes("/grants/grant_abc") && m === "DELETE", { body: { success: true } });

		const unconfirmed = await h.tools.get("delete_instance_connector_grant")!.handler({ instance_id: "i1", provider: "google_drive", grant_id: "grant_abc" });
		expect(unconfirmed.content[0].text.toLowerCase()).toContain("confirm");

		const wrong = await h.tools.get("delete_instance_connector_grant")!.handler({ instance_id: "i1", provider: "google_drive", grant_id: "grant_abc", confirm: "yes" });
		expect(wrong.content[0].text.toLowerCase()).toContain("confirm");

		const ok = await h.tools.get("delete_instance_connector_grant")!.handler({ instance_id: "i1", provider: "google_drive", grant_id: "grant_abc", confirm: "delete_instance_connector_grant" });
		expect(ok.content[0].text).toContain("revoked");
	});

	it("dry-run describes the call without making it", async () => {
		const h = setup();
		const before = h.fetchStub.calls.length;
		const res = await h.tools.get("grant_instance_connector_folder")!.handler({ instance_id: "i1", provider: "google_drive", url: "https://drive.google.com/x", dry_run: true });
		expect(res.content[0].text.toLowerCase()).toContain("dry");
		expect(h.fetchStub.calls.length).toBe(before);
	});
});

describe("remove_repo — a failed removal must not be reported as one (#325)", () => {
	// `authedCall` RETURNS `{error: "API <status>"}` on a non-2xx instead of throwing, so
	// discarding its result made this tool answer "Removed all repositories." for a call
	// that removed nothing, and write `action:"completed"` to the audit log — the record an
	// operator consults to answer whether the destructive removal actually happened. The
	// vectors survive and keep being cited from an index the caller was told is gone.
	it("surfaces the API failure and writes no completed audit event", async () => {
		const h = setup({ groups: ["repo"] });
		h.fetchStub.respond((u, m) => u.includes("/ingest-repo/clear") && m === "POST", {
			status: 500,
			body: { error: "vectorize unavailable" },
		});

		const res = await h.tools.get("remove_repo")!.handler({ instance_id: "i1", repo_url: "owner/repo" });

		expect(res.content[0].text).toMatch(/^Error removing owner\/repo/);
		expect(h.auditEvents().some((e) => e.tool === "remove_repo" && e.action === "completed")).toBe(false);
	});

	it("still reports and audits a removal that really happened", async () => {
		const h = setup({ groups: ["repo"] });
		h.fetchStub.respond((u, m) => u.includes("/ingest-repo/clear") && m === "POST", { body: { success: true } });

		const res = await h.tools.get("remove_repo")!.handler({ instance_id: "i1", repo_url: "owner/repo" });

		expect(res.content[0].text).toBe("Removed owner/repo.");
		expect(h.auditEvents().some((e) => e.tool === "remove_repo" && e.action === "completed")).toBe(true);
	});
});
