import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { McpEnv } from "./http.js";
import { registerAgentTaskTools } from "./instance-tools/agent-tasks.js";
import type { SafetyContext } from "./safety.js";

// ── #613, the standing-agent-tasks group ──────────────────────────────────────
//
// The agent's OWN task store — DO state rendered into its prompt — as opposed to the runtime
// board, which `get_instance_task` and friends cover. Four proxies, and the tests pin the
// things a proxy over THIS store gets wrong:
//
//   · an update sends ONLY the named fields. The DO merges what it receives over the existing
//     task and re-stamps `assignedBy: "user"` plus `updatedAt` on every write, so an empty or
//     manufactured field is not a harmless no-op: it silently changes provenance and un-stales
//     a task nobody meant to touch. Hence the refusal, and hence no invented `status`.
//   · `assignedBy` is never sent on create. The route treats only the literal "trigger" as
//     special and defaults the rest to "user"; sending it would be this worker asserting a
//     provenance that is the route's to decide.
//   · delete is destructive AND confirm-gated, and a 404 for an already-gone task is surfaced
//     rather than reported as success.
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
	registerAgentTaskTools(server, { env, tokenFor, safetyFor, groups: new Set<string>() });
	const run = (name: string, args: Record<string, unknown> = {}) => {
		const h = tools.get(name);
		if (!h) throw new Error(`"${name}" is not registered`);
		return h({ instance_id: "inst-1", ...args });
	};
	const completed = () => [...auditStore.values()].map((v) => JSON.parse(v) as { tool?: string; action?: string }).filter((e) => e.action === "completed");
	return { run, calls, completed };
}

afterEach(() => vi.unstubAllGlobals());

describe("list_agent_tasks", () => {
	it("GETs the agent-tasks route, NOT the runtime board's /tasks", async () => {
		const h = setup({ body: { tasks: [{ id: "t1", title: "Watch the queue", assignedBy: "self" }], limits: { max: 100, injected: 20, staleDays: 30 } } });
		const res = await h.run("list_agent_tasks");
		expect(h.calls).toEqual([{ url: "https://api.test/v1/instances/inst-1/agent-tasks", method: "GET", body: null }]);
		const out = JSON.parse(res.content[0].text);
		expect(out.limits).toMatchObject({ max: 100, staleDays: 30 });
	});

	it("reads with only the read scope", async () => {
		const h = setup({ scopes: ["read"] });
		await h.run("list_agent_tasks");
		expect(h.calls).toHaveLength(1);
	});
});

describe("create_agent_task", () => {
	it("POSTs the title alone when no description was given", async () => {
		const h = setup({ body: { id: "t1", title: "Check the feed", status: "pending", assignedBy: "user" } });
		await h.run("create_agent_task", { title: "Check the feed" });
		expect(h.calls).toEqual([{ url: "https://api.test/v1/instances/inst-1/agent-tasks", method: "POST", body: { title: "Check the feed" } }]);
		expect(h.completed().map((e) => e.tool)).toEqual(["create_agent_task"]);
	});

	it("sends the description when there is one", async () => {
		const h = setup();
		await h.run("create_agent_task", { title: "t", description: "the detail" });
		expect(h.calls[0]?.body).toEqual({ title: "t", description: "the detail" });
	});

	it("never sends assignedBy — the route decides provenance", async () => {
		const h = setup();
		await h.run("create_agent_task", { title: "t", description: "d" });
		expect(h.calls[0]?.body).not.toHaveProperty("assignedBy");
	});

	it("is refused without the write scope", async () => {
		const h = setup({ scopes: ["read"] });
		const res = await h.run("create_agent_task", { title: "t" });
		expect(res.content[0].text).toMatch(/write/);
		expect(h.calls).toHaveLength(0);
	});

	it("surfaces the 409 at the task ceiling, unaudited", async () => {
		const h = setup({ status: 409, body: { error: "Task limit reached (100). Delete or complete some first." } });
		const res = await h.run("create_agent_task", { title: "one too many" });
		expect(res.content[0].text).toContain("Task limit reached");
		expect(h.completed()).toHaveLength(0);
	});

	it("dry_run creates nothing", async () => {
		const h = setup();
		const res = await h.run("create_agent_task", { title: "t", dry_run: true });
		expect(h.calls).toHaveLength(0);
		expect(JSON.parse(res.content[0].text)).toMatchObject({ dryRun: true, wouldDo: { method: "POST" } });
	});
});

describe("update_agent_task", () => {
	it("PUTs only the named field, URL-encoding the task id", async () => {
		const h = setup({ body: { id: "t/1", status: "complete" } });
		await h.run("update_agent_task", { task_id: "t/1", status: "complete" });
		expect(h.calls).toEqual([
			{ url: "https://api.test/v1/instances/inst-1/agent-tasks/t%2F1", method: "PUT", body: { status: "complete" } },
		]);
	});

	it("sends a title edit without inventing a status", async () => {
		const h = setup();
		await h.run("update_agent_task", { task_id: "t1", title: "New title" });
		expect(h.calls[0]?.body).toEqual({ title: "New title" });
	});

	it("refuses an edit that names no field, without a request — an empty PUT still re-stamps provenance", async () => {
		const h = setup();
		const res = await h.run("update_agent_task", { task_id: "t1" });
		expect(res.content[0].text).toMatch(/nothing to update/);
		expect(h.calls).toHaveLength(0);
	});

	it("surfaces the DO's 404 for a task that is not there, unaudited", async () => {
		const h = setup({ status: 404, body: { error: "Task not found" } });
		const res = await h.run("update_agent_task", { task_id: "gone", status: "blocked" });
		expect(res.content[0].text).toContain("Task not found");
		expect(h.completed()).toHaveLength(0);
	});

	it("dry_run edits nothing and names the fields it would send", async () => {
		const h = setup();
		const res = await h.run("update_agent_task", { task_id: "t1", title: "x", status: "pending", dry_run: true });
		expect(h.calls).toHaveLength(0);
		expect(JSON.parse(res.content[0].text)).toMatchObject({ dryRun: true, wouldDo: { method: "PUT", fields: ["title", "status"] } });
	});
});

describe("delete_agent_task", () => {
	it("DELETEs once confirmed", async () => {
		const h = setup({ body: { success: true } });
		await h.run("delete_agent_task", { task_id: "t1", confirm: "delete_agent_task" });
		expect(h.calls).toEqual([{ url: "https://api.test/v1/instances/inst-1/agent-tasks/t1", method: "DELETE", body: null }]);
		expect(h.completed().map((e) => e.tool)).toEqual(["delete_agent_task"]);
	});

	it("refuses without the confirmation string, and touches no network", async () => {
		const h = setup();
		const res = await h.run("delete_agent_task", { task_id: "t1" });
		expect(res.content[0].text).toMatch(/delete_agent_task/);
		expect(h.calls).toHaveLength(0);
	});

	it("needs the destructive scope, not merely write", async () => {
		const h = setup({ scopes: ["read", "write", "runtime"] });
		const res = await h.run("delete_agent_task", { task_id: "t1", confirm: "delete_agent_task" });
		expect(res.content[0].text).toMatch(/destructive/);
		expect(h.calls).toHaveLength(0);
	});

	it("surfaces the 404 for an already-gone task rather than reporting success", async () => {
		const h = setup({ status: 404, body: { error: "Task not found" } });
		const res = await h.run("delete_agent_task", { task_id: "gone", confirm: "delete_agent_task" });
		expect(res.content[0].text).toContain("Task not found");
		expect(h.completed()).toHaveLength(0);
	});

	it("dry_run deletes nothing and needs no confirmation", async () => {
		const h = setup();
		const res = await h.run("delete_agent_task", { task_id: "t1", dry_run: true });
		expect(h.calls).toHaveLength(0);
		expect(JSON.parse(res.content[0].text)).toMatchObject({ dryRun: true, wouldDo: { method: "DELETE" } });
	});
});
