/**
 * `coding_session_restart` reports what the restart actually did (#1262). Success is the API's `ok: true` and nothing else: no runner
 * connected (the route's 409, or an older API's 200 with `ok:false`) is an error reply that says what to do and writes NO `completed`
 * audit event. The handler is driven for real against a stubbed `fetch`, with the bodies `routes/coding-drive.ts` returns.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCodingSessionTools } from "./coding-tools.js";
import type { McpEnv } from "./http.js";
import type { SafetyContext } from "./safety.js";

type ToolResult = { content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function setup(restart: { status: number; body: unknown } | "none", scopes: string[] = ["read", "write", "runtime"]) {
	const store = new Map<string, string>();
	const kv = {
		get: async (k: string) => store.get(k) ?? null,
		put: async (k: string, v: string) => void (k.startsWith("audit_all:") || store.set(k, v)),
		list: async () => ({ keys: [], list_complete: true }),
	} as unknown as KVNamespace;
	const env: McpEnv = { API_BASE: "https://api.test", OAUTH_KV: kv };
	const calls: Array<{ url: string; method: string }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const method = (init?.method || "GET").toUpperCase();
		calls.push({ url, method });
		if (method === "POST" && restart !== "none") return new Response(JSON.stringify(restart.body), { status: restart.status, headers: { "content-type": "application/json" } });
		return new Response(JSON.stringify({ sessions: [{ id: "S1", status: "active" }] }), { status: 200, headers: { "content-type": "application/json" } });
	});
	const tools = new Map<string, Handler>();
	registerCodingSessionTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server, same shape as coding-session-end.test.ts
		{ tool: (n: string, _d: string, _s: Record<string, unknown>, handler: Handler) => tools.set(n, handler) } as any,
		env,
		(t?: string) => t || "session-token",
		(): SafetyContext => ({ env, subject: "u1", scopes: scopes as SafetyContext["scopes"] }),
	);
	const tool = tools.get("coding_session_restart") as Handler;
	expect(tool, "coding_session_restart is not registered").toBeDefined();
	return {
		calls,
		run: async (args: Record<string, unknown> = { instance_id: "i1", session_id: "S1" }) => (await tool(args)).content[0].text,
		completed: () => Array.from(store.values()).map((v) => JSON.parse(v) as { tool?: string; action?: string }).filter((e) => e.tool === "coding_session_restart" && e.action === "completed"),
	};
}
afterEach(() => vi.unstubAllGlobals());

const OFFLINE_409 = { status: 409, body: { ok: false, runnerConnected: false, error: "Session not restarted: This session is on laptop, which is not connected. Nothing was stopped or relaunched." } };

describe("coding_session_restart (#1262)", () => {
	it("a real relaunch: 'restarted', and exactly one completed audit event", async () => {
		const t = setup({ status: 200, body: { ok: true, runnerConnected: true, resumed: false, seeded: true } });
		expect(await t.run()).toBe("Session S1 restarted.");
		expect(t.completed()).toHaveLength(1);
		expect(t.calls.filter((c) => c.method === "POST")).toEqual([{ url: "https://api.test/v1/instances/i1/coding/sessions/S1/restart", method: "POST" }]);
	});

	it("no runner connected (the route's 409): an error reply with the route's reason — never 'restarted', and no completed audit", async () => {
		const t = setup(OFFLINE_409);
		const text = await t.run();
		expect(text).toMatch(/^Error restarting session S1: Session not restarted: /);
		expect(text).not.toMatch(/Session S1 restarted\./);
		expect(t.completed()).toEqual([]);
	});

	it("an OLDER API answering 200 {ok:false, runnerConnected:false} is treated as the failure it is: says the runner is offline, what to do, and writes no completed audit", async () => {
		const t = setup({ status: 200, body: { ok: false, runnerConnected: false } });
		const text = await t.run();
		expect(text).toMatch(/^Session S1 was NOT restarted: no runner is connected\./);
		expect(text).toMatch(/pags up/);
		expect(text).toMatch(/retry/);
		expect(text).not.toMatch(/Session S1 restarted\./);
		expect(t.completed()).toEqual([]);
	});

	it("a 200 with ok:false and the runner connected (a relaunch the runner did not confirm) is not 'restarted' either", async () => {
		const t = setup({ status: 200, body: { ok: false, runnerConnected: true } });
		const text = await t.run();
		expect(text).toMatch(/^Session S1 was NOT restarted: the runner did not confirm a relaunch\./);
		expect(text).toMatch(/coding_session_capture/);
		expect(t.completed()).toEqual([]);
	});

	it("a 200 with no ok at all (an unknown shape) is not success", async () => {
		const t = setup({ status: 200, body: {} });
		expect(await t.run()).toMatch(/was NOT restarted/);
		expect(t.completed()).toEqual([]);
	});

	it("a failed relaunch (the route's 502) and a failed stop (409) are errors with the route's words and no completed audit", async () => {
		for (const [status, error] of [[502, "git clone failed: repository not found"], [409, "Could not stop the running engine, so it was not relaunched"]] as const) {
			const t = setup({ status, body: { ok: false, runnerConnected: true, error } });
			expect(await t.run()).toBe(`Error restarting session S1: ${error}`);
			expect(t.completed()).toEqual([]);
		}
	});

	it("with no session_id it restarts the first active session; with none active it says so and calls nothing", async () => {
		const ok = setup({ status: 200, body: { ok: true, runnerConnected: true } });
		expect(await ok.run({ instance_id: "i1" })).toBe("Session S1 restarted.");
		vi.unstubAllGlobals();
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ sessions: [{ id: "S0", status: "ended" }] }), { status: 200 }));
		const none = setup("none");
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ sessions: [{ id: "S0", status: "ended" }] }), { status: 200 }));
		expect(await none.run({ instance_id: "i1" })).toBe("No active coding session found.");
	});

	it("is refused without the runtime scope, before any call", async () => {
		const t = setup({ status: 200, body: { ok: true } }, ["read", "write"]);
		const text = await t.run();
		expect(text).toMatch(/runtime/);
		expect(t.calls).toEqual([]);
	});
});
