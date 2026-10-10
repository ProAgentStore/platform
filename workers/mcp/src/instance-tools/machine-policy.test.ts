import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerMachineControlTools } from "./machine-control.js";

// The API owns alias resolution and policy persistence.  These MCP tests protect the seam that
// has caused control-plane gaps before: the stable id must reach the detail/policy endpoints
// verbatim (but URL-safe), a policy writer is auditable and dry-runnable, and a read-only grant
// cannot flip an owner's durable opt-in.
type ToolContent = { content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolContent>;
type Shape = Record<string, z.ZodTypeAny>;

function setup(opts: { scopes?: string[]; body?: unknown } = {}) {
	const calls: Array<{ url: string; method: string; body: string | null }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), method: (init?.method || "GET").toUpperCase(), body: (init?.body as string | undefined) ?? null });
		return new Response(JSON.stringify(opts.body ?? { machine_id: "machine-1", auto_update_policy: { auto_update: false } }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	});
	const store = new Map<string, string>();
	const kv = {
		get: async (key: string) => store.get(key) ?? null,
		put: async (key: string, value: string) => void store.set(key, value),
		list: async () => ({ keys: [...store.keys()].map((name) => ({ name })), list_complete: true }),
	} as unknown as KVNamespace;
	const env: McpEnv = { API_BASE: "https://api.test", OAUTH_KV: kv };
	const tools = new Map<string, { schema: Shape; handler: Handler }>();
	registerMachineControlTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal MCP registrar for the real handlers
		{ tool: (name: string, _description: string, schema: Shape, handler: Handler) => tools.set(name, { schema, handler }) } as any,
		{
			env,
			tokenFor: (token?: string) => token || "session-token",
			safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: (opts.scopes ?? ["read", "write", "runtime"]) as SafetyContext["scopes"] }),
			groups: new Set<string>(),
		},
	);
	const run = (name: string, args: Record<string, unknown> = {}) => {
		const tool = tools.get(name);
		if (!tool) throw new Error(`registerMachineControlTools did not register ${name}`);
		return tool.handler(args);
	};
	const events = () => [...store.values()].map((value) => JSON.parse(value) as { tool?: string; action?: string });
	return { calls, events, run, tools };
}

afterEach(() => vi.unstubAllGlobals());

describe("the physical-machine auto-update policy over MCP (#859)", () => {
	it("registers an owner-scoped reader and a dry-runnable writer keyed by stable machine id", () => {
		const { tools } = setup();
		expect(Object.keys(tools.get("get_machine_policy")?.schema ?? {}).sort()).toEqual(["machine_id", "token"]);
		expect(Object.keys(tools.get("set_machine_policy")?.schema ?? {}).sort()).toEqual(["auto_update", "dry_run", "machine_id", "token"]);
	});

	it("reads the full machine detail through its stable id, never a hostname route", async () => {
		const { calls, run } = setup();
		const result = await run("get_machine_policy", { machine_id: "machine/a" });
		expect(calls).toEqual([{ url: "https://api.test/v1/terminals/machines/machine%2Fa", method: "GET", body: null }]);
		expect(JSON.parse(result.content[0].text)).toMatchObject({ machine_id: "machine-1", auto_update_policy: { auto_update: false } });
	});

	it("PUTs only the requested policy toggle and audits the successful durable change", async () => {
		const { calls, events, run } = setup({ body: { machine_id: "machine-1", auto_update_policy: { auto_update: true } } });
		await run("set_machine_policy", { machine_id: "machine-1", auto_update: true });
		expect(calls).toEqual([{ url: "https://api.test/v1/terminals/machines/machine-1/policy", method: "PUT", body: JSON.stringify({ auto_update: true }) }]);
		expect(events().some((event) => event.tool === "set_machine_policy" && event.action === "completed")).toBe(true);
	});

	it("previews without touching the API", async () => {
		const { calls, run } = setup();
		const preview = JSON.parse((await run("set_machine_policy", { machine_id: "machine-1", auto_update: false, dry_run: true })).content[0].text) as {
			dryRun: boolean;
			wouldDo: { endpoint: string; method: string; body: Record<string, unknown> };
		};
		expect(preview).toMatchObject({
			dryRun: true,
			wouldDo: { endpoint: "/v1/terminals/machines/machine-1/policy", method: "PUT", body: { auto_update: false } },
		});
		expect(calls).toHaveLength(0);
	});

	it("refuses a policy mutation without write permission, leaving no request or completion audit", async () => {
		const { calls, events, run } = setup({ scopes: ["read"] });
		const result = await run("set_machine_policy", { machine_id: "machine-1", auto_update: true });
		expect(result.content[0].text).toMatch(/scope|read-only|permission/i);
		expect(calls).toHaveLength(0);
		expect(events().some((event) => event.tool === "set_machine_policy" && event.action === "completed")).toBe(false);
	});
});
