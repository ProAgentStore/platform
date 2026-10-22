/**
 * #1185: `coding_loop_status` (GET /:id/loop and /:id/loop/:runId) reads a run beside its session. A running run parked on a question
 * whose session has ended is `stalled` with the reason; one whose session is live keeps its `waiting` verdict. Real schema.
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
vi.mock("./instances-runtime.js", async () => {
	const actual = await vi.importActual<typeof import("./instances-runtime.js")>("./instances-runtime.js");
	return { ...actual, requireOwnedInstance: async () => undefined };
});

const { toolRoutes } = await import("./tools.js");

let d1: RealSchemaD1;
beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('a1', 'u1', 't1185-loop', 'Coder', '{}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i1', 'a1', 'u1', 'active', '{}')`);
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', 'i1', 'u1', 'demo')`);
	const old = "datetime('now','-1 hour')";
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, ended_at) VALUES ('sDead','i1','r1','u1','ended',${old}), ('sLive','i1','r1','u1','suspended',NULL)`);
	const now = Date.now();
	for (const [id, sid] of [["runDead", "sDead"], ["runLive", "sLive"]]) {
		d1.exec(
			`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, iteration, max_iterations, started_at, session_id, waiting_reason, waiting_ask, parked_since) VALUES ('${id}','u1','i1','x','running',1,10,${now - 3_600_000},'${sid}','decision','{"question":"Which?"}',${now - 60_000})`,
		);
	}
});
afterEach(() => d1.close());

const get = async (path: string) => {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", toolRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(path, {}, { DB: d1.DB } as unknown as Env);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe("run status reconciled with its session (#1185)", () => {
	it("GET /:id/loop/:runId — a parked run whose session ended is stalled and says why", async () => {
		const { status, body } = await get("/v1/instances/i1/loop/runDead");
		expect(status).toBe(200);
		expect(body).toMatchObject({ health: "stalled", sessionEnded: true, session: { id: "sDead", status: "ended" } });
		expect(String(body.waitNote)).toMatch(/session sDead has ended/);
	});

	it("GET /:id/loop/:runId — a parked run on a live (suspended) session keeps its waiting verdict", async () => {
		const { body } = await get("/v1/instances/i1/loop/runLive");
		expect(body).toMatchObject({ health: "waiting", session: { id: "sLive", status: "suspended" } });
		expect(body).not.toHaveProperty("sessionEnded");
	});

	it("GET /:id/loop — the list reconciles each run against its own session", async () => {
		const { body } = await get("/v1/instances/i1/loop");
		const runs = body.runs as Array<{ runId: string; health: string; sessionEnded?: boolean }>;
		expect(runs.find((r) => r.runId === "runDead")).toMatchObject({ health: "stalled", sessionEnded: true });
		expect(runs.find((r) => r.runId === "runLive")).toMatchObject({ health: "waiting" });
	});
});
