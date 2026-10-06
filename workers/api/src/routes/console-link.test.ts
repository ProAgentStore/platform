/**
 * GET /v1/instances/:id/console-link (#938) over the real schema: it resolves what the pure builder
 * cannot — ownership of every record named, the tabs THIS instance shows, and the session a run drives.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});

const { instanceRoutes } = await import("./instances.js");

let d1: RealSchemaD1;
beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1'), ('u2', 'u2')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES
	  ('coder', 'u1', 't938-coder', 'Coder', '{"capabilities":{"surfaces":["coding"],"runtime":"coding"}}'),
	  ('rc', 'u1', 't938-repo', 'Repo Chat', '{"capabilities":{"surfaces":["repo"],"tools":["search_knowledge"]}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES
	  ('i1', 'coder', 'u1', 'active', '{}'), ('i2', 'rc', 'u1', 'active', '{}'), ('other', 'coder', 'u2', 'active', '{}')`);
	d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, max_iterations, started_at, session_id) VALUES
	  ('run_code', 'u1', 'i1', 'fix', 5, 1, 'sess_9'), ('run_chat', 'u1', 'i1', 'chat', 5, 1, NULL), ('run_foreign', 'u2', 'other', 'x', 5, 1, 's')`);
	d1.exec(`INSERT INTO instance_runtime_tasks (id, instance_id, user_id, type, status, payload, created_at, updated_at) VALUES ('t_7', 'i1', 'u1', 'browser', 'running', '{}', 1, 1)`);
	d1.exec(`INSERT INTO secure_input_requests (id, instance_id, user_id, label, destination_scope, expires_at) VALUES ('sir_3', 'i1', 'u1', 'OTP', 'env', '2099-01-01')`);
});
afterEach(() => d1.close());

async function link(instanceId: string, query = "") {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(`/v1/instances/${instanceId}/console-link${query}`, {}, { DB: d1.DB } as unknown as Env);
	return { status: res.status, body: (await res.json()) as { url?: string; path?: string; lands?: string; error?: string } };
}

describe("GET /v1/instances/:id/console-link (#938)", () => {
	it("links the instance, absolute and as a path", async () => {
		expect((await link("i1")).body).toMatchObject({ url: "https://proagentstore.online/console/instances/i1", path: "/console/instances/i1" });
	});

	it("links a section the instance shows, and refuses one it does not", async () => {
		expect((await link("i1", "?section=Coding")).body.path).toBe("/console/instances/i1/coding");
		const refused = await link("i2", "?section=coding");
		expect(refused.status).toBe(400);
		expect(refused.body.error).toMatch(/does not show the Coding tab.*It shows: chat, repo/);
	});

	it("links a coding run to its session, and a chat run to the Assistant", async () => {
		expect((await link("i1", "?run_id=run_code")).body.path).toBe("/console/instances/i1/coding/sess_9");
		expect((await link("i1", "?run_id=run_chat")).body.path).toBe("/console/instances/i1");
	});

	it("links a task and a secret request to their own pages", async () => {
		expect((await link("i1", "?task_id=t_7")).body.path).toBe("/console/instances/i1/tasks/t_7");
		expect((await link("i1", "?secure_input_id=sir_3")).body.path).toBe("/console/instances/i1/secure-inputs/sir_3");
	});

	it("404s a record that is not this owner's on this instance, rather than linking a 'not found' page", async () => {
		expect((await link("i1", "?run_id=run_foreign")).status).toBe(404);
		expect((await link("i2", "?task_id=t_7")).status).toBe(404); // the owner's task, but another instance
		expect((await link("i1", "?secure_input_id=nope")).status).toBe(404);
		expect((await link("other")).status).toBe(404);
	});

	it("takes one target, not two", async () => {
		const r = await link("i1", "?section=coding&run_id=run_code");
		expect(r.status).toBe(400);
		expect(r.body.error).toMatch(/not section and run_id/);
	});
});
