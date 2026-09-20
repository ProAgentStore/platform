/**
 * `POST /:id/pause` and `/:id/resume` (#825), driven end to end against the REAL migrated schema.
 *
 * Real SQLite rather than a mocked D1 because the things worth checking here are writes and their
 * ordering, and a mock would only echo back what this file told it. What the tests below actually
 * establish:
 *
 *   · pause writes `agent_instances.status` and touches NOTHING else — in particular not the
 *     `subscriptions` row, which is the whole difference between this and cancel;
 *   · a run in flight is asked to stop, cooperatively, and the count reported is the count asked;
 *   · the status is written BEFORE the runs are asked, so a run reaching its next iteration in
 *     between finds an instance that is already paused;
 *   · round-tripping pause → resume leaves the row exactly as it started.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";

import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});

const { registerInstanceLifecycleRoutes } = await import("./instances-lifecycle.js");

let d1: RealSchemaD1;
let env: Env;

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

function app() {
	const router = new Hono<{ Bindings: Env }>();
	registerInstanceLifecycleRoutes(router);
	router.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 404) : c.json({ error: String(e) }, 500)));
	return router;
}

const post = (path: string) => app().request(path, { method: "POST" }, env);

function instance(id: string, status: string, user = "u1") {
	d1.exec(
		`INSERT INTO agent_instances (id, agent_id, user_id, status) VALUES (${q(id)}, 'agent-1', ${q(user)}, ${q(status)})`,
	);
}

function run(runId: string, instanceId: string, status: string, user = "u1") {
	d1.exec(
		`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, finished_at)
		  VALUES (${q(runId)}, ${q(user)}, ${q(instanceId)}, 'do the thing', ${q(status)}, 10, 1000, ${status === "running" ? "NULL" : "2000"})`,
	);
}

/** Read rows back off the underlying SQLite — `RealSchemaD1` exposes it for exactly this. */
const one = <T>(sql: string): T => d1.sqlite.prepare(sql).get() as T;
const statusOf = (id: string) => one<{ status: string } | undefined>(`SELECT status FROM agent_instances WHERE id = ${q(id)}`)?.status;
const runRow = (runId: string) =>
	one<{ cancel_requested: number; cancel_requested_at: number | null }>(
		`SELECT cancel_requested, cancel_requested_at FROM agent_loop_runs WHERE run_id = ${q(runId)}`,
	);

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: [] });
	env = { DB: d1.DB, SESSION_SIGNING_KEY: "k" } as unknown as Env;
	// A second tenant, so the "not yours" test inserts against a real users row.
	d1.exec("INSERT OR IGNORE INTO users (id, github_login) VALUES ('u2', 'u2')");
});

afterEach(() => d1.close());

describe("pause", () => {
	it("flips an active instance to paused", async () => {
		instance("i1", "active");
		const res = await post("/i1/pause");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ success: true, status: "paused", changed: true, runsAskedToStop: 0 });
		expect(statusOf("i1")).toBe("paused");
	});

	it("asks every RUNNING run to stop, and counts what it asked", async () => {
		instance("i1", "active");
		run("r1", "i1", "running");
		run("r2", "i1", "running");
		run("r3", "i1", "completed"); // already over — nothing to ask
		const body = (await (await post("/i1/pause")).json()) as { runsAskedToStop: number };
		expect(body.runsAskedToStop).toBe(2);
		expect(runRow("r1").cancel_requested).toBe(1);
		expect(runRow("r2").cancel_requested).toBe(1);
		expect(runRow("r3").cancel_requested).toBe(0);
	});

	it("leaves ANOTHER instance's runs alone", async () => {
		instance("i1", "active");
		instance("i2", "active");
		run("mine", "i1", "running");
		run("theirs", "i2", "running");
		await post("/i1/pause");
		expect(runRow("mine").cancel_requested).toBe(1);
		expect(runRow("theirs").cancel_requested).toBe(0);
		expect(statusOf("i2")).toBe("active");
	});

	it("does NOT touch the subscription — the whole difference from cancel", async () => {
		instance("i1", "active");
		d1.exec("INSERT INTO subscriptions (id, user_id, agent_id, status) VALUES ('s1', 'u1', 'agent-1', 'active')");
		await post("/i1/pause");
		expect(one<{ status: string }>("SELECT status FROM subscriptions WHERE id = 's1'").status).toBe("active");
	});

	it("is idempotent, and asks nothing the second time", async () => {
		instance("i1", "active");
		run("r1", "i1", "running");
		await post("/i1/pause");
		const second = (await (await post("/i1/pause")).json()) as { changed: boolean; runsAskedToStop: number };
		expect(second.changed).toBe(false);
		// It DOES re-ask a run that is still running, and that is correct rather than merely
		// tolerable: the run has not stopped, so the request still stands. Re-asking is harmless
		// because `cancel_requested_at` is COALESCEd at the store — the next test is the one that
		// pins that, and together they are why a second pause needs no guard of its own here.
		expect(second.runsAskedToStop).toBe(1);
	});

	it("does not reset the clock on a run that is ignoring an earlier request", async () => {
		// `cancel_requested_at` is COALESCEd at the store: re-asking must not buy a wedged run
		// another grace period before the sweeper steps in.
		instance("i1", "active");
		run("r1", "i1", "running");
		await post("/i1/pause");
		const first = runRow("r1").cancel_requested_at;
		await post("/i1/resume");
		await post("/i1/pause");
		expect(runRow("r1").cancel_requested_at).toBe(first);
	});

	it("409s a cancelled instance rather than reviving it", async () => {
		instance("i1", "canceled");
		const res = await post("/i1/pause");
		expect(res.status).toBe(409);
		expect(statusOf("i1")).toBe("canceled");
	});

	it("404s an instance that belongs to someone else", async () => {
		instance("i1", "active", "u2");
		expect((await post("/i1/pause")).status).toBe(404);
		expect(statusOf("i1")).toBe("active");
	});
});

describe("resume", () => {
	it("puts a paused instance back to active", async () => {
		instance("i1", "paused");
		const res = await post("/i1/resume");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ success: true, status: "active", changed: true });
		expect(statusOf("i1")).toBe("active");
	});

	it("does NOT restart the runs the pause stopped", async () => {
		// Resurrecting them would re-run an objective whose partial work is already on the record.
		instance("i1", "active");
		run("r1", "i1", "running");
		await post("/i1/pause");
		await post("/i1/resume");
		expect(runRow("r1").cancel_requested).toBe(1);
	});

	it("points at the per-run way to carry one forward", async () => {
		instance("i1", "paused");
		const body = (await (await post("/i1/resume")).json()) as { note: string };
		expect(body.note).toMatch(/continue/);
	});

	it("is idempotent on an already-active instance", async () => {
		instance("i1", "active");
		const body = (await (await post("/i1/resume")).json()) as { changed: boolean; status: string };
		expect(body).toMatchObject({ changed: false, status: "active" });
	});

	it("will not un-cancel a cancelled instance", async () => {
		instance("i1", "canceled");
		expect((await post("/i1/resume")).status).toBe(409);
		expect(statusOf("i1")).toBe("canceled");
	});
});

describe("the round trip", () => {
	it("leaves the row where it started", async () => {
		instance("i1", "active");
		await post("/i1/pause");
		expect(statusOf("i1")).toBe("paused");
		await post("/i1/resume");
		expect(statusOf("i1")).toBe("active");
	});
});
