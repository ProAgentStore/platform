import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { McpEnv } from "./http.js";
import { registerMcpConnectionTools } from "./instance-tools/mcp-connections.js";
import type { SafetyContext } from "./safety.js";

// ── #613, the outbound-MCP-connections group ──────────────────────────────────
//
// PAGS as an MCP *client*. Six proxies, but two of them reach a THIRD PARTY, so the tests pin
// more than route and method:
//
//   · `test_instance_mcp_server` must not contact anything on a dry run, and must not
//     manufacture an `auth` value — the route reads anything but the string "none" as "use the
//     vault", so sending `auth: "vault"` and omitting it mean the same thing and only one of
//     them is honest in the audit row.
//   · `answer_instance_mcp_input_request` sends the owner's values OFF this platform. The tests
//     pin that `cancel` sends no values at all, that the audit input records field NAMES and
//     never the values, and that a 409 (the claim is one-shot) is surfaced rather than audited
//     as completed.
//
// Driven through the real safety layer and `authedCall`; only `fetch` and the audit KV are stubbed.

type ToolContent = { content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolContent>;
type Shape = Record<string, z.ZodTypeAny>;

function setup(opts: { scopes?: string[]; status?: number; body?: unknown } = {}) {
	const calls: Array<{ url: string; method: string; body: unknown }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const raw = (init?.body as string | undefined) ?? null;
		calls.push({ url: String(input), method: (init?.method || "GET").toUpperCase(), body: raw === null ? null : JSON.parse(raw) });
		return new Response(JSON.stringify(opts.body ?? { ok: true }), { status: opts.status ?? 200, headers: { "Content-Type": "application/json" } });
	});
	const auditStore = new Map<string, string>();
	const kv = {
		get: async (k: string) => auditStore.get(k) ?? null,
		put: async (k: string, v: string) => void auditStore.set(k, v),
		delete: async (k: string) => void auditStore.delete(k),
		list: async () => ({ keys: [...auditStore.keys()].map((name) => ({ name })), list_complete: true }),
	} as unknown as KVNamespace;
	const env: McpEnv = { API_BASE: "https://api.test", OAUTH_KV: kv };
	const tools = new Map<string, Handler>();
	// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server, as in contract.test.ts
	const server = { tool: (name: string, _d: string, _s: Shape, handler: Handler) => tools.set(name, handler) } as any;
	const tokenFor = (t?: string) => t || "session-token";
	const safetyFor = (): SafetyContext => ({ env, subject: "user-1", scopes: (opts.scopes ?? ["read", "write", "runtime"]) as SafetyContext["scopes"] });
	registerMcpConnectionTools(server, { env, tokenFor, safetyFor, groups: new Set<string>() });
	const run = (name: string, args: Record<string, unknown> = {}) => {
		const h = tools.get(name);
		if (!h) throw new Error(`"${name}" is not registered`);
		return h(args);
	};
	const events = () => [...auditStore.values()].map((v) => JSON.parse(v) as { tool?: string; action?: string; input?: Record<string, unknown> });
	const completed = () => events().filter((e) => e.action === "completed");
	return { run, calls, completed, events };
}

afterEach(() => vi.unstubAllGlobals());

describe("list_mcp_presets", () => {
	it("GETs the account-level preset list", async () => {
		const h = setup({ body: { presets: [{ label: "ProAgentStore", url: "https://mcp.test/mcp" }] } });
		const res = await h.run("list_mcp_presets", {});
		expect(h.calls).toEqual([{ url: "https://api.test/v1/mcp/presets", method: "GET", body: null }]);
		expect(res.content[0].text).toContain("mcp.test");
	});

	it("reads with only the read scope", async () => {
		const h = setup({ scopes: ["read"] });
		await h.run("list_mcp_presets", {});
		expect(h.calls).toHaveLength(1);
	});
});

describe("list_instance_mcp_grants", () => {
	it("GETs the per-instance grants", async () => {
		const h = setup({ body: { grants: [{ endpoint: "https://x.test/mcp", tool: "*", destructive: false }] } });
		const res = await h.run("list_instance_mcp_grants", { instance_id: "inst-1" });
		expect(h.calls).toEqual([{ url: "https://api.test/v1/instances/inst-1/mcp/consent", method: "GET", body: null }]);
		expect(res.content[0].text).toContain("x.test");
	});
});

describe("set_instance_mcp_grant", () => {
	it("PUTs the (url, tool, enabled) triple the route reads", async () => {
		const h = setup({ body: { ok: true, endpoint: "https://x.test/mcp", tool: "search", enabled: true } });
		await h.run("set_instance_mcp_grant", { instance_id: "inst-1", url: "https://x.test/mcp", tool: "search", enabled: true });
		expect(h.calls).toEqual([
			{
				url: "https://api.test/v1/instances/inst-1/mcp/consent",
				method: "PUT",
				body: { url: "https://x.test/mcp", tool: "search", enabled: true },
			},
		]);
		expect(h.completed().map((e) => e.tool)).toEqual(["set_instance_mcp_grant"]);
	});

	it("revokes by sending enabled:false", async () => {
		const h = setup();
		await h.run("set_instance_mcp_grant", { instance_id: "inst-1", url: "https://x.test/mcp", tool: "*", enabled: false });
		expect(h.calls[0]?.body).toMatchObject({ enabled: false, tool: "*" });
	});

	it("is refused without the write scope", async () => {
		const h = setup({ scopes: ["read"] });
		const res = await h.run("set_instance_mcp_grant", { instance_id: "inst-1", url: "https://x.test/mcp", tool: "search", enabled: true });
		expect(res.content[0].text).toMatch(/write/);
		expect(h.calls).toHaveLength(0);
	});

	it("dry_run stores nothing", async () => {
		const h = setup();
		const res = await h.run("set_instance_mcp_grant", { instance_id: "inst-1", url: "https://x.test/mcp", tool: "search", enabled: true, dry_run: true });
		expect(h.calls).toHaveLength(0);
		expect(JSON.parse(res.content[0].text)).toMatchObject({ dryRun: true, wouldDo: { method: "PUT" } });
	});

	it("surfaces the route's refusal of a non-https endpoint, unaudited", async () => {
		const h = setup({ status: 400, body: { error: "`url` must be an https MCP endpoint, e.g. https://example.com/mcp." } });
		const res = await h.run("set_instance_mcp_grant", { instance_id: "inst-1", url: "http://x.test/mcp", tool: "search", enabled: true });
		expect(res.content[0].text).toContain("must be an https MCP endpoint");
		expect(h.completed()).toHaveLength(0);
	});
});

describe("test_instance_mcp_server", () => {
	it("POSTs the url alone when auth was not narrowed — `vault` is the route's own default", async () => {
		const h = setup({ body: { endpoint: "https://x.test/mcp", success: true, tools: [] } });
		await h.run("test_instance_mcp_server", { instance_id: "inst-1", url: "https://x.test/mcp" });
		expect(h.calls).toEqual([{ url: "https://api.test/v1/instances/inst-1/mcp/test", method: "POST", body: { url: "https://x.test/mcp" } }]);
	});

	it("sends auth:none only when the caller asked for it", async () => {
		const h = setup();
		await h.run("test_instance_mcp_server", { instance_id: "inst-1", url: "https://x.test/mcp", auth: "none" });
		expect(h.calls[0]?.body).toEqual({ url: "https://x.test/mcp", auth: "none" });
		const h2 = setup();
		await h2.run("test_instance_mcp_server", { instance_id: "inst-1", url: "https://x.test/mcp", auth: "vault" });
		expect(h2.calls[0]?.body).toEqual({ url: "https://x.test/mcp" });
	});

	it("contacts nothing on a dry run", async () => {
		const h = setup();
		const res = await h.run("test_instance_mcp_server", { instance_id: "inst-1", url: "https://x.test/mcp", dry_run: true });
		expect(h.calls).toHaveLength(0);
		expect(res.content[0].text).toContain("https://x.test/mcp");
	});

	it("needs the runtime scope — it reaches a third party, so a read-only session cannot", async () => {
		const h = setup({ scopes: ["read", "write"] });
		const res = await h.run("test_instance_mcp_server", { instance_id: "inst-1", url: "https://x.test/mcp" });
		expect(res.content[0].text).toMatch(/runtime/);
		expect(h.calls).toHaveLength(0);
	});

	it("returns a blocked probe as the result it is, not as an error", async () => {
		const h = setup({ body: { endpoint: "https://169.254.169.254/mcp", status: "blocked", success: false } });
		const res = await h.run("test_instance_mcp_server", { instance_id: "inst-1", url: "https://169.254.169.254/mcp" });
		expect(JSON.parse(res.content[0].text)).toMatchObject({ status: "blocked" });
	});
});

describe("list_instance_mcp_input_requests", () => {
	it("GETs the paused asks", async () => {
		const h = setup({ body: { requests: [{ id: "req-1", tool: "book", endpoint: "https://x.test/mcp", status: "pending" }] } });
		const res = await h.run("list_instance_mcp_input_requests", { instance_id: "inst-1" });
		expect(h.calls).toEqual([{ url: "https://api.test/v1/instances/inst-1/mcp/input-requests", method: "GET", body: null }]);
		expect(res.content[0].text).toContain("req-1");
	});
});

describe("answer_instance_mcp_input_request", () => {
	it("submits the values to the ask, URL-encoding its id", async () => {
		const h = setup({ body: { ok: true, status: "answered" } });
		await h.run("answer_instance_mcp_input_request", {
			instance_id: "inst-1",
			request_id: "req/1",
			action: "submit",
			values: { seat: "12A" },
		});
		expect(h.calls).toEqual([
			{
				url: "https://api.test/v1/instances/inst-1/mcp/input-requests/req%2F1",
				method: "POST",
				body: { action: "submit", values: { seat: "12A" } },
			},
		]);
	});

	it("cancels without sending any values", async () => {
		const h = setup({ body: { ok: true, status: "cancelled" } });
		await h.run("answer_instance_mcp_input_request", { instance_id: "inst-1", request_id: "req-1", action: "cancel", values: { seat: "12A" } });
		expect(h.calls[0]?.body).toEqual({ action: "cancel" });
	});

	it("audits the field NAMES and never the values", async () => {
		const h = setup({ body: { ok: true, status: "answered" } });
		await h.run("answer_instance_mcp_input_request", {
			instance_id: "inst-1",
			request_id: "req-1",
			action: "submit",
			values: { passport: "X1234567", seat: "12A" },
		});
		const entry = h.completed()[0];
		expect(entry?.input).toMatchObject({ fields: ["passport", "seat"] });
		expect(JSON.stringify(entry?.input)).not.toContain("X1234567");
	});

	it("surfaces the one-shot 409 and does not audit it as completed", async () => {
		const h = setup({ status: 409, body: { error: "That request was already resolved." } });
		const res = await h.run("answer_instance_mcp_input_request", { instance_id: "inst-1", request_id: "req-1", action: "submit", values: {} });
		expect(res.content[0].text).toContain("already resolved");
		expect(h.completed()).toHaveLength(0);
	});

	it("needs the runtime scope — answering sends data to a third party", async () => {
		const h = setup({ scopes: ["read", "write"] });
		const res = await h.run("answer_instance_mcp_input_request", { instance_id: "inst-1", request_id: "req-1", action: "submit", values: {} });
		expect(res.content[0].text).toMatch(/runtime/);
		expect(h.calls).toHaveLength(0);
	});

	it("dry_run sends nothing, and says which of the two it would do", async () => {
		const h = setup();
		const submit = await h.run("answer_instance_mcp_input_request", { instance_id: "inst-1", request_id: "req-1", action: "submit", values: {}, dry_run: true });
		expect(submit.content[0].text).toContain("remote server");
		const cancel = await h.run("answer_instance_mcp_input_request", { instance_id: "inst-1", request_id: "req-1", action: "cancel", dry_run: true });
		expect(cancel.content[0].text).toContain("sending the server nothing");
		expect(h.calls).toHaveLength(0);
	});
});
