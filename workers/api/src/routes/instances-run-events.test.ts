/**
 * GET /v1/instances/:id/run-events (#579) — authorization and the cursor, through the real route on the
 * real migrated schema.
 */
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { finishLoopRun } from "../lib/agent-loop-store.js";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1, seedTenant } from "../lib/d1-sqlite.js";
import { signSession } from "../lib/session.js";
import { runEventRoutes } from "./instances-run-events.js";
import type { Env } from "../types.js";

const SECRET = "run-events-secret";
let d1: RealSchemaD1;
afterEach(() => d1?.close());

async function setup() {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["i2"] });
	const env = { SESSION_SIGNING_KEY: SECRET, DB: d1.DB } as unknown as Env;
	for (const run of ["run-a", "run-b"]) {
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, max_iterations, started_at) VALUES ('${run}', 'u1', 'i1', 'x', 5, 1)`);
		await finishLoopRun(env, run, "done", run, 1_000);
	}
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", runEventRoutes);
	app.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message }, err.status as 400) : c.json({ error: String(err) }, 500)));
	const get = async (path: string, uid?: string) => {
		const res = await app.request(path, uid ? { headers: { Authorization: `Bearer ${await signSession(uid, SECRET, { roles: [] })}` } } : {}, env);
		return { status: res.status, body: (await res.json()) as { events?: Array<{ seq: number; payload: { runId: string } }>; nextCursor?: number } };
	};
	return { get };
}

describe("GET /v1/instances/:id/run-events (#579)", () => {
	it("the owner pages the feed by cursor: all, then only what is new, then nothing", async () => {
		const { get } = await setup();
		const all = await get("/v1/instances/i1/run-events", "u1");
		expect(all.status).toBe(200);
		expect(all.body.events?.map((e) => e.payload.runId)).toEqual(["run-a", "run-b"]);
		const first = await get("/v1/instances/i1/run-events?limit=1", "u1");
		expect(first.body.events?.map((e) => e.payload.runId)).toEqual(["run-a"]);
		const rest = await get(`/v1/instances/i1/run-events?since=${first.body.nextCursor}`, "u1");
		expect(rest.body.events?.map((e) => e.payload.runId)).toEqual(["run-b"]);
		const none = await get(`/v1/instances/i1/run-events?since=${rest.body.nextCursor}`, "u1");
		expect(none.body).toEqual({ events: [], nextCursor: rest.body.nextCursor });
	});

	it("another owner gets 404 for this instance, and reads nothing on their own", async () => {
		const { get } = await setup();
		expect((await get("/v1/instances/i1/run-events", "u2")).status).toBe(404);
		expect((await get("/v1/instances/i2/run-events", "u2")).body.events).toEqual([]);
	});

	it("no session is a 401", async () => {
		const { get } = await setup();
		expect((await get("/v1/instances/i1/run-events")).status).toBe(401);
	});

	it("a cursor that is not a non-negative number is a 400", async () => {
		const { get } = await setup();
		expect((await get("/v1/instances/i1/run-events?since=-1", "u1")).status).toBe(400);
		expect((await get("/v1/instances/i1/run-events?since=abc", "u1")).status).toBe(400);
	});
});
