import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { McpEnv } from "./http.js";
import { registerRuntimeTools } from "./instance-tools/runtime.js";
import type { SafetyContext } from "./safety.js";

// ── #613, a run's detail view and its human handoffs ──────────────────────────
//
// Seven thin proxies over routes that were console-only, so the tests pin what a proxy gets
// wrong: route and method, that ids are URL-encoded, that the body the route READS is the body
// we send (the input route wants `taskId`, not `task_id`; the browse route wants `dryRun`, and
// it is the INVERSE of `commit`), that `dry_run` never touches the network, that a destructive
// call is confirmed first, and that a refused or failed call is not audited as completed.
//
// The `commit`/`dryRun` inversion is the one that would be silent if it were wrong: getting it
// backwards turns a rehearsal into a real purchase, and every response looks the same.
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
	const audit = new Map<string, string>();
	const kv = {
		get: async (k: string) => audit.get(k) ?? null,
		put: async (k: string, v: string) => void audit.set(k, v),
		delete: async (k: string) => void audit.delete(k),
		list: async () => ({ keys: [...audit.keys()].map((name) => ({ name })), list_complete: true }),
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
	registerRuntimeTools(server, { env, tokenFor, safetyFor, groups: new Set<string>() });
	const run = (name: string, args: Record<string, unknown> = {}) => {
		const h = tools.get(name);
		if (!h) throw new Error(`"${name}" is not registered`);
		return h({ instance_id: "inst-1", ...args });
	};
	const completed = () => [...audit.values()].map((v) => JSON.parse(v) as { tool?: string; action?: string }).filter((e) => e.action === "completed");
	return { run, calls, completed };
}

afterEach(() => vi.unstubAllGlobals());

describe("get_instance_task", () => {
	it("GETs the one task, URL-encoding its id", async () => {
		const h = setup({ body: { id: "t/1", status: "needs_human" } });
		const res = await h.run("get_instance_task", { task_id: "t/1" });
		expect(h.calls).toEqual([{ url: "https://api.test/v1/instances/inst-1/tasks/t%2F1", method: "GET", body: null }]);
		expect(JSON.parse(res.content[0].text)).toMatchObject({ status: "needs_human" });
	});

	it("reads with only the read scope — it is a read tool", async () => {
		const h = setup({ scopes: ["read"] });
		await h.run("get_instance_task", { task_id: "t1" });
		expect(h.calls).toHaveLength(1);
	});
});

describe("delete_instance_task", () => {
	it("DELETEs the ticket once confirmed", async () => {
		const h = setup();
		await h.run("delete_instance_task", { task_id: "t 1", confirm: "delete_instance_task" });
		expect(h.calls).toEqual([{ url: "https://api.test/v1/instances/inst-1/tasks/t%201", method: "DELETE", body: null }]);
		expect(h.completed().map((e) => e.tool)).toEqual(["delete_instance_task"]);
	});

	it("refuses without the confirmation string, and touches no network", async () => {
		const h = setup();
		const res = await h.run("delete_instance_task", { task_id: "t1" });
		expect(res.content[0].text).toMatch(/delete_instance_task/);
		expect(h.calls).toHaveLength(0);
		expect(h.completed()).toHaveLength(0);
	});

	it("needs the destructive scope, not merely write", async () => {
		const h = setup({ scopes: ["read", "write", "runtime"] });
		const res = await h.run("delete_instance_task", { task_id: "t1", confirm: "delete_instance_task" });
		expect(res.content[0].text).toMatch(/destructive/);
		expect(h.calls).toHaveLength(0);
	});

	it("dry_run touches no network and needs no confirmation", async () => {
		const h = setup();
		const res = await h.run("delete_instance_task", { task_id: "t1", dry_run: true });
		expect(h.calls).toHaveLength(0);
		expect(JSON.parse(res.content[0].text)).toMatchObject({ dryRun: true, wouldDo: { method: "DELETE" } });
	});

	it("surfaces the route's refusal to delete a card it could not stop, unaudited", async () => {
		const h = setup({ status: 502, body: { error: "Couldn't stop that task on your runner" } });
		const res = await h.run("delete_instance_task", { task_id: "t1", confirm: "delete_instance_task" });
		expect(res.content[0].text).toContain("Couldn't stop that task");
		expect(h.completed()).toHaveLength(0);
	});
});

describe("answer_instance_input", () => {
	it("POSTs the value under the key the route reads — taskId, not task_id", async () => {
		const h = setup();
		await h.run("answer_instance_input", { task_id: "t1", value: "Australian citizen" });
		expect(h.calls).toEqual([
			{ url: "https://api.test/v1/instances/inst-1/input", method: "POST", body: { taskId: "t1", value: "Australian citizen" } },
		]);
		expect(h.completed().map((e) => e.tool)).toEqual(["answer_instance_input"]);
	});

	it("surfaces the 409 for a takeover session that is gone, and does not audit it as delivered", async () => {
		const h = setup({ status: 409, body: { ok: false, error: "That takeover session is gone (the runner restarted)." } });
		const res = await h.run("answer_instance_input", { task_id: "t1", value: "x" });
		expect(res.content[0].text).toContain("takeover session is gone");
		expect(h.completed()).toHaveLength(0);
	});

	it("dry_run delivers nothing", async () => {
		const h = setup();
		const res = await h.run("answer_instance_input", { task_id: "t1", value: "x", dry_run: true });
		expect(h.calls).toHaveLength(0);
		expect(JSON.parse(res.content[0].text)).toMatchObject({ dryRun: true, wouldDo: { endpoint: "/v1/instances/inst-1/input", method: "POST" } });
	});

	it("is refused without the runtime scope", async () => {
		const h = setup({ scopes: ["read", "write"] });
		const res = await h.run("answer_instance_input", { task_id: "t1", value: "x" });
		expect(res.content[0].text).toMatch(/runtime/);
		expect(h.calls).toHaveLength(0);
	});
});

describe("resume_instance_takeover / end_instance_takeover", () => {
	it("resume POSTs to the takeover resume route with no body", async () => {
		const h = setup();
		await h.run("resume_instance_takeover", { task_id: "t/1" });
		expect(h.calls).toEqual([{ url: "https://api.test/v1/instances/inst-1/takeover/t%2F1/resume", method: "POST", body: null }]);
		expect(h.completed().map((e) => e.tool)).toEqual(["resume_instance_takeover"]);
	});

	it("end POSTs to the takeover end route", async () => {
		const h = setup();
		await h.run("end_instance_takeover", { task_id: "t1" });
		expect(h.calls[0]).toMatchObject({ url: "https://api.test/v1/instances/inst-1/takeover/t1/end", method: "POST" });
	});

	it("an end that failed is surfaced and NOT audited as completed — the agent still holds the browser", async () => {
		const h = setup({ status: 503, body: { error: "no runner" } });
		const res = await h.run("end_instance_takeover", { task_id: "t1" });
		expect(res.content[0].text).toContain("no runner");
		expect(h.completed()).toHaveLength(0);
	});

	it("both dry-run without touching the network", async () => {
		const h = setup();
		await h.run("resume_instance_takeover", { task_id: "t1", dry_run: true });
		await h.run("end_instance_takeover", { task_id: "t1", dry_run: true });
		expect(h.calls).toHaveLength(0);
	});

	it("both need the runtime scope", async () => {
		const h = setup({ scopes: ["read", "write"] });
		expect((await h.run("resume_instance_takeover", { task_id: "t1" })).content[0].text).toMatch(/runtime/);
		expect((await h.run("end_instance_takeover", { task_id: "t1" })).content[0].text).toMatch(/runtime/);
		expect(h.calls).toHaveLength(0);
	});
});

describe("send_instance_takeover_input", () => {
	it("sends a click as the runner's own event shape", async () => {
		const h = setup();
		await h.run("send_instance_takeover_input", { task_id: "t1", type: "click", x: 120, y: 340 });
		expect(h.calls).toEqual([
			{ url: "https://api.test/v1/instances/inst-1/takeover/t1/input", method: "POST", body: { type: "click", x: 120, y: 340 } },
		]);
	});

	it("maps snake_case wheel deltas to the camelCase the runner reads", async () => {
		const h = setup();
		await h.run("send_instance_takeover_input", { task_id: "t1", type: "scroll", x: 1, y: 2, delta_x: 0, delta_y: -240 });
		expect(h.calls[0]?.body).toEqual({ type: "scroll", x: 1, y: 2, deltaX: 0, deltaY: -240 });
	});

	it("sends text and key events without manufacturing coordinates", async () => {
		const h = setup();
		await h.run("send_instance_takeover_input", { task_id: "t1", type: "text", text: "hello" });
		expect(h.calls[0]?.body).toEqual({ type: "text", text: "hello" });
		await h.run("send_instance_takeover_input", { task_id: "t1", type: "key", key: "Enter" });
		expect(h.calls[1]?.body).toEqual({ type: "key", key: "Enter" });
	});

	it("dry_run dispatches nothing", async () => {
		const h = setup();
		const res = await h.run("send_instance_takeover_input", { task_id: "t1", type: "click", x: 1, y: 2, dry_run: true });
		expect(h.calls).toHaveLength(0);
		expect(JSON.parse(res.content[0].text)).toMatchObject({ dryRun: true, wouldDo: { method: "POST" } });
	});
});

describe("start_instance_browser_task", () => {
	it("rehearses by default — commit omitted means dryRun TRUE on the wire", async () => {
		const h = setup({ body: { workflowId: "wf1", taskId: "t1", status: "running" } });
		await h.run("start_instance_browser_task", { url: "https://example.test/cart", objective: "check the price" });
		expect(h.calls).toEqual([
			{
				url: "https://api.test/v1/instances/inst-1/browse",
				method: "POST",
				body: { url: "https://example.test/cart", objective: "check the price", dryRun: true },
			},
		]);
	});

	it("commit:true is the ONLY way to send dryRun false", async () => {
		const h = setup();
		await h.run("start_instance_browser_task", { url: "https://example.test", commit: true });
		expect(h.calls[0]?.body).toMatchObject({ dryRun: false });
		const h2 = setup();
		await h2.run("start_instance_browser_task", { url: "https://example.test", commit: false });
		expect(h2.calls[0]?.body).toMatchObject({ dryRun: true });
	});

	it("a rehearsal needs only runtime; a committing run needs destructive", async () => {
		const h = setup({ scopes: ["read", "write", "runtime"] });
		await h.run("start_instance_browser_task", { url: "https://example.test" });
		expect(h.calls).toHaveLength(1);
		const res = await h.run("start_instance_browser_task", { url: "https://example.test", commit: true });
		expect(res.content[0].text).toMatch(/destructive/);
		expect(h.calls).toHaveLength(1);
	});

	it("dry_run starts nothing, and says which of the two it would have done", async () => {
		const h = setup();
		const res = await h.run("start_instance_browser_task", { url: "https://example.test", commit: true, dry_run: true });
		expect(h.calls).toHaveLength(0);
		expect(res.content[0].text).toMatch(/COMMIT/);
	});

	it("surfaces the route's single-flight 409 and does not audit it as started", async () => {
		const h = setup({ status: 409, body: { error: "A run is already in progress on this agent" } });
		const res = await h.run("start_instance_browser_task", { url: "https://example.test" });
		expect(res.content[0].text).toContain("already in progress");
		expect(h.completed()).toHaveLength(0);
	});
});
