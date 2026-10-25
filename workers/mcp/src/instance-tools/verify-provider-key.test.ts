import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerAccountTools } from "./account.js";

// #1343: the console's key Verify over MCP. The API owns the probe and the classification; these tests hold what this
// worker must keep: it POSTs the verify route for the named provider, hands back the API's body untouched (a refusal is
// the classified body, never `API 400`), previews with no network, and is not available on a read-only grant.
type ToolContent = { content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolContent>;
type Shape = Record<string, z.ZodTypeAny>;

function setup(opts: { scopes?: string[]; status?: number; body?: unknown } = {}) {
	const calls: Array<{ url: string; method: string; auth: string | null }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), method: (init?.method || "GET").toUpperCase(), auth: new Headers(init?.headers).get("Authorization") });
		return new Response(JSON.stringify(opts.body ?? { ok: true, provider: "anthropic", checkedAt: "2026-10-26T00:00:00.000Z" }), { status: opts.status ?? 200, headers: { "Content-Type": "application/json" } });
	});
	const store = new Map<string, string>();
	const kv = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), list: async () => ({ keys: [...store.keys()].map((name) => ({ name })), list_complete: true }) } as unknown as KVNamespace;
	const env: McpEnv = { API_BASE: "https://api.test", OAUTH_KV: kv };
	const tools = new Map<string, { schema: Shape; handler: Handler }>();
	registerAccountTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal MCP registrar for the real handlers
		{ tool: (name: string, _d: string, schema: Shape, handler: Handler) => tools.set(name, { schema, handler }) } as any,
		// biome-ignore lint/suspicious/noExplicitAny: only the members account.ts reads
		{ env, tokenFor: (t?: string) => t || "session-token", safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: (opts.scopes ?? ["read", "write"]) as SafetyContext["scopes"] }), groups: new Set<string>() } as any,
	);
	const run = (args: Record<string, unknown>) => {
		const t = tools.get("verify_provider_key");
		if (!t) throw new Error("not registered");
		return t.handler(args);
	};
	return { calls, run, tools, events: () => [...store.values()].map((v) => JSON.parse(v) as { tool?: string; action?: string }) };
}
afterEach(() => vi.unstubAllGlobals());

describe("verify_provider_key (#1343)", () => {
	it("POSTs the verify route for the named provider with the session token, and returns the pass", async () => {
		const { calls, run, events } = setup();
		const r = await run({ provider: "anthropic" });
		expect(calls).toEqual([{ url: "https://api.test/v1/keys/anthropic/verify", method: "POST", auth: "Bearer session-token" }]);
		expect(JSON.parse(r.content[0].text)).toEqual({ ok: true, provider: "anthropic", checkedAt: "2026-10-26T00:00:00.000Z" });
		expect(events().some((e) => e.tool === "verify_provider_key" && e.action === "completed")).toBe(true);
	});

	it("takes only anthropic or cloudflare", () => {
		const { tools } = setup();
		const provider = tools.get("verify_provider_key")?.schema.provider as z.ZodTypeAny;
		expect(provider.safeParse("cloudflare").success).toBe(true);
		expect(provider.safeParse("openai").success).toBe(false);
	});

	it("a provider refusal comes back as the classified body, not `API 400`", async () => {
		const refusal = { ok: false, provider: "anthropic", error: "invalid x-api-key (authentication_error, request_id req_1)", upstreamStatus: 401, failureClass: "provider_credentials", remedy: "Replace the key in Profile → API Keys.", checkedAt: "2026-10-26T00:00:00.000Z" };
		const { run } = setup({ status: 400, body: refusal });
		const out = JSON.parse((await run({ provider: "anthropic" })).content[0].text);
		expect(out).toMatchObject({ ok: false, failureClass: "provider_credentials", remedy: refusal.remedy, upstreamStatus: 401 });
		expect(out.error).toBe(refusal.error);
		expect(out.error).not.toBe("API 400");
	});

	it("no stored key is the API's own 404 sentence, with the error visible", async () => {
		const { run } = setup({ status: 404, body: { error: "No Cloudflare Workers AI credentials stored. Add your account ID and API token in Profile → API Keys → Cloudflare Workers AI" } });
		const out = JSON.parse((await run({ provider: "cloudflare" })).content[0].text);
		expect(out.error).toMatch(/No Cloudflare Workers AI credentials stored/);
	});

	it("dry_run touches no network", async () => {
		const { calls, run } = setup();
		const r = await run({ provider: "cloudflare", dry_run: true });
		expect(JSON.parse(r.content[0].text)).toMatchObject({ dryRun: true, tool: "verify_provider_key" });
		expect(calls).toHaveLength(0);
	});

	it("a read-only grant is refused before any request is sent", async () => {
		const { calls, run } = setup({ scopes: ["read"] });
		const r = await run({ provider: "anthropic" });
		expect(r.content[0].text).toMatch(/requires MCP scope "write"/);
		expect(calls).toHaveLength(0);
	});
});
