import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerRuntimeTools } from "./runtime.js";

// #613's final console routes: terminal-tab selection and machine forget. These are intentionally
// driven through the real safety layer: the failure mode here is not a bad proxy, but a proxy that
// accidentally spends a DELETE while claiming it merely previewed one, or loses the blockers the
// console shows before an owner can act.
type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
type Shape = Record<string, z.ZodTypeAny>;

function setup(opts: { scopes?: string[]; body?: unknown; status?: number } = {}) {
	const calls: Array<{ url: string; method: string; body: unknown }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const raw = (init?.body as string | undefined) ?? null;
		calls.push({ url: String(input), method: (init?.method || "GET").toUpperCase(), body: raw ? JSON.parse(raw) : null });
		return new Response(JSON.stringify(opts.body ?? { activeTerminalTarget: "tmux:main" }), {
			status: opts.status ?? 200,
			headers: { "Content-Type": "application/json" },
		});
	});
	const audit = new Map<string, string>();
	const env: McpEnv = {
		API_BASE: "https://api.test",
		OAUTH_KV: {
			get: async (key: string) => audit.get(key) ?? null,
			put: async (key: string, value: string) => void audit.set(key, value),
			list: async () => ({ keys: [], list_complete: true }),
		} as unknown as KVNamespace,
	};
	const tools = new Map<string, Handler>();
	registerRuntimeTools(
		{ tool: (name: string, _description: string, _schema: Shape, handler: Handler) => tools.set(name, handler) } as never,
		{
			env,
			tokenFor: (token?: string) => token || "session-token",
			safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: (opts.scopes ?? ["read", "write", "runtime", "destructive"]) as SafetyContext["scopes"] }),
			groups: new Set(),
		},
	);
	const run = (name: string, args: Record<string, unknown>) => {
		const tool = tools.get(name);
		if (!tool) throw new Error(`missing ${name}`);
		return tool(args);
	};
	const events = () => [...audit.values()].map((value) => JSON.parse(value) as { tool?: string; action?: string; result?: unknown });
	return { calls, events, run };
}

afterEach(() => vi.unstubAllGlobals());

describe("terminal-session MCP parity", () => {
	it("uses explicit read/write consent and preserves the API's clear body", async () => {
		const denied = setup({ scopes: ["write"] });
		const read = await denied.run("get_instance_terminal_session", { instance_id: "inst/one" });
		expect(read.content[0]?.text).toContain('requires MCP scope "read"');
		expect(denied.calls).toHaveLength(0);

		const h = setup();
		await h.run("get_instance_terminal_session", { instance_id: "inst/one" });
		await h.run("set_instance_terminal_session", { instance_id: "inst/one", active_terminal_target: "" });
		expect(h.calls).toEqual([
			{ url: "https://api.test/v1/instances/inst%2Fone/terminal-session", method: "GET", body: null },
			{ url: "https://api.test/v1/instances/inst%2Fone/terminal-session", method: "PUT", body: { activeTerminalTarget: "" } },
		]);
		expect(h.events()).toEqual(expect.arrayContaining([expect.objectContaining({ tool: "set_instance_terminal_session", action: "completed" })]));
	});

	it("never contacts the API while previewing a terminal-session change", async () => {
		const h = setup();
		const result = await h.run("set_instance_terminal_session", { instance_id: "inst/one", active_terminal_target: "tmux:main", dry_run: true });
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject({
			dryRun: true,
			tool: "set_instance_terminal_session",
			wouldDo: { endpoint: "/v1/instances/inst%2Fone/terminal-session" },
		});
		expect(h.calls).toHaveLength(0);
		expect(h.events()).toEqual(expect.arrayContaining([expect.objectContaining({ tool: "set_instance_terminal_session", action: "dry_run" })]));
	});
});

describe("runner-node forget MCP safety", () => {
	it("reads the blocker-rich preflight without mutating", async () => {
		const h = setup({ body: { ok: true, names: ["Mac", "Mac.local"], connected: true, blockers: [{ kind: "pin", id: "i1" }], verdict: { ok: false, reason: "connected" } } });
		const result = await h.run("runner_node_forget_preflight", { node: "Mac/local" });
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject({ blockers: [{ kind: "pin", id: "i1" }], verdict: { reason: "connected" } });
		expect(h.calls).toEqual([{ url: "https://api.test/v1/terminals/nodes/Mac%2Flocal/forget-preflight", method: "GET", body: null }]);
	});

	it("requires destructive scope and exact confirmation, while dry-run stays off-network", async () => {
		const scoped = setup({ scopes: ["read", "write"] });
		expect((await scoped.run("forget_runner_node", { node: "Mac", confirm: "forget_runner_node" })).content[0]?.text).toContain('requires MCP scope "destructive"');
		expect(scoped.calls).toHaveLength(0);

		const h = setup();
		expect((await h.run("forget_runner_node", { node: "Mac" })).content[0]?.text).toContain('requires confirm="forget_runner_node"');
		expect(h.calls).toHaveLength(0);
		const preview = await h.run("forget_runner_node", { node: "Mac/local", dry_run: true });
		expect(JSON.parse(preview.content[0]?.text ?? "{}")).toMatchObject({
			dryRun: true,
			tool: "forget_runner_node",
			wouldDo: { endpoint: "/v1/terminals/nodes/Mac%2Flocal" },
		});
		expect(h.calls).toHaveLength(0);
	});

	it("preserves a server refusal and audits it as denied, not completed", async () => {
		const h = setup({ status: 409, body: { error: "still pinned", reason: "pinned", blockers: [{ kind: "pin", id: "inst-1", node: "Mac" }] } });
		const result = await h.run("forget_runner_node", { node: "Mac/old", confirm: "forget_runner_node" });
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({ error: "still pinned", reason: "pinned", blockers: [{ kind: "pin", id: "inst-1", node: "Mac" }] });
		expect(h.calls).toEqual([{ url: "https://api.test/v1/terminals/nodes/Mac%2Fold", method: "DELETE", body: null }]);
		expect(h.events()).toEqual(expect.arrayContaining([expect.objectContaining({ tool: "forget_runner_node", action: "denied" })]));
		expect(h.events().some((event) => event.tool === "forget_runner_node" && event.action === "completed")).toBe(false);
	});
});
