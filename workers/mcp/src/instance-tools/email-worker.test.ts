import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerEmailWorkerTools } from "./email-worker.js";

// #1277: the MCP seam for worker-backed mail management. The API owns every decision; these tests hold what this worker
// must keep: no tool can carry or return a bridge secret, a writer is dry-runnable without touching the network, a read-only
// grant cannot change anything, and each tool reaches exactly the owner-scoped route the console would.
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
	registerEmailWorkerTools(
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
const EP = "https://bridge.example.com";

describe("worker-backed mail management over MCP (#1277)", () => {
	it("registers six tools and none of them takes a secret, password or token-like value to store", () => {
		const { tools } = setup();
		expect([...tools.keys()].sort()).toEqual(["begin_email_worker_enrollment", "complete_email_worker_enrollment", "get_instance_email_worker", "set_email_worker_identities", "set_instance_email_worker_account", "test_email_worker_connection"]);
		for (const [name, t] of tools) for (const field of Object.keys(t.schema)) expect(field, `${name}.${field}`).not.toMatch(/secret|password|credential|bearer|api_?key/i);
	});

	it("reads status (and an enrollment's progress) from the owner-scoped route, with the id URL-encoded", async () => {
		const { calls, run } = setup();
		await run("get_instance_email_worker", { instance_id: INSTANCE, enrollment_id: "e 1" });
		expect(calls).toEqual([{ url: "https://api.test/v1/instances/inst%2F1/email-worker/status?enrollment=e%201", method: "GET", body: null }]);
	});

	it("begin: dry_run touches no network; the real call posts the endpoint and returns the API's console link untouched", async () => {
		const { calls, run, events } = setup({ body: { enrollmentId: "enr-1", consoleUrl: "/instances/inst-1/secure-inputs/enr-1" } });
		const dry = await run("begin_email_worker_enrollment", { instance_id: INSTANCE, endpoint: EP, dry_run: true });
		expect(JSON.parse(dry.content[0].text)).toMatchObject({ dryRun: true, tool: "begin_email_worker_enrollment" });
		expect(calls).toHaveLength(0);
		const real = await run("begin_email_worker_enrollment", { instance_id: INSTANCE, endpoint: EP, account_id: "hiring", label: "Hiring Comms" });
		expect(calls).toEqual([{ url: "https://api.test/v1/instances/inst%2F1/email-worker/enrollments", method: "POST", body: JSON.stringify({ endpoint: EP, accountId: "hiring", label: "Hiring Comms" }) }]);
		expect(JSON.parse(real.content[0].text).consoleUrl).toBe("/instances/inst-1/secure-inputs/enr-1");
		expect(events().some((e) => e.tool === "begin_email_worker_enrollment" && e.action === "completed")).toBe(true);
	});

	it("complete: posts to the enrollment's own route; a refusal is reported with its code and is not audited as completed", async () => {
		const ok = setup({ body: { ok: true } });
		await ok.run("complete_email_worker_enrollment", { instance_id: INSTANCE, enrollment_id: "enr-1" });
		expect(ok.calls).toEqual([{ url: "https://api.test/v1/instances/inst%2F1/email-worker/enrollments/enr-1/complete", method: "POST", body: null }]);
		vi.unstubAllGlobals();
		const refused = setup({ body: { error: "The owner has not entered the bridge secret yet", code: "not_entered" } });
		const r = await refused.run("complete_email_worker_enrollment", { instance_id: INSTANCE, enrollment_id: "enr-1" });
		expect(r.content[0].text).toMatch(/not entered/);
		expect(refused.events().some((e) => e.tool === "complete_email_worker_enrollment" && e.action === "completed")).toBe(false);
	});

	it("pin and identities: dry-runnable, then PUT to the same routes the console uses", async () => {
		const { calls, run } = setup();
		await run("set_instance_email_worker_account", { instance_id: INSTANCE, endpoint: EP, dry_run: true });
		await run("set_email_worker_identities", { instance_id: INSTANCE, endpoint: EP, approved_senders: ["admin@freeappstore.online"], dry_run: true });
		await run("test_email_worker_connection", { instance_id: INSTANCE, dry_run: true });
		expect(calls).toHaveLength(0);
		await run("set_instance_email_worker_account", { instance_id: INSTANCE, endpoint: EP });
		await run("set_instance_email_worker_account", { instance_id: INSTANCE });
		await run("set_email_worker_identities", { instance_id: INSTANCE, endpoint: EP, approved_senders: ["admin@freeappstore.online"], reply_identity: "admin@freeappstore.online" });
		await run("test_email_worker_connection", { instance_id: INSTANCE });
		expect(calls).toEqual([
			{ url: "https://api.test/v1/instances/inst%2F1/email-worker/account", method: "PUT", body: JSON.stringify({ endpoint: EP, accountId: "" }) },
			{ url: "https://api.test/v1/instances/inst%2F1/email-worker/account", method: "PUT", body: "{}" },
			{ url: "https://api.test/v1/email-worker/connections/identities", method: "PUT", body: JSON.stringify({ endpoint: EP, accountId: "", approvedSenders: ["admin@freeappstore.online"], replyIdentity: "admin@freeappstore.online" }) },
			{ url: "https://api.test/v1/instances/inst%2F1/email-worker/test", method: "POST", body: "{}" },
		]);
	});

	it("a read-only grant can read status but cannot enroll, complete, test, pin or approve", async () => {
		const { calls, run } = setup({ scopes: ["read"] });
		await run("get_instance_email_worker", { instance_id: INSTANCE });
		expect(calls).toHaveLength(1);
		const args = { instance_id: INSTANCE, endpoint: EP, enrollment_id: "e", approved_senders: [] };
		for (const name of ["begin_email_worker_enrollment", "complete_email_worker_enrollment", "test_email_worker_connection", "set_instance_email_worker_account", "set_email_worker_identities"]) {
			const r = await run(name, args);
			expect(r.content[0].text, name).toMatch(/denied|scope|permission|not allowed/i);
		}
		expect(calls).toHaveLength(1);
	});
});
