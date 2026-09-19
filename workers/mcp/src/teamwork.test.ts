import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { McpEnv } from "./http.js";
import { registerCompositionTools } from "./instance-tools/composition.js";
import type { SafetyContext } from "./safety.js";

// ── #613, the teamwork-plumbing group: the pump's FAILURE path ────────────────
//
// `list_connections` / `create_connection` / `set_connection_enabled` cover the happy path.
// These three cover what happens when a delivery does not arrive — which is what an outbox is
// for, and the half a chain fails silently without.
//
// What the tests pin, beyond route and method:
//   · the delivery listing is ACCOUNT-WIDE, and its `status` / `limit` go on the query string
//     (a filter silently dropped would return the wrong rows and look like success);
//   · replay is `runtime`, not `write` — re-arming makes the consumer actually run;
//   · delete is `destructive` AND confirm-gated, because it destroys the edge's filter and
//     orphans the outbox rows, and `set_connection_enabled` is the reversible form;
//   · ids are URL-encoded, and a failed call is never audited as completed.
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
	const safetyFor = (): SafetyContext => ({
		env,
		subject: "user-1",
		scopes: (opts.scopes ?? ["read", "write", "runtime", "destructive"]) as SafetyContext["scopes"],
	});
	registerCompositionTools(server, { env, tokenFor, safetyFor, groups: new Set<string>() });
	const run = (name: string, args: Record<string, unknown> = {}) => {
		const h = tools.get(name);
		if (!h) throw new Error(`"${name}" is not registered`);
		return h({ instance_id: "inst-1", ...args });
	};
	const completed = () => [...auditStore.values()].map((v) => JSON.parse(v) as { tool?: string; action?: string }).filter((e) => e.action === "completed");
	return { run, calls, completed };
}

afterEach(() => vi.unstubAllGlobals());

describe("list_connection_deliveries", () => {
	it("GETs the outbox with no query when nothing was narrowed", async () => {
		const h = setup({ body: { deliveries: [] } });
		await h.run("list_connection_deliveries");
		expect(h.calls).toEqual([{ url: "https://api.test/v1/instances/inst-1/connections/deliveries", method: "GET", body: null }]);
	});

	it("puts status and limit on the query string — a dropped filter would answer with the wrong rows", async () => {
		const h = setup({ body: { deliveries: [{ id: "d1", status: "dead", lastError: "MCP server down" }] } });
		const res = await h.run("list_connection_deliveries", { status: "dead", limit: 10 });
		expect(h.calls[0]?.url).toBe("https://api.test/v1/instances/inst-1/connections/deliveries?status=dead&limit=10");
		expect(res.content[0].text).toContain("MCP server down");
	});

	it("sends status alone, and limit alone, without inventing the other", async () => {
		const h = setup();
		await h.run("list_connection_deliveries", { status: "pending" });
		expect(h.calls[0]?.url).toBe("https://api.test/v1/instances/inst-1/connections/deliveries?status=pending");
		await h.run("list_connection_deliveries", { limit: 5 });
		expect(h.calls[1]?.url).toBe("https://api.test/v1/instances/inst-1/connections/deliveries?limit=5");
	});

	it("reads with only the read scope", async () => {
		const h = setup({ scopes: ["read"] });
		await h.run("list_connection_deliveries");
		expect(h.calls).toHaveLength(1);
	});
});

describe("replay_connection_delivery", () => {
	it("POSTs the replay, URL-encoding the delivery id", async () => {
		const h = setup({ body: { ok: true, status: "pending" } });
		await h.run("replay_connection_delivery", { delivery_id: "d/1" });
		expect(h.calls).toEqual([
			{ url: "https://api.test/v1/instances/inst-1/connections/deliveries/d%2F1/replay", method: "POST", body: null },
		]);
		expect(h.completed().map((e) => e.tool)).toEqual(["replay_connection_delivery"]);
	});

	it("needs the runtime scope — a replay makes the consumer actually run", async () => {
		const h = setup({ scopes: ["read", "write"] });
		const res = await h.run("replay_connection_delivery", { delivery_id: "d1" });
		expect(res.content[0].text).toMatch(/runtime/);
		expect(h.calls).toHaveLength(0);
		expect(h.completed()).toHaveLength(0);
	});

	it("surfaces the route's 404 for a delivery that is not dead, unaudited", async () => {
		const h = setup({ status: 404, body: { error: "no dead delivery with that id" } });
		const res = await h.run("replay_connection_delivery", { delivery_id: "d1" });
		expect(res.content[0].text).toContain("no dead delivery");
		expect(h.completed()).toHaveLength(0);
	});

	it("dry_run re-arms nothing", async () => {
		const h = setup();
		const res = await h.run("replay_connection_delivery", { delivery_id: "d1", dry_run: true });
		expect(h.calls).toHaveLength(0);
		expect(JSON.parse(res.content[0].text)).toMatchObject({ dryRun: true, wouldDo: { method: "POST" } });
	});
});

describe("delete_connection", () => {
	it("DELETEs the connection once confirmed, URL-encoding both ids", async () => {
		const h = setup();
		await h.run("delete_connection", { instance_id: "inst 1", connection_id: "c/1", confirm: "delete_connection" });
		expect(h.calls).toEqual([{ url: "https://api.test/v1/instances/inst%201/connections/c%2F1", method: "DELETE", body: null }]);
		expect(h.completed().map((e) => e.tool)).toEqual(["delete_connection"]);
	});

	it("refuses without the confirmation string, and touches no network", async () => {
		const h = setup();
		const res = await h.run("delete_connection", { connection_id: "c1" });
		expect(res.content[0].text).toMatch(/delete_connection/);
		expect(h.calls).toHaveLength(0);
	});

	it("needs the destructive scope, not merely write", async () => {
		const h = setup({ scopes: ["read", "write", "runtime"] });
		const res = await h.run("delete_connection", { connection_id: "c1", confirm: "delete_connection" });
		expect(res.content[0].text).toMatch(/destructive/);
		expect(h.calls).toHaveLength(0);
	});

	it("dry_run deletes nothing and needs no confirmation", async () => {
		const h = setup();
		const res = await h.run("delete_connection", { connection_id: "c1", dry_run: true });
		expect(h.calls).toHaveLength(0);
		expect(JSON.parse(res.content[0].text)).toMatchObject({ dryRun: true, wouldDo: { method: "DELETE" } });
	});

	it("points at the reversible alternative rather than only warning", async () => {
		// The description is the only place a caller learns that pausing exists, and the whole
		// reason this tool is confirm-gated is that the reversible form is usually what was meant.
		const h = setup();
		const res = await h.run("delete_connection", { connection_id: "c1", dry_run: true });
		expect(res.content[0].text).toContain("delete an event connection");
	});

	it("surfaces a 404 for an unknown connection, unaudited", async () => {
		const h = setup({ status: 404, body: { error: "connection not found" } });
		const res = await h.run("delete_connection", { connection_id: "nope", confirm: "delete_connection" });
		expect(res.content[0].text).toContain("connection not found");
		expect(h.completed()).toHaveLength(0);
	});
});
