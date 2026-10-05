/**
 * `/my/activity` names its instances, and names them the way `/my/instances` does (#923).
 *
 * `account_activity` forwards `/my/activity`; `recent_instances` and `my_instances` take names from
 * `/my/instances`. A roster of dozens returned by the first as bare ids could only be read by
 * joining it against the second — and two routes computing a name independently is how one instance
 * gets called two things. So the test reads both routes over the real schema and holds every
 * instance to one name and one slug.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});

const { instanceRoutes } = await import("./instances.js");

let d1: RealSchemaD1;
beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: [] });
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u2', 'u2')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name) VALUES ('ag-coder', 'u1', 't923-coder', 'Repo Coder'), ('ag-op', 'u1', 't923-operator', 'tmux Operator')`);
	// Two instances of ONE agent — only a display name tells them apart — and one of another agent.
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES
	  ('i-fas', 'ag-coder', 'u1', 'active', '{"displayName":"FAS FreeAppStore Coder"}'),
	  ('i-plain', 'ag-coder', 'u1', 'active', '{}'),
	  ('i-op', 'ag-op', 'u1', 'paused', '{}'),
	  ('i-other', 'ag-op', 'u2', 'active', '{}')`);
	const run = (id: string, inst: string, user = "u1") =>
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at) VALUES ('${id}', '${user}', '${inst}', 'x', 'running', 10, ${Date.now()})`);
	run("r1", "i-fas");
	run("r2", "i-plain");
	d1.exec(`INSERT INTO instance_objective_queue (id, instance_id, user_id, objective, status, created_at) VALUES ('q1', 'i-op', 'u1', 'later', 'pending', ${Date.now()})`);
	run("r9", "i-other", "u2");
});
afterEach(() => d1.close());

async function get<T>(path: string): Promise<T> {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(path, {}, { DB: d1.DB } as unknown as Env);
	expect(res.status).toBe(200);
	return (await res.json()) as T;
}

type Named = { instanceId?: string; id?: string; name: string | null; slug: string | null };

describe("GET /my/activity names every instance (#923)", () => {
	it("carries name and slug beside each instanceId — the display name when set, else the agent's", async () => {
		const { instances } = await get<{ instances: Named[] }>("/v1/instances/my/activity");
		const byId = Object.fromEntries(instances.map((i) => [i.instanceId, { name: i.name, slug: i.slug }]));
		expect(byId).toEqual({
			"i-fas": { name: "FAS FreeAppStore Coder", slug: "t923-coder" },
			"i-plain": { name: "Repo Coder", slug: "t923-coder" },
			"i-op": { name: "tmux Operator", slug: "t923-operator" },
		});
		// Leads the entry the way recent_instances does, so a reader sees who before what.
		expect(Object.keys(instances[0]).slice(0, 3)).toEqual(["instanceId", "name", "slug"]);
	});

	it("names each instance exactly as /my/instances does — the roster my_instances and recent_instances read", async () => {
		const [activity, roster] = await Promise.all([
			get<{ instances: Named[] }>("/v1/instances/my/activity"),
			get<{ instances: Named[] }>("/v1/instances/my/instances?includePaused=1"),
		]);
		const rosterById = new Map(roster.instances.map((i) => [i.id, { name: i.name, slug: i.slug }]));
		expect(activity.instances.length).toBeGreaterThan(0);
		for (const a of activity.instances) expect({ name: a.name, slug: a.slug }, a.instanceId).toEqual(rosterById.get(a.instanceId as string));
	});

	it("still lists only the caller's own instances", async () => {
		const { instances } = await get<{ instances: Named[] }>("/v1/instances/my/activity");
		expect(instances.map((i) => i.instanceId)).not.toContain("i-other");
	});
});
