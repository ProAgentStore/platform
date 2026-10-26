/**
 * #1383 through the real MCP tool schemas: disable_instance, enable_instance and list_disabled_instances reach the API with exactly what they
 * were given (the reason in the body, never in the URL), writes are refused to a read-only session, and the include_paused switch on the lists
 * that hide disabled instances by default is forwarded. The handlers are driven for real against a stubbed `fetch`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerBaseTools } from "./base.js";
import { registerRecentTools } from "./recent.js";
import { registerRuntimeTools } from "./runtime.js";
import type { InstanceToolsCtx } from "./shared.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const env: McpEnv = { API_BASE: "https://api.test" };

function setup(scopes: SafetyContext["scopes"] = ["read", "write"]) {
	const calls: Array<{ url: URL; method: string; body: string | null }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null });
		return new Response(JSON.stringify({ success: true, status: "paused", instances: [], nodes: [] }), { status: 200, headers: { "content-type": "application/json" } });
	});
	const tools = new Map<string, Handler>();
	const ctx: InstanceToolsCtx = { env, tokenFor: (t?: string) => t || "session-token", safetyFor: (): SafetyContext => ({ env, subject: "u1", scopes }), groups: new Set() };
	// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server, same shape as objective-lifecycle-tools.test.ts
	const fake = { tool: (n: string, _d: string, _s: unknown, h: Handler) => tools.set(n, h) } as any;
	registerBaseTools(fake, ctx);
	registerRecentTools(fake, ctx);
	registerRuntimeTools(fake, ctx);
	return { tools, calls };
}

afterEach(() => vi.unstubAllGlobals());

describe("disable_instance / enable_instance / list_disabled_instances (#1383)", () => {
	it("disable_instance POSTs /disable with the reason in the BODY and nothing in the query", async () => {
		const { tools, calls } = setup();
		await tools.get("disable_instance")?.({ instance_id: "inst-1", reason: "duplicate of inst-2" });
		const c = calls.find((x) => x.url.pathname === "/v1/instances/inst-1/disable");
		expect(c?.method).toBe("POST");
		expect(JSON.parse(c?.body ?? "null")).toEqual({ reason: "duplicate of inst-2" });
		expect(c?.url.search).toBe("");
	});

	it("disable_instance with no reason sends an empty object, not a made-up one", async () => {
		const { tools, calls } = setup();
		await tools.get("disable_instance")?.({ instance_id: "inst-1" });
		expect(JSON.parse(calls.find((x) => x.url.pathname.endsWith("/disable"))?.body ?? "null")).toEqual({});
	});

	it("enable_instance POSTs /enable with no body", async () => {
		const { tools, calls } = setup();
		await tools.get("enable_instance")?.({ instance_id: "inst-1" });
		const c = calls.find((x) => x.url.pathname === "/v1/instances/inst-1/enable");
		expect(c?.method).toBe("POST");
		expect(c?.body).toBeNull();
	});

	it("dry_run says what would happen and calls nothing", async () => {
		const { tools, calls } = setup();
		const out = await tools.get("disable_instance")?.({ instance_id: "inst-1", reason: "x", dry_run: true });
		expect(calls).toEqual([]);
		expect(out?.content[0].text).toMatch(/inst-1/);
		const out2 = await tools.get("enable_instance")?.({ instance_id: "inst-1", dry_run: true });
		expect(calls).toEqual([]);
		expect(out2?.content[0].text).toMatch(/inst-1/);
	});

	it("a read-only session cannot disable or enable: the write is refused before any request", async () => {
		const { tools, calls } = setup(["read"]);
		await tools.get("disable_instance")?.({ instance_id: "inst-1" });
		await tools.get("enable_instance")?.({ instance_id: "inst-1" });
		expect(calls).toEqual([]);
	});

	it("list_disabled_instances is a read of the Disabled list, with no arguments to invent", async () => {
		const { tools, calls } = setup(["read"]);
		await tools.get("list_disabled_instances")?.({});
		expect(calls).toHaveLength(1);
		expect(calls[0].url.pathname).toBe("/v1/instances/my/disabled-instances");
		expect(calls[0].method).toBe("GET");
		expect(calls[0].url.search).toBe("");
	});
});

describe("the lists that hide disabled instances by default can be asked for them (#1383)", () => {
	it("account_activity and list_runner_nodes forward include_paused only when it is set", async () => {
		const { tools, calls } = setup(["read"]);
		await tools.get("account_activity")?.({});
		await tools.get("account_activity")?.({ include_paused: true });
		await tools.get("list_runner_nodes")?.({});
		await tools.get("list_runner_nodes")?.({ include_paused: true });
		const seen = calls.map((c) => c.url.pathname + c.url.search).filter((p) => p.includes("/activity") || p.includes("/nodes"));
		expect(seen).toEqual(["/v1/instances/my/activity", "/v1/instances/my/activity?include_paused=1", "/v1/terminals/nodes", "/v1/terminals/nodes?include_paused=1"]);
	});
});
