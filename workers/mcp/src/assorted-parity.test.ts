import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { McpEnv } from "./http.js";
import { registerAccountTools } from "./instance-tools/account.js";
import { registerObservabilityTools } from "./instance-tools/observability.js";
import { registerSettingsTools } from "./instance-tools/settings.js";
import { registerStatsTools } from "./instance-tools/stats.js";
import type { SafetyContext } from "./safety.js";

// ── #613, the remaining assorted group ──────────────────────────────────────
//
// Five routes belong on MCP: four reads whose values are otherwise easy to invent, and one
// single-turn deletion. The two POST routes deliberately left out are held here too: translation
// is the console's paid AI gloss cache, while a system message becomes durable role:system prompt
// history. A normal MCP write gate is not a safe provenance boundary for either.
//
// Driven through the real safety layer and authedCall; only fetch and the audit KV are faked.

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
	const audit = new Map<string, string>();
	const kv = {
		get: async (k: string) => audit.get(k) ?? null,
		put: async (k: string, v: string) => void audit.set(k, v),
		delete: async (k: string) => void audit.delete(k),
		list: async () => ({ keys: [...audit.keys()].map((name) => ({ name })), list_complete: true }),
	} as unknown as KVNamespace;
	const env: McpEnv = { API_BASE: "https://api.test", OAUTH_KV: kv };
	const tools = new Map<string, Handler>();
	// biome-ignore lint/suspicious/noExplicitAny: minimal registrar target
	const server = { tool: (name: string, _d: string, _s: Shape, handler: Handler) => tools.set(name, handler) } as any;
	const ctx = {
		env,
		tokenFor: (token?: string) => token || "session-token",
		safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: (opts.scopes ?? ["read", "write", "runtime", "destructive"]) as SafetyContext["scopes"] }),
		groups: new Set<string>(),
	};
	registerAccountTools(server, ctx);
	registerObservabilityTools(server, ctx);
	registerSettingsTools(server, ctx);
	registerStatsTools(server, ctx);
	const run = (name: string, args: Record<string, unknown> = {}) => {
		const handler = tools.get(name);
		if (!handler) throw new Error(`"${name}" is not registered`);
		return handler(args);
	};
	const completed = () => [...audit.values()].map((value) => JSON.parse(value) as { tool?: string; action?: string }).filter((event) => event.action === "completed");
	return { run, calls, completed, tools };
}

afterEach(() => vi.unstubAllGlobals());

describe("#613 assorted reads", () => {
	it("proxies both owner-scoped dashboards unchanged", async () => {
		const h = setup({ body: { totalAgents: 2 } });
		expect(JSON.parse((await h.run("get_creator_dashboard")).content[0].text)).toEqual({ totalAgents: 2 });
		await h.run("get_usage_dashboard");
		expect(h.calls).toEqual([
			{ url: "https://api.test/v1/dashboard/creator", method: "GET", body: null },
			{ url: "https://api.test/v1/dashboard/usage", method: "GET", body: null },
		]);
	});

	it("proxies served vocabulary instead of copying stats or behaviour fields into MCP", async () => {
		const h = setup({ body: { fields: [{ key: "tone" }] } });
		await h.run("list_stats_sources");
		await h.run("get_instance_behaviour_schema");
		expect(h.calls).toEqual([
			{ url: "https://api.test/v1/stats/sources", method: "GET", body: null },
			{ url: "https://api.test/v1/instances/behaviour-schema", method: "GET", body: null },
		]);
	});

	it("does not register the console-only translation or prompt-injection routes", () => {
		const h = setup();
		expect(h.tools.has("translate_instance_message")).toBe(false);
		expect(h.tools.has("post_instance_system_message")).toBe(false);
	});
});

describe("delete_instance_message", () => {
	it("dry-runs without touching the network and names the whole-turn effect", async () => {
		const h = setup();
		const out = JSON.parse((await h.run("delete_instance_message", { instance_id: "inst/1", message_id: "msg/a", dry_run: true })).content[0].text);
		expect(out).toMatchObject({ dryRun: true, wouldDo: { method: "DELETE", endpoint: "/v1/instances/inst%2F1/messages/msg%2Fa" } });
		expect(out.wouldDo.effect).toContain("full turn");
		expect(h.calls).toHaveLength(0);
		expect(h.completed()).toHaveLength(0);
	});

	it("requires destructive scope and its exact confirmation before any delete", async () => {
		const denied = setup({ scopes: ["read", "write", "runtime"] });
		expect((await denied.run("delete_instance_message", { instance_id: "inst-1", message_id: "m-1", confirm: "delete_instance_message" })).content[0].text).toContain('requires MCP scope "destructive"');
		expect(denied.calls).toHaveLength(0);

		const unconfirmed = setup();
		expect((await unconfirmed.run("delete_instance_message", { instance_id: "inst-1", message_id: "m-1" })).content[0].text).toContain('requires confirm="delete_instance_message"');
		expect(unconfirmed.calls).toHaveLength(0);
	});

	it("URL-encodes the addressed message and audits only a successful deletion", async () => {
		const h = setup({ body: { ids: ["m/a"] } });
		const out = JSON.parse((await h.run("delete_instance_message", { instance_id: "inst/1", message_id: "m/a", confirm: "delete_instance_message" })).content[0].text);
		expect(out).toEqual({ ids: ["m/a"] });
		expect(h.calls).toEqual([{ url: "https://api.test/v1/instances/inst%2F1/messages/m%2Fa", method: "DELETE", body: null }]);
		expect(h.completed()).toMatchObject([{ tool: "delete_instance_message", action: "completed" }]);
	});

	it("does not audit a refused route response as completed", async () => {
		const h = setup({ status: 404, body: { error: "Message not found" } });
		const out = JSON.parse((await h.run("delete_instance_message", { instance_id: "inst-1", message_id: "missing", confirm: "delete_instance_message" })).content[0].text);
		expect(out).toEqual({ error: "Message not found" });
		expect(h.completed()).toHaveLength(0);
	});
});
