/**
 * #968 — a run that ends wakes the agent responsible for what comes next.
 *
 * Over the real schema and the REAL transport: `run.finished` is recorded exactly as a driver
 * records it, routed by the per-minute cron onto the connection outbox, and delivered to a second
 * instance whose connection carries the new `start_loop` action. Only the loop workflow binding is
 * faked, because that is the thing a test cannot run.
 *
 * What this is really protecting: the gap was that nothing could start a turn, so a supervisor had
 * to be prompted by a person or poll `subordinate_status`. Each test below is one way that could
 * silently come back — a wake-up that never fires, one that fires twice, or one that fires on
 * someone else's agent.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RealSchemaD1, realSchemaD1, seedTenant } from "./d1-sqlite.js";
import type { Env } from "../types.js";

const { deliverEvent } = await import("./connections.js");
const { runDueDeliveries } = await import("./connections.js");
const { recordRunEvent } = await import("./run-events.js");
const { routeRunEvents } = await import("./run-event-routing.js");

let d1: RealSchemaD1;
/** Every loop the workflow binding was asked to start. */
let started: Array<{ id: string; params: Record<string, unknown> }>;
let workflowThrows: string | null;

const env = () =>
	({
		DB: d1.DB,
		AGENT: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ ok: true }, { status: 201 }) }) },
		AGENT_LOOP: {
			create: async (o: { id: string; params: Record<string, unknown> }) => {
				if (workflowThrows) throw new Error(workflowThrows);
				started.push(o);
				return { id: o.id };
			},
		},
	}) as unknown as Env;

/** The worker whose run ends, and the supervisor that should react to it. */
beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["worker", "lead"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["stranger"] });
	started = [];
	workflowThrows = null;
});
afterEach(() => d1.close());

/** Wire "when the worker's run ends, the lead takes a turn" — the whole feature, as configuration. */
function wire(over: { action?: string; config?: Record<string, unknown>; target?: string; user?: string } = {}) {
	d1.exec(
		`INSERT INTO agent_connections (id, user_id, source_instance_id, event_type, target_instance_id, action, config, enabled)
		 VALUES ('c-wake', '${over.user ?? "u1"}', 'worker', 'run.finished', '${over.target ?? "lead"}', '${over.action ?? "start_loop"}',
		   '${JSON.stringify(over.config ?? { objective: "Review what finished and decide the next step." }).replace(/'/g, "''")}', 1)`,
	);
}

/** A finished run on the worker, recorded by the same writer every driver uses. */
async function finishRun(runId: string, over: { status?: string; detail?: string; stopReason?: string } = {}) {
	const now = Date.now();
	d1.exec(
		`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, max_iterations, started_at, status, stop_reason, detail, iteration, finished_at)
		 VALUES ('${runId}', 'u1', 'worker', 'do the work', 12, ${now - 51_000}, '${over.status ?? "completed"}', '${over.stopReason ?? "done"}', '${(over.detail ?? "objective completed").replace(/'/g, "''")}', 3, ${now})`,
	);
	await recordRunEvent(env(), runId, "run.finished", now);
}

/** The per-minute cron, in order: route the recorded event, then drain the outbox. */
async function tick() {
	await routeRunEvents(env());
	return runDueDeliveries(env());
}

const deliveries = async () =>
	(await d1.DB.prepare("SELECT connection_id, status, attempts, last_error FROM agent_connection_deliveries").all<Record<string, unknown>>()).results ?? [];
const runsOn = async (instanceId: string) =>
	(await d1.DB.prepare("SELECT run_id, objective, status, budget_id FROM agent_loop_runs WHERE instance_id = ?1").bind(instanceId).all<Record<string, unknown>>()).results ?? [];

describe("a finished run wakes the agent that has to react to it (#968)", () => {
	it("completion: the lead takes a turn, told what finished, without a person prompting it", async () => {
		wire();
		await finishRun("run-1");
		await tick();

		// A real run on the LEAD — the thing that could not happen before.
		const runs = await runsOn("lead");
		expect(runs).toHaveLength(1);
		expect(String(runs[0].objective)).toContain("Review what finished and decide the next step.");
		// Correlated: it names the run it is reacting to, its status, and the agent it ran on.
		expect(String(runs[0].objective)).toContain("run run-1");
		expect(String(runs[0].objective)).toContain("status completed");
		expect(String(runs[0].objective)).toContain("agent worker");
		// Started through the real driver path, with its own spend pool.
		expect(started).toHaveLength(1);
		expect(runs[0].budget_id).toBeTruthy();
		expect((await deliveries())[0]).toMatchObject({ status: "delivered" });
	});

	it("failure: a run that FAILED wakes it just the same, and says so", async () => {
		wire();
		await finishRun("run-2", { status: "failed", stopReason: "max_iterations", detail: "gave up after 12 turns" });
		await tick();
		const objective = String((await runsOn("lead"))[0]?.objective ?? "");
		expect(objective).toContain("status failed");
		expect(objective).toContain("stopped on max_iterations");
		expect(objective).toContain("gave up after 12 turns");
	});

	it("retry: a transient failure to start is retried by the outbox, not dropped", async () => {
		wire();
		workflowThrows = "workflow binding unavailable";
		await finishRun("run-3");
		await tick();
		// Nothing is RUNNING — the row the driver opened before the workflow failed is closed, not
		// left claiming the agent. That matters here specifically: a phantom `running` row would make
		// every retry below answer "already taking a turn" and wedge the wake-up permanently.
		expect(started).toHaveLength(0);
		const after = await runsOn("lead");
		expect(after).toHaveLength(1);
		expect(after[0]).toMatchObject({ status: "failed" });
		// And the delivery is PENDING with the reason — not lost, not dead.
		expect((await deliveries())[0]).toMatchObject({ status: "pending", attempts: 1 });
		expect(String((await deliveries())[0].last_error)).toMatch(/workflow binding unavailable|could not take a turn/);

		// The next sweep, once the cause is gone, delivers it.
		workflowThrows = null;
		d1.exec("UPDATE agent_connection_deliveries SET next_attempt_at = 0");
		await runDueDeliveries(env());
		expect(started, "the retry starts the turn the first attempt could not").toHaveLength(1);
		expect(await runsOn("lead")).toHaveLength(2);
		expect((await deliveries())[0]).toMatchObject({ status: "delivered" });
	});

	it("a busy agent is waited for, not woken twice and not forgotten", async () => {
		wire();
		// The lead is mid-turn already.
        d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, max_iterations, started_at, status, iteration)
          VALUES ('lead-busy', 'u1', 'lead', 'already working', 12, ${Date.now()}, 'running', 1)`);
		await finishRun("run-4");
		await tick();
		// No second loop was started on it…
		expect(started).toHaveLength(0);
		// …and the wake-up is still queued, because it WILL be free.
		expect((await deliveries())[0]).toMatchObject({ status: "pending" });
		expect(String((await deliveries())[0].last_error)).toMatch(/already taking a turn/);

		// Once it finishes, the same delivery wakes it.
		d1.exec("UPDATE agent_loop_runs SET status = 'completed', finished_at = 1 WHERE run_id = 'lead-busy'");
		d1.exec("UPDATE agent_connection_deliveries SET next_attempt_at = 0");
		await runDueDeliveries(env());
		expect(started).toHaveLength(1);
	});

	it("idempotency: the same run event delivered again starts nothing new", async () => {
		wire();
		await finishRun("run-5");
		await tick();
		expect(await runsOn("lead")).toHaveLength(1);

		// Re-record (a repeated terminal write) and re-route (an overlapping tick): the run-event
		// table is UNIQUE per (run, type) and the outbox key collapses the repeat.
		await recordRunEvent(env(), "run-5", "run.finished", Date.now());
		d1.exec("UPDATE run_events SET routed_at = NULL");
		await tick();
		// A redelivery of the identical event, straight at the pump.
		await deliverEvent(env(), "worker", "u1", "run.finished", [{ event: "run.finished", runId: "run-5", instanceId: "worker", status: "completed", traceId: "run-5" }], { traceId: "run-5" });
		await runDueDeliveries(env());

		expect(await runsOn("lead"), "one finished run must never produce two turns").toHaveLength(1);
		expect(started).toHaveLength(1);
	});

	it("unauthorized routing: a connection pointing at another owner's agent starts nothing", async () => {
		// The wiring routes are owner-scoped, so this row could not be created through them; it is
		// written directly to prove the EXECUTOR refuses it too, rather than trusting its caller.
		wire({ target: "stranger" });
		await finishRun("run-6");
		await tick();
		expect(await runsOn("stranger")).toHaveLength(0);
		expect(started).toHaveLength(0);
		const d = (await deliveries())[0];
		// Refused, and the refusal is recorded where the owner can see it.
		expect(d.status === "pending" || d.status === "dead").toBe(true);
		expect(String(d.last_error)).toMatch(/does not exist, or is not this owner's/);
	});

	it("never wakes an agent for its OWN run ending — that wiring is an infinite paid loop", async () => {
		// source and target the same instance: each woken turn would end, be recorded, and route
		// straight back. Refused at execution, so it cannot happen however the edge was created.
		d1.exec(
			`INSERT INTO agent_connections (id, user_id, source_instance_id, event_type, target_instance_id, action, config, enabled)
			 VALUES ('c-self', 'u1', 'worker', 'run.finished', 'worker', 'start_loop', '{"objective":"go again"}', 1)`,
		);
		await finishRun("run-self");
		await tick();
		expect(started, "a self-wake must start nothing").toHaveLength(0);
		expect(await runsOn("worker")).toHaveLength(1); // only the original finished run
		expect((await deliveries())[0]).toMatchObject({ status: "delivered" });
	});

	it("an event that is not terminal does not spend a turn", async () => {
		d1.exec(
			`INSERT INTO agent_connections (id, user_id, source_instance_id, event_type, target_instance_id, action, config, enabled)
			 VALUES ('c-lead', 'u1', 'worker', 'lead.created', 'lead', 'start_loop', '{}', 1)`,
		);
		await deliverEvent(env(), "worker", "u1", "lead.created", [{ event: "lead.created", title: "a lead" }], { traceId: "t-1" });
		await runDueDeliveries(env());
		expect(started, "no standing objective and no terminal event: nothing to do").toHaveLength(0);
	});

	it("every other trigger action is untouched — a create_task connection still writes a task", async () => {
		wire({ action: "create_task", config: { title: "The run finished" } });
		await finishRun("run-7");
		await tick();
		expect(started, "create_task must not start a loop").toHaveLength(0);
		expect((await deliveries())[0]).toMatchObject({ status: "delivered" });
	});
});
