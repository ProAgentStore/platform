/** The saved agent default and owner override determine actual relay dispatches (#1429). */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { callRunner } from "../lib/runner-client.js";
import { agentCapabilities } from "../lib/agent-capabilities.js";
import type { Env } from "../types.js";
import { callRuntime, type RuntimeRow } from "./instances-runtime.js";
import { registerBrowserModeRoutes } from "./instances-browser-mode.js";

vi.mock("../lib/auth.js", async () => ({ ...(await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js")), requireUser: async () => ({ uid: "u1", roles: [] }), requireCreator: async () => ({ uid: "u1", roles: ["creator"] }) }));
const { agentRoutes } = await import("./agents.js");
let d1: RealSchemaD1;
let app: Hono<{ Bindings: Env }>;
beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1", "i2"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["other"] });
	d1.exec(`INSERT INTO instance_runtimes (instance_id, user_id, placement, endpoint_url, runner_version) VALUES ('i1', 'u1', 'local', 'http://runner', '0.4.197'), ('i2', 'u1', 'local', 'http://runner', '0.4.197')`);
	app = new Hono<{ Bindings: Env }>();
	const instances = new Hono<{ Bindings: Env }>();
	registerBrowserModeRoutes(instances);
	app.route("/instances", instances).route("/agents", agentRoutes);
	app.onError((e, c) => e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500));
});
afterEach(() => d1.close());
async function call(path: string, body?: unknown) {
	const res = await app.request(path, { method: body === undefined ? "GET" : "PUT", headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, { DB: d1.DB } as Env);
	return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe("browser mode configuration", () => {
	it("inherits agent defaults, lets instances differ, and null clears only the override", async () => {
		expect((await call("/instances/i1/browser-mode")).body).toMatchObject({ mode: null, agentDefault: null, effective: null, source: "runner" });
		expect((await call("/agents/agent-1/capabilities", { browserMode: "headed" })).status).toBe(200);
		expect((await call("/instances/i1/browser-mode")).body).toMatchObject({ effective: "headed", source: "agent" });
		expect((await call("/instances/i1/browser-mode", { mode: "headless" })).body).toMatchObject({ mode: "headless", agentDefault: "headed", effective: "headless", source: "instance" });
		expect((await call("/instances/i2/browser-mode")).body.effective).toBe("headed");
		expect((await call("/instances/i1/browser-mode", { mode: null })).body).toMatchObject({ mode: null, effective: "headed", source: "agent" });
		expect((await call("/agents/agent-1/capabilities", { browserMode: null })).body.browserMode).toBeNull();
		expect((await call("/instances/i1/browser-mode")).body.source).toBe("runner");
	});

	it("refuses invalid settings and non-owner reads/writes without changing stored values", async () => {
		await call("/instances/i1/browser-mode", { mode: "headed" });
		for (const body of [{}, { mode: "headfull" }, { mode: false }, { mode: "headed", extra: 1 }]) expect((await call("/instances/i1/browser-mode", body)).status).toBe(400);
		expect((await call("/agents/agent-1/capabilities", { browserMode: "invalid" })).status).toBe(400);
		expect((await call("/agents/agent-1", { capabilities: { browserMode: "invalid" } })).status).toBe(400);
		const create = await app.request("/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: "bad-mode", name: "Bad mode", capabilities: { browserMode: "invalid" } }) }, { DB: d1.DB } as Env);
		expect(create.status).toBe(400);
		expect((await call("/instances/other/browser-mode")).status).toBe(404);
		expect((await call("/instances/other/browser-mode", { mode: "headless" })).status).toBe(404);
		expect((await call("/instances/i1/browser-mode")).body.mode).toBe("headed");
	});

	it("exposes the declared mode through resolved capabilities with or without surfaces", () => {
		for (const surfaces of [undefined, []]) expect(agentCapabilities({ config: JSON.stringify({ capabilities: { surfaces, browserMode: "headed" } }) }).browserMode).toBe("headed");
	});

	it("dispatches persisted mode on every browser path, with owner overrides authoritative over payloads", async () => {
		await call("/agents/agent-1/capabilities", { browserMode: "headed" });
		await call("/instances/i1/browser-mode", { mode: "headless" });
		const sent: Record<string, unknown>[] = [];
		const env = { DB: d1.DB, RELAY: { idFromName: (id: string) => id, get: () => ({ fetch: async (req: Request) => { sent.push(await req.json() as Record<string, unknown>); return Response.json({ ok: true }); } }) } } as unknown as Env;
		const conn = { env, instanceId: "i1", userId: "u1", endpointUrl: "", token: "", relayName: "i1" };
		for (const path of ["/browser/act", "/browser/snapshot", "/local-browser/start", "/local-apply/start", "/takeover/frame", "/tasks"]) await callRunner(conn, path, { type: "browser.task", browserMode: "headed" });
		await callRuntime(env, { instance_id: "i1", user_id: "u1", runner_version: "0.4.197" } as RuntimeRow, "/local-browser/run", { method: "POST" });
		await callRuntime(env, { instance_id: "i1", user_id: "u1", runner_version: "0.4.197" } as RuntimeRow, "/local-apply/run", { method: "POST" });
		expect(sent).toHaveLength(8);
		for (const dispatch of sent) expect(dispatch.browserMode).toBe("headless");
		await callRunner({ ...conn, instanceId: "i2" }, "/browser/act");
		expect(sent.at(-1)?.browserMode).toBe("headed");
		await call("/agents/agent-1/capabilities", { browserMode: null });
		await callRunner({ ...conn, instanceId: "i2" }, "/browser/act");
		expect(sent.at(-1)).not.toHaveProperty("browserMode");
		d1.exec("UPDATE instance_runtimes SET runner_version = '0.4.194' WHERE instance_id = 'i1'");
		const before = sent.length;
		await expect(callRunner(conn, "/browser/act")).rejects.toThrow("requires CLI 0.4.197");
		await expect(callRuntime(env, { instance_id: "i1", user_id: "u1", runner_version: "0.4.194" } as RuntimeRow, "/local-browser/run")).rejects.toThrow("requires CLI 0.4.197");
		expect(sent).toHaveLength(before);
		for (const type of ["local_browser.research", "local_browser.apply"]) await expect(callRunner(conn, "/tasks", { type })).rejects.toThrow("requires CLI 0.4.197");
		d1.exec(`INSERT INTO instance_runtime_tasks (id,instance_id,user_id,type,status,payload,created_at,updated_at) VALUES ('approval-browser','i1','u1','browser.open','needs_approval','{}',datetime('now'),datetime('now')), ('approval-other','i1','u1','coding.session','needs_approval','{}',datetime('now'),datetime('now'))`);
		await expect(callRuntime(env, { instance_id: "i1", user_id: "u1", runner_version: "0.4.194" } as RuntimeRow, "/tasks/approval-browser/approve", { method: "POST" })).rejects.toThrow("requires CLI 0.4.197");
		await callRunner(conn, "/tasks/approval-other/approve");
		expect(sent.at(-1)?.path).toBe("/tasks/approval-other/approve");

		// Changing the next-session default must not break an existing run on an older runner.
		for (const path of ["/browser/act", "/browser/snapshot", "/browser/complete", "/local-browser/status", "/local-browser/shots", "/local-browser/cancel", "/local-browser/resume", "/local-apply/status", "/takeover/frame"]) {
			await callRunner(conn, path, { taskId: "existing-task" });
			expect(sent.at(-1)?.path).toBe(path);
		}
		await callRuntime(env, { instance_id: "i1", user_id: "u1", runner_version: "0.4.194" } as RuntimeRow, "/local-apply/cancel", { method: "POST" });
		expect(sent.at(-1)?.path).toBe("/local-apply/cancel");

		await callRunner(conn, "/tasks", { type: "coding.session" });
		expect(sent.at(-1)).not.toHaveProperty("browserMode");
		await callRuntime(env, { instance_id: "i1", user_id: "u1", runner_version: "0.4.194" } as RuntimeRow, "/tasks", { method: "POST", body: JSON.stringify({ type: "echo" }) });
		expect(sent.at(-1)).not.toHaveProperty("browserMode");
		await callRunner(conn, "/coding/capture");
		expect(sent.at(-1)).not.toHaveProperty("browserMode");
	});
});
