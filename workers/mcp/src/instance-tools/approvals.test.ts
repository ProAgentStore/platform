import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerApprovalTools } from "./approvals.js";

// #1268: the MCP seam for the account approval gate. The API owns every decision; these tests hold what this worker must keep:
// there is no tool that can approve or deny, the writer is dry-runnable without touching the network, a read-only grant cannot
// change the gate, and a held answer is audited as held - never as completed.
type ToolContent = { content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolContent>;
type Shape = Record<string, z.ZodTypeAny>;

function setup(opts: { scopes?: string[]; body?: unknown } = {}) {
	const calls: Array<{ url: string; method: string; body: string | null }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), method: (init?.method || "GET").toUpperCase(), body: (init?.body as string | undefined) ?? null });
		return new Response(JSON.stringify(opts.body ?? { ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
	});
	const store = new Map<string, string>();
	const kv = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), list: async () => ({ keys: [...store.keys()].map((name) => ({ name })), list_complete: true }) } as unknown as KVNamespace;
	const env: McpEnv = { API_BASE: "https://api.test", OAUTH_KV: kv };
	const tools = new Map<string, { schema: Shape; handler: Handler }>();
	registerApprovalTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal MCP registrar for the real handlers
		{ tool: (name: string, _d: string, schema: Shape, handler: Handler) => tools.set(name, { schema, handler }) } as any,
		{ env, tokenFor: (t?: string) => t || "session-token", safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: (opts.scopes ?? ["read", "write"]) as SafetyContext["scopes"] }), groups: new Set<string>() },
	);
	const run = (name: string, args: Record<string, unknown> = {}) => {
		const t = tools.get(name);
		if (!t) throw new Error(`not registered: ${name}`);
		return t.handler(args);
	};
	return { calls, run, tools, events: () => [...store.values()].map((v) => JSON.parse(v) as { tool?: string; action?: string }) };
}
afterEach(() => vi.unstubAllGlobals());

describe("account approval gate over MCP (#1268)", () => {
	it("registers a poll, a read and a writer - and nothing that can approve or deny", () => {
		const { tools } = setup();
		expect([...tools.keys()].sort()).toEqual(["approval_status", "get_approval_gate", "set_approval_gate"]);
		for (const name of tools.keys()) expect(name).not.toMatch(/approve|deny|decide/);
	});

	it("polls one request, or lists recent ones, from the owner-scoped routes", async () => {
		const { calls, run } = setup();
		await run("approval_status", { approval_id: "a/1" });
		await run("approval_status", {});
		await run("get_approval_gate", {});
		expect(calls.map((c) => [c.method, c.url])).toEqual([
			["GET", "https://api.test/v1/approvals/a%2F1"],
			["GET", "https://api.test/v1/approvals"],
			["GET", "https://api.test/v1/approval-gate"],
		]);
	});

	it("set: dry_run touches no network; the real call PUTs only the fields given", async () => {
		const { calls, run, events } = setup({ body: { success: true, gate: { enabled: true } } });
		const dry = await run("set_approval_gate", { enabled: true, actions: ["repo_add"], dry_run: true });
		expect(JSON.parse(dry.content[0].text)).toMatchObject({ dryRun: true, tool: "set_approval_gate" });
		expect(calls).toHaveLength(0);
		await run("set_approval_gate", { enabled: true, actions: ["repo_add"], expiry_seconds: 3600 });
		expect(calls).toEqual([{ url: "https://api.test/v1/approval-gate", method: "PUT", body: JSON.stringify({ enabled: true, actions: ["repo_add"], expirySeconds: 3600 }) }]);
		expect(events().some((e) => e.tool === "set_approval_gate" && e.action === "completed")).toBe(true);
	});

	it("a weakening that the gate held is returned as approval_pending and audited as held, not completed", async () => {
		const pending = { status: "approval_pending", approval_id: "ap-1", poll: "/v1/approvals/ap-1", expires_at: "2026-10-23T00:00:00.000Z" };
		const { run, events } = setup({ body: pending });
		const r = await run("set_approval_gate", { enabled: false });
		expect(JSON.parse(r.content[0].text)).toMatchObject(pending);
		expect(events().some((e) => e.action === "completed")).toBe(false);
		expect(events().some((e) => e.tool === "set_approval_gate" && e.action === "held_for_approval")).toBe(true);
	});

	it("a read-only grant can read the gate but cannot change it", async () => {
		const { calls, run } = setup({ scopes: ["read"] });
		await run("get_approval_gate", {});
		await run("approval_status", {});
		expect(calls).toHaveLength(2);
		const r = await run("set_approval_gate", { enabled: false });
		expect(r.content[0].text).toMatch(/denied|scope|permission|not allowed/i);
		expect(calls).toHaveLength(2);
	});
});
