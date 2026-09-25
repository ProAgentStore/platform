import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { McpEnv } from "./http.js";
import { registerSettingsTools } from "./instance-tools/settings.js";
import type { SafetyContext } from "./safety.js";

// #496 AC2 / #613: identity is copied into an instance at subscribe time. This tool must repair
// ONLY that personality field, never turn a template change into permission to reset the owner's
// guardrails, goal, or welcome message. The API is the field-level authority; MCP protects the
// durable prompt overwrite with destructive scope, confirmation, no-network dry run and a
// text-free audit record.

type ToolContent = { content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolContent>;
type Shape = Record<string, z.ZodTypeAny>;

function setup(opts: { scopes?: string[]; status?: number; body?: unknown } = {}) {
	const calls: Array<{ url: string; method: string; body: unknown }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const raw = (init?.body as string | undefined) ?? null;
		calls.push({ url: String(input), method: (init?.method || "GET").toUpperCase(), body: raw === null ? null : JSON.parse(raw) });
		return new Response(JSON.stringify(opts.body ?? { personality: "new seed", previous: "old instance", changed: true }), { status: opts.status ?? 200, headers: { "Content-Type": "application/json" } });
	});
	const entries = new Map<string, string>();
	const kv = {
		get: async (k: string) => entries.get(k) ?? null,
		put: async (k: string, v: string) => void entries.set(k, v),
		delete: async (k: string) => void entries.delete(k),
		list: async () => ({ keys: [...entries.keys()].map((name) => ({ name })), list_complete: true }),
	} as unknown as KVNamespace;
	const env: McpEnv = { API_BASE: "https://api.test", OAUTH_KV: kv };
	const tools = new Map<string, Handler>();
	// biome-ignore lint/suspicious/noExplicitAny: minimal registrar target
	const server = { tool: (name: string, _description: string, _shape: Shape, handler: Handler) => tools.set(name, handler) } as any;
	const safetyFor = (): SafetyContext => ({ env, subject: "user-1", scopes: (opts.scopes ?? ["read", "write", "runtime", "destructive"]) as SafetyContext["scopes"] });
	registerSettingsTools(server, { env, tokenFor: (token?: string) => token || "session-token", safetyFor, groups: new Set<string>() });
	const run = (args: Record<string, unknown> = {}) => tools.get("resync_instance_personality")?.({ instance_id: "inst/one", ...args });
	const events = () => [...entries.values()].map((value) => JSON.parse(value) as Record<string, unknown>);
	return { calls, events, run };
}

afterEach(() => vi.unstubAllGlobals());

describe("resync_instance_personality — mutation checked", () => {
	it("requires destructive scope and its exact confirmation before making the prompt overwrite", async () => {
		const missingScope = setup({ scopes: ["read", "write", "runtime"] });
		expect((await missingScope.run({ confirm: "resync_instance_personality" }))?.content[0].text).toContain('requires MCP scope "destructive"');
		expect(missingScope.calls).toHaveLength(0);

		const missingConfirm = setup();
		expect((await missingConfirm.run())?.content[0].text).toContain('confirm="resync_instance_personality"');
		expect(missingConfirm.calls).toHaveLength(0);
	});

	it("dry-runs with no network request and makes its narrow field effect explicit", async () => {
		const h = setup();
		const preview = JSON.parse((await h.run({ dry_run: true }))?.content[0].text ?? "{}");
		expect(preview).toMatchObject({ dryRun: true, wouldDo: { method: "POST", endpoint: "/v1/instances/inst%2Fone/resync-identity" } });
		expect(preview.wouldDo.effect).toMatch(/guardrails[\s\S]*goal[\s\S]*welcomeMessage/i);
		expect(h.calls).toHaveLength(0);
	});

	it("uses only the console route and an empty body, then audits only the changed flag", async () => {
		const h = setup({ body: { personality: "seed text that must not be audited", previous: "custom text that must not be audited", changed: true } });
		const result = JSON.parse((await h.run({ confirm: "resync_instance_personality" }))?.content[0].text ?? "{}");
		expect(result).toMatchObject({ personality: "seed text that must not be audited", previous: "custom text that must not be audited", changed: true });
		expect(h.calls).toEqual([{ url: "https://api.test/v1/instances/inst%2Fone/resync-identity", method: "POST", body: null }]);
		const completed = h.events().find((event) => event.action === "completed");
		expect(completed).toMatchObject({ tool: "resync_instance_personality", input: { instance_id: "inst/one" }, result: { changed: true } });
		expect(JSON.stringify(completed)).not.toContain("seed text");
		expect(JSON.stringify(completed)).not.toContain("custom text");
	});

	it("does not record a failed API response as a completed identity overwrite", async () => {
		const h = setup({ status: 404, body: { error: "This agent has no seed personality to sync from." } });
		const result = JSON.parse((await h.run({ confirm: "resync_instance_personality" }))?.content[0].text ?? "{}");
		expect(result).toEqual({ error: "This agent has no seed personality to sync from." });
		expect(h.events().filter((event) => event.action === "completed")).toHaveLength(0);
	});
});
