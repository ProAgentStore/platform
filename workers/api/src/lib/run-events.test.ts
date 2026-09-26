/**
 * A run's end, announced (#579) — on the REAL migrated schema, because every property that matters
 * here is a property of the SQL: the UNIQUE that prevents a duplicate, the outbox's idempotency key,
 * the retry sweep's due-query, the owner filter on the feed.
 */
import { afterEach, describe, expect, it } from "vitest";
import { finishLoopRun } from "./agent-loop-store.js";
import { claimSessionDriver } from "./coding-store.js";
import { runDueDeliveries } from "./connections.js";
import { realSchemaD1, type RealSchemaD1, seedTenant } from "./d1-sqlite.js";
import { routeRunEvents } from "./run-event-routing.js";
import { listRunEvents, recordRunEvent } from "./run-events.js";
import { STALE_RUN_MS, sweepStaleRuns } from "./run-sweeper.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
afterEach(() => {
	d1?.close();
	d1 = undefined as unknown as RealSchemaD1;
});

/** Every dispatch the consumer's DO received, and a switch to make it fail. */
function setup() {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["producer", "consumer"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["theirs"] });
	d1.exec(`UPDATE agent_instances SET status = 'active'`);
	const dispatched: unknown[] = [];
	const consumer = { failing: false };
	const env = {
		DB: d1.DB,
		AGENT: {
			idFromName: (name: string) => name,
			get: () => ({
				fetch: async (req: Request) => {
					if (consumer.failing) return new Response("down", { status: 503 });
					dispatched.push(await req.json());
					return Response.json({ id: "task-1" }, { status: 201 });
				},
			}),
		},
	} as unknown as Env;
	return { env, dispatched, consumer };
}

function startRun(runId: string, opts: { userId?: string; instanceId?: string; startedAt?: number; sessionId?: string } = {}) {
	d1.exec(
		`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, max_iterations, started_at, status, iteration, session_id)
		 VALUES ('${runId}', '${opts.userId ?? "u1"}', '${opts.instanceId ?? "producer"}', 'ship it', 10, ${opts.startedAt ?? Date.now()}, 'running', 3, ${opts.sessionId ? `'${opts.sessionId}'` : "NULL"})`,
	);
}

function connect(eventType: string) {
	d1.exec(
		`INSERT INTO agent_connections (id, user_id, source_instance_id, event_type, target_instance_id, action, config, enabled)
		 VALUES ('conn-${eventType}', 'u1', 'producer', '${eventType}', 'consumer', 'create_task', '{"title":"Run ended"}', 1)`,
	);
}

const count = (sql: string) => (d1.sqlite.prepare(sql).get() as { n: number }).n;
const deliveries = () => d1.sqlite.prepare("SELECT status, attempts, next_attempt_at, trace_id, event_type FROM agent_connection_deliveries").all() as Array<Record<string, unknown>>;

describe("run.finished — one fact per run, from the one terminal writer (#579)", () => {
	it("finishLoopRun records the end with the run's own facts, and the feed returns it", async () => {
		const { env } = setup();
		startRun("run-1");
		await finishLoopRun(env, "run-1", "done", "3 commits pushed", 1_000_000);
		const { events, nextCursor } = await listRunEvents(env, "u1", "producer");
		expect(events).toHaveLength(1);
		expect(events[0].eventType).toBe("run.finished");
		expect(events[0].payload).toMatchObject({
			event: "run.finished",
			runId: "run-1",
			instanceId: "producer",
			status: "completed",
			stopReason: "done",
			detail: "3 commits pushed",
			iterations: 3,
			maxIterations: 10,
			finishedAt: 1_000_000,
			traceId: "run-1",
		});
		expect(events[0].payload.link).toMatch(/\/instances\/producer$/);
		expect(nextCursor).toBe(events[0].seq);
		expect((await listRunEvents(env, "u1", "producer", { since: nextCursor })).events).toEqual([]);
	});

	it("a still-running run records nothing", async () => {
		const { env } = setup();
		startRun("run-1");
		expect(await recordRunEvent(env, "run-1", "run.finished", 1)).toBe("skipped");
		expect(count("SELECT COUNT(*) AS n FROM run_events")).toBe(0);
	});

	it("never throws into the writer — a broken database is a skip", async () => {
		const env = { DB: { prepare: () => { throw new Error("D1 down"); } } } as unknown as Env;
		expect(await recordRunEvent(env, "run-1", "run.finished", 1)).toBe("skipped");
	});
});

describe("duplicate-delivery prevention (#579)", () => {
	it("a retried finish records one event and dispatches to a connection once", async () => {
		const { env, dispatched } = setup();
		connect("run.finished");
		startRun("run-1");
		await finishLoopRun(env, "run-1", "done", "ok", 1_000);
		expect(await recordRunEvent(env, "run-1", "run.finished", 1_000)).toBe("duplicate");
		await finishLoopRun(env, "run-1", "done", "ok", 2_000);
		expect(await routeRunEvents(env)).toMatchObject({ checked: 1, routed: 1 });
		expect(await routeRunEvents(env)).toMatchObject({ checked: 0 });

		expect(count("SELECT COUNT(*) AS n FROM run_events")).toBe(1);
		expect(deliveries()).toHaveLength(1);
		expect(deliveries()[0]).toMatchObject({ status: "delivered", event_type: "run.finished", trace_id: "run-1" });
		expect(dispatched).toHaveLength(1);
	});

	it("a sweep that lost the race to the run's own finish does not call it a stall", async () => {
		const { env } = setup();
		startRun("run-1");
		await finishLoopRun(env, "run-1", "done", "ok", 5_000);
		expect(await recordRunEvent(env, "run-1", "run.stalled", 6_000)).toBe("skipped");
		expect((await listRunEvents(env, "u1", "producer")).events.map((e) => e.eventType)).toEqual(["run.finished"]);
	});
});

describe("routing is at-least-once and overlap-safe (#579)", () => {
	it("an event recorded before a crash is routed by the next tick, and nothing is routed twice", async () => {
		const { env, dispatched } = setup();
		connect("run.finished");
		startRun("run-1");
		await finishLoopRun(env, "run-1", "done", "ok", 1_000);
		expect(dispatched).toEqual([]); // the writer only records
		expect(await routeRunEvents(env)).toMatchObject({ routed: 1 });
		expect(dispatched).toHaveLength(1);
		expect(await routeRunEvents(env)).toMatchObject({ checked: 0 });
		expect(dispatched).toHaveLength(1);
	});

	it("two overlapping ticks deliver once", async () => {
		const { env, dispatched } = setup();
		connect("run.finished");
		startRun("run-1");
		await finishLoopRun(env, "run-1", "done", "ok", 1_000);
		await Promise.all([routeRunEvents(env), routeRunEvents(env)]);
		expect(deliveries()).toHaveLength(1);
		expect(dispatched).toHaveLength(1);
	});

	it("a row whose routing throws stays unrouted for the next tick", async () => {
		const { env } = setup();
		startRun("run-1");
		await finishLoopRun(env, "run-1", "done", "ok", 1_000);
		d1.exec(`UPDATE run_events SET payload = 'not json'`);
		expect(await routeRunEvents(env)).toMatchObject({ checked: 1, routed: 0, failed: 1 });
		expect(count("SELECT COUNT(*) AS n FROM run_events WHERE routed_at IS NULL")).toBe(1);
	});
});

describe("delivery failure and retry (#579 — the existing outbox, now reachable from a run's end)", () => {
	it("a consumer that is down gets the event later: queued with backoff, retried by the sweep, then delivered once", async () => {
		const { env, dispatched, consumer } = setup();
		connect("run.finished");
		startRun("run-1");
		consumer.failing = true;
		await finishLoopRun(env, "run-1", "failed", "provider 400", Date.now());
		expect(await routeRunEvents(env)).toMatchObject({ routed: 1, failed: 0 });

		const [queued] = deliveries();
		expect(queued).toMatchObject({ status: "pending", attempts: 1 });
		expect(queued.next_attempt_at).toBeTruthy();
		expect(dispatched).toEqual([]);

		// Not due yet: the sweep leaves it alone.
		expect((await runDueDeliveries(env, new Date())).checked).toBe(0);

		consumer.failing = false;
		const later = new Date(Date.parse(String(queued.next_attempt_at)) + 1_000);
		expect(await runDueDeliveries(env, later)).toMatchObject({ delivered: 1 });
		expect(deliveries()[0]).toMatchObject({ status: "delivered" });
		expect(dispatched).toHaveLength(1);

		// A tick that routed but died before stamping re-offers the stored payload; the outbox collapses it.
		d1.exec("UPDATE run_events SET routed_at = NULL");
		expect(await routeRunEvents(env)).toMatchObject({ routed: 1 });
		expect(await runDueDeliveries(env, new Date(later.getTime() + 60 * 60_000))).toMatchObject({ checked: 0 });
		expect(deliveries()).toHaveLength(1);
		expect(dispatched).toHaveLength(1);
	});
});

describe("run.stalled — the platform closed it (#579)", () => {
	it("the stale-run sweep announces a distinct run.stalled, routable on its own type", async () => {
		const { env, dispatched } = setup();
		connect("run.stalled");
		const now = Date.now();
		startRun("dead-run", { startedAt: now - STALE_RUN_MS - 60_000 });
		await sweepStaleRuns(env, now);
		await routeRunEvents(env);
		const { events } = await listRunEvents(env, "u1", "producer");
		expect(events.map((e) => [e.eventType, e.payload.runId, e.payload.status])).toEqual([["run.stalled", "dead-run", "failed"]]);
		expect(dispatched).toHaveLength(1);
	});

	it("a run displaced from its coding session is announced as stalled", async () => {
		const { env } = setup();
		d1.exec(
			`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('repo-1', 'producer', 'u1', 'repo-1');
			 INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, driver_id, driver_at)
			 VALUES ('sess-1', 'producer', 'repo-1', 'u1', 'active', 'old-driver', 0)`,
		);
		startRun("old-run", { sessionId: "sess-1" });
		expect(await claimSessionDriver(env, "producer", "u1", "sess-1", "new-driver")).toBe(true);
		const { events } = await listRunEvents(env, "u1", "producer");
		expect(events.map((e) => [e.eventType, e.payload.runId, e.payload.stopReason])).toEqual([["run.stalled", "old-run", "interrupted"]]);
		expect(events[0].payload.link).toMatch(/\/coding\/sess-1$/);
	});
});

describe("owner scoping (#579)", () => {
	it("the feed is filtered by owner AND instance — another owner reads nothing, even naming the instance", async () => {
		const { env } = setup();
		startRun("run-1");
		startRun("run-2", { userId: "u2", instanceId: "theirs" });
		await finishLoopRun(env, "run-1", "done", "mine", 1_000);
		await finishLoopRun(env, "run-2", "done", "theirs", 1_000);
		expect((await listRunEvents(env, "u2", "producer")).events).toEqual([]);
		expect((await listRunEvents(env, "u1", "theirs")).events).toEqual([]);
		expect((await listRunEvents(env, "u1", "producer")).events.map((e) => e.payload.runId)).toEqual(["run-1"]);
	});

	it("an event is recorded under the run's owner, and routed only along that owner's instance's edges", async () => {
		const { env, dispatched } = setup();
		connect("run.finished");
		startRun("run-2", { userId: "u2", instanceId: "theirs" });
		await finishLoopRun(env, "run-2", "done", "theirs", 1_000);
		await routeRunEvents(env);
		expect(d1.sqlite.prepare("SELECT user_id, instance_id FROM run_events").all()).toEqual([{ user_id: "u2", instance_id: "theirs" }]);
		expect(deliveries()).toEqual([]);
		expect(dispatched).toEqual([]);
	});
});
