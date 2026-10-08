import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerSettingsTools } from "./settings.js";

// ── Why this file exists (#992) ───────────────────────────────────────────────
//
// MCP must expose the SAME effective controls as the console, or the two surfaces disagree about
// what will reach the owner. These three tools are thin proxies, so what is worth pinning is what
// a proxy gets wrong: the route and method, that "no rules" means RESTORE INHERITED (a DELETE,
// not a stored empty list), that `allOff` is sent as itself rather than expanded here into rules
// the API would have to re-derive, that `dry_run` touches no network, and that a refused call is
// not audited as completed. Driven through the real safety layer and `authedCall`; only `fetch`
// and the audit KV are stubbed, as in `account-notifications.test.ts`.

type ToolContent = { content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolContent>;
type Shape = Record<string, z.ZodTypeAny>;

function setup(opts: { scopes?: string[]; body?: unknown } = {}) {
	const calls: Array<{ url: string; method: string; body: string | null }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), method: (init?.method || "GET").toUpperCase(), body: (init?.body as string | undefined) ?? null });
		return new Response(JSON.stringify(opts.body ?? { rules: [], effective: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
	});
	const store = new Map<string, string>();
	const kv = {
		get: async (k: string) => store.get(k) ?? null,
		put: async (k: string, v: string) => void store.set(k, v),
		delete: async (k: string) => void store.delete(k),
		list: async () => ({ keys: [...store.keys()].map((name) => ({ name })), list_complete: true }),
	} as unknown as KVNamespace;
	const env: McpEnv = { API_BASE: "https://api.test", OAUTH_KV: kv };
	const tools = new Map<string, { schema: Shape; handler: Handler }>();
	registerSettingsTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server, as in contract.test.ts
		{ tool: (name: string, _d: string, schema: Shape, handler: Handler) => tools.set(name, { schema, handler }) } as any,
		{
			env,
			tokenFor: (t?: string) => t || "session-token",
			safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: (opts.scopes ?? ["read", "write", "runtime"]) as SafetyContext["scopes"] }),
			groups: new Set<string>(),
		},
	);
	const run = (name: string, args: Record<string, unknown> = {}) => {
		const t = tools.get(name);
		if (!t) throw new Error(`registerSettingsTools did not register "${name}"`);
		return t.handler(args);
	};
	const events = () => [...store.values()].map((v) => JSON.parse(v) as { tool?: string; action?: string });
	return { run, calls, events, tools };
}

const body = (c: { body: string | null }) => JSON.parse(c.body ?? "{}") as Record<string, unknown>;

afterEach(() => vi.unstubAllGlobals());

describe("the notification policy over MCP (#992)", () => {
	it("registers the pair plus the vocabulary a write has to pick from", () => {
		const { tools } = setup();
		for (const name of ["get_instance_notification_policy", "set_instance_notification_policy", "get_notification_vocabulary"]) {
			expect(tools.has(name), name).toBe(true);
		}
		// Every rule field the API accepts is an argument here, or MCP could not express a policy
		// the console can — which is the parity the issue asks for.
		const rules = tools.get("set_instance_notification_policy")?.schema.rules;
		expect(rules).toBeDefined();
		expect(Object.keys(tools.get("set_instance_notification_policy")?.schema ?? {}).sort()).toEqual(["allOff", "dry_run", "instance_id", "rules", "token"]);
	});

	it("reads one instance's policy, and the vocabulary, with no write", async () => {
		const { run, calls } = setup();
		await run("get_instance_notification_policy", { instance_id: "i1" });
		expect(calls[0]).toMatchObject({ url: "https://api.test/v1/instances/i1/notifications", method: "GET" });
		await run("get_notification_vocabulary", {});
		expect(calls[1]).toMatchObject({ url: "https://api.test/v1/instances/notification-vocabulary", method: "GET" });
		expect(calls.every((c) => c.method === "GET")).toBe(true);
	});

	it("PUTs the rules it was given, unexpanded", async () => {
		const { run, calls, events } = setup();
		const rules = [
			{ event: "approval_required", push: true },
			{ type: "apply", severity: "update" as const, push: false },
		];
		await run("set_instance_notification_policy", { instance_id: "i1", rules });
		expect(calls[0]).toMatchObject({ url: "https://api.test/v1/instances/i1/notifications", method: "PUT" });
		expect(body(calls[0])).toEqual({ rules });
		expect(events().some((e) => e.tool === "set_instance_notification_policy" && e.action === "completed")).toBe(true);
	});

	it("sends `allOff` as itself — the API decides what it expands to, so both surfaces agree", async () => {
		const { run, calls } = setup();
		await run("set_instance_notification_policy", { instance_id: "i1", allOff: true });
		expect(calls[0].method).toBe("PUT");
		expect(body(calls[0])).toEqual({ allOff: true });
	});

	it("no rules means RESTORE INHERITED, which is a DELETE and not a stored empty list", async () => {
		const { run, calls } = setup();
		await run("set_instance_notification_policy", { instance_id: "i1" });
		expect(calls[0]).toMatchObject({ url: "https://api.test/v1/instances/i1/notifications", method: "DELETE" });
		const { run: run2, calls: calls2 } = setup();
		await run2("set_instance_notification_policy", { instance_id: "i1", rules: [] });
		expect(calls2[0].method, "an explicit empty list is the same intent").toBe("DELETE");
	});

	it("previews without touching the network, and names the method it would use", async () => {
		const { run, calls } = setup();
		const preview = JSON.parse((await run("set_instance_notification_policy", { instance_id: "i1", allOff: true, dry_run: true })).content[0].text) as {
			dryRun: boolean;
			wouldDo: { method: string; body: Record<string, unknown> };
		};
		expect(preview.dryRun).toBe(true);
		expect(preview.wouldDo).toMatchObject({ method: "PUT", body: { allOff: true } });
		expect(calls, "a dry run must not reach the API").toHaveLength(0);

		const { run: run2, calls: calls2 } = setup();
		const restore = JSON.parse((await run2("set_instance_notification_policy", { instance_id: "i1", dry_run: true })).content[0].text) as {
			wouldDo: { method: string };
		};
		expect(restore.wouldDo.method).toBe("DELETE");
		expect(calls2).toHaveLength(0);
	});

	it("is refused without the write scope, writes nothing, and is not audited as completed", async () => {
		const { run, calls, events } = setup({ scopes: ["read"] });
		const refusal = await run("set_instance_notification_policy", { instance_id: "i1", allOff: true });
		expect(refusal.content[0].text).toMatch(/scope|read-only|permission/i);
		expect(calls).toHaveLength(0);
		expect(events().some((e) => e.tool === "set_instance_notification_policy" && e.action === "completed")).toBe(false);
	});
});
