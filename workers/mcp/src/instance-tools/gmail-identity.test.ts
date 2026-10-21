import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerGmailIdentityTools } from "./gmail-identity.js";

// #1279: the MCP seam for an instance's Gmail identity. The API owns every decision (a sender must be a verified alias); these tests
// hold what this worker must keep: no tool can carry a credential, the writer is dry-runnable without touching the network, a
// read-only grant cannot change anything, and each tool reaches exactly the owner-scoped route the console would.
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
	registerGmailIdentityTools(
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

const INSTANCE = "inst/1";
const URL_ = "https://api.test/v1/instances/inst%2F1/gmail/identity";

describe("Gmail identity over MCP (#1279)", () => {
	it("registers two tools and none takes a credential", () => {
		const { tools } = setup();
		expect([...tools.keys()].sort()).toEqual(["get_instance_gmail_identity", "set_instance_gmail_identity"]);
		for (const [name, t] of tools) for (const field of Object.keys(t.schema)) expect(field, `${name}.${field}`).not.toMatch(/secret|password|credential|bearer|api_?key|refresh/i);
	});

	it("reads from the owner-scoped route with the id URL-encoded", async () => {
		const { calls, run } = setup();
		await run("get_instance_gmail_identity", { instance_id: INSTANCE });
		expect(calls).toEqual([{ url: URL_, method: "GET", body: null }]);
	});

	it("set: dry_run touches no network and shows the request; the real call PUTs it and is audited", async () => {
		const { calls, run, events } = setup({ body: { success: true, identity: { state: "configured" } } });
		const args = { instance_id: INSTANCE, send_as: "admin@freeappstore.online", inbound_scope: ["admin@freeappstore.online"], preview_chars: 4000 };
		const dry = await run("set_instance_gmail_identity", { ...args, dry_run: true });
		expect(JSON.parse(dry.content[0].text)).toMatchObject({ dryRun: true, tool: "set_instance_gmail_identity" });
		expect(calls).toHaveLength(0);
		await run("set_instance_gmail_identity", args);
		expect(calls).toEqual([{ url: URL_, method: "PUT", body: JSON.stringify({ sendAs: "admin@freeappstore.online", inboundScope: ["admin@freeappstore.online"], previewChars: 4000 }) }]);
		expect(events().some((e) => e.tool === "set_instance_gmail_identity" && e.action === "completed")).toBe(true);
	});

	it("clear sends only the clear flag", async () => {
		const { calls, run } = setup();
		await run("set_instance_gmail_identity", { instance_id: INSTANCE, clear: true });
		expect(calls).toEqual([{ url: URL_, method: "PUT", body: JSON.stringify({ clear: true }) }]);
	});

	it("an API refusal (an unverified alias) is reported and is not audited as completed", async () => {
		const { run, events } = setup({ body: { error: "pending@x.test is a send-as address but Google has not verified it" } });
		const r = await run("set_instance_gmail_identity", { instance_id: INSTANCE, send_as: "pending@x.test" });
		expect(r.content[0].text).toMatch(/not verified/);
		expect(events().some((e) => e.action === "completed")).toBe(false);
	});

	it("a read-only grant can read but cannot set", async () => {
		const { calls, run } = setup({ scopes: ["read"] });
		await run("get_instance_gmail_identity", { instance_id: INSTANCE });
		expect(calls).toHaveLength(1);
		const r = await run("set_instance_gmail_identity", { instance_id: INSTANCE, send_as: "a@b.test" });
		expect(r.content[0].text).toMatch(/denied|scope|permission|not allowed/i);
		expect(calls).toHaveLength(1);
	});
});
