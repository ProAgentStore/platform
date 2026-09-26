/**
 * Per-ticket budget and durable progress notes (#865) on the REAL migrated schema. The budget's
 * guarantees are properties of SQL — the affordability test inside `reserve()`'s UPDATE, the
 * conditional bind of a ticket to its pool — so they are driven through the statements themselves.
 */
import { afterEach, describe, expect, it } from "vitest";
import { finishLoopRun } from "./agent-loop-store.js";
import { markExhausted, reserve, settle } from "./delegation-budget-store.js";
import { realSchemaD1, type RealSchemaD1, seedTenant } from "./d1-sqlite.js";
import type { LoopStartInput, LoopStartResult } from "./loop-drivers.js";
import { recordRunEvent } from "./run-events.js";
import { ensureTicketBudget, raiseTicketBudget, ticketBudgetView } from "./ticket-budget.js";
import { appendTicketProgress, listTicketProgress } from "./ticket-progress.js";
import { pickupNextTicket, setTicketAuthority, setTicketQueueEnabled, ticketQueueState } from "./ticket-queue.js";
import { createTicketCard } from "./tickets.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
afterEach(() => {
	d1?.close();
	d1 = undefined as unknown as RealSchemaD1;
});

const DOLLAR = 1_000_000;

function setup() {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["i2"] });
	return { DB: d1.DB, AGENT_LOOP: { create: async () => ({ id: "wf" }) } } as unknown as Env;
}

async function ticket(env: Env, id: string, opts: { instanceId?: string; userId?: string } = {}) {
	return createTicketCard(env, opts.instanceId ?? "i1", opts.userId ?? "u1", { id, type: "ticket", title: `Ticket ${id}`, status: "needs_approval", updatedAt: "2026-09-27T00:00:00Z" }, "human");
}

/** A driver double that ALSO opens a real run row, so a run-end can be written for it. */
function runningStart() {
	const calls: LoopStartInput[] = [];
	const start = async (input: LoopStartInput): Promise<LoopStartResult> => {
		calls.push(input);
		const runId = `run-${calls.length}`;
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, max_iterations, budget_id, started_at, status, iteration)
		         VALUES ('${runId}', '${input.userId}', '${input.instanceId}', 'x', 5, '${input.budgetId}', ${Date.now()}, 'running', 3)`);
		return { ok: true, runId, driver: "chat" };
	};
	return { calls, start };
}
const green = { redDeploy: async () => null };

async function releaseToQueue(env: Env, ticketId: string) {
	await setTicketQueueEnabled(env, "i1", "u1", true);
	await setTicketAuthority(env, "i1", "u1", ticketId, "agent");
}

describe("a ticket owns ONE pool, drawn on by every run started for it (#865)", () => {
	it("opens the pool at the owner's allowance, and returns the same pool every time after", async () => {
		const env = setup();
		const t = await ticket(env, "card-1");
		expect((await raiseTicketBudget(env, "i1", "u1", t.id, 2 * DOLLAR)).ok).toBe(true);
		expect((await ticketBudgetView(env, "i1", "u1", t.id))?.status).toBe("unopened");
		const pool = await ensureTicketBudget(env, "i1", "u1", t.id);
		expect(pool.costMicrosLimit).toBe(2 * DOLLAR);
		expect((await ensureTicketBudget(env, "i1", "u1", t.id)).id).toBe(pool.id);
		expect(await ticketBudgetView(env, "i1", "u1", t.id)).toMatchObject({ budgetId: pool.id, allowanceMicros: 2 * DOLLAR, limitMicros: 2 * DOLLAR, status: "open" });
	});

	it("CONCURRENCY: first uses racing on one ticket all end up on ONE bound pool", async () => {
		const env = setup();
		const t = await ticket(env, "card-1");
		const pools = await Promise.all(Array.from({ length: 5 }, () => ensureTicketBudget(env, "i1", "u1", t.id)));
		const bound = (d1.sqlite.prepare("SELECT budget_id FROM tickets WHERE id = ?").get(t.id) as { budget_id: string }).budget_id;
		expect(new Set(pools.map((p) => p.id))).toEqual(new Set([bound]));
	});

	it("a re-queued ticket's next run draws on the SAME pool — it does not get a fresh allowance per run", async () => {
		const env = setup();
		const t = await ticket(env, "card-1");
		await releaseToQueue(env, t.id);
		const d = runningStart();
		await pickupNextTicket(env, "i1", "u1", { ...green, start: d.start });
		await finishLoopRun(env, "run-1", "failed", "provider 400", Date.now());
		await setTicketAuthority(env, "i1", "u1", t.id, "agent", true);
		await pickupNextTicket(env, "i1", "u1", { ...green, start: d.start });
		expect(d.calls).toHaveLength(2);
		expect(d.calls[1].budgetId).toBe(d.calls[0].budgetId);
		expect(d.calls[0].budgetId).toBe((await ticketBudgetView(env, "i1", "u1", t.id))?.budgetId);
	});
});

describe("budget exhaustion — a runaway ticket parks on ITS limit (#865)", () => {
	it("the ticket's pool refuses a draw past its limit, and another ticket's pool is untouched", async () => {
		const env = setup();
		const a = await ticket(env, "a");
		const b = await ticket(env, "b");
		await raiseTicketBudget(env, "i1", "u1", a.id, 1 * DOLLAR);
		const poolA = await ensureTicketBudget(env, "i1", "u1", a.id);
		const poolB = await ensureTicketBudget(env, "i1", "u1", b.id);

		const first = await reserve(env, "u1", poolA.id, { depth: 0, estimatedCostMicros: 0.6 * DOLLAR });
		expect(first.ok).toBe(true);
		await settle(env, "u1", poolA.id, first.reserved ?? 0, 0.6 * DOLLAR);
		const second = await reserve(env, "u1", poolA.id, { depth: 0, estimatedCostMicros: 0.6 * DOLLAR });
		expect(second).toMatchObject({ ok: false, reason: "cost_exhausted" });
		await markExhausted(env, "u1", poolA.id, "cost_exhausted", 0);
		expect(await ticketBudgetView(env, "i1", "u1", a.id)).toMatchObject({ status: "exhausted", spentMicros: 0.6 * DOLLAR, exhaustedReason: "cost_exhausted" });

		// The runaway spent its own pool, not a shared one.
		expect((await reserve(env, "u1", poolB.id, { depth: 0, estimatedCostMicros: 0.6 * DOLLAR })).ok).toBe(true);
	});

	it("CONCURRENCY: simultaneous draws on one ticket's pool never overbook it", async () => {
		const env = setup();
		const t = await ticket(env, "card-1");
		await raiseTicketBudget(env, "i1", "u1", t.id, 1 * DOLLAR);
		const pool = await ensureTicketBudget(env, "i1", "u1", t.id);
		const draws = await Promise.all(Array.from({ length: 5 }, () => reserve(env, "u1", pool.id, { depth: 0, estimatedCostMicros: 0.4 * DOLLAR })));
		expect(draws.filter((r) => r.ok)).toHaveLength(2);
		expect((await ticketBudgetView(env, "i1", "u1", t.id))?.reservedMicros).toBe(0.8 * DOLLAR);
	});

	it("the queue skips a parked ticket and starts the next one, instead of retrying it every minute", async () => {
		const env = setup();
		const parked = await ticket(env, "parked");
		const next = await ticket(env, "next");
		d1.exec(`UPDATE tickets SET created_at = '2026-01-01 00:00:00' WHERE id = '${parked.id}'`);
		for (const t of [parked, next]) await releaseToQueue(env, t.id);
		const pool = await ensureTicketBudget(env, "i1", "u1", parked.id);
		await markExhausted(env, "u1", pool.id, "cost_exhausted", 0);
		const d = runningStart();
		expect(await pickupNextTicket(env, "i1", "u1", { ...green, start: d.start })).toMatchObject({ started: true, ticketId: next.id });
		expect((await ticketQueueState(env, "i1", "u1", parked.id))?.pickedAt).toBeNull();
	});

	it("a run stopped on budget leaves a PARKED note naming what to do", async () => {
		const env = setup();
		const t = await ticket(env, "card-1");
		await releaseToQueue(env, t.id);
		await pickupNextTicket(env, "i1", "u1", { ...green, start: runningStart().start });
		await finishLoopRun(env, "run-1", "budget", "Stopped at $1.00 of $1.00", Date.now());
		const notes = await listTicketProgress(env, "i1", "u1", t.id);
		expect(notes.map((n) => n.kind)).toEqual(["started", "parked"]);
		expect(notes[1].body).toMatch(/budget ran out after 3 iteration\(s\) — raise it to resume/);
	});
});

describe("resume — only a person raises a ticket's budget, and nothing already spent is lost (#865)", () => {
	it("raising an exhausted pool re-opens it with spend preserved and step headroom restored, notes it, and the queue resumes on the SAME pool", async () => {
		const env = setup();
		const t = await ticket(env, "card-1");
		await raiseTicketBudget(env, "i1", "u1", t.id, 1 * DOLLAR);
		await releaseToQueue(env, t.id);
		const d = runningStart();
		await pickupNextTicket(env, "i1", "u1", { ...green, start: d.start });
		const poolId = d.calls[0].budgetId;
		const draw = await reserve(env, "u1", poolId, { depth: 0, estimatedCostMicros: 0.9 * DOLLAR });
		await settle(env, "u1", poolId, draw.reserved ?? 0, 0.9 * DOLLAR);
		d1.exec(`UPDATE delegation_budgets SET delegations_used = delegations_limit WHERE id = '${poolId}'`);
		await markExhausted(env, "u1", poolId, "delegations_exhausted", 0);
		await finishLoopRun(env, "run-1", "budget", "out of steps", Date.now());

		const raised = await raiseTicketBudget(env, "i1", "u1", t.id, 3 * DOLLAR);
		expect(raised).toMatchObject({ ok: true, view: { status: "open", limitMicros: 3 * DOLLAR, spentMicros: 0.9 * DOLLAR } });
		expect((await reserve(env, "u1", poolId, { depth: 0, estimatedCostMicros: 0.5 * DOLLAR })).ok).toBe(true);

		await setTicketAuthority(env, "i1", "u1", t.id, "agent", true);
		await pickupNextTicket(env, "i1", "u1", { ...green, start: d.start });
		expect(d.calls[1].budgetId).toBe(poolId);
		expect((await listTicketProgress(env, "i1", "u1", t.id)).map((n) => n.kind)).toEqual(["started", "parked", "resumed", "started"]);
	});

	it("an opened pool can be raised, never lowered; one raise is bounded; a nonsense figure is refused", async () => {
		const env = setup();
		const t = await ticket(env, "card-1");
		await raiseTicketBudget(env, "i1", "u1", t.id, 2 * DOLLAR);
		await ensureTicketBudget(env, "i1", "u1", t.id);
		expect(await raiseTicketBudget(env, "i1", "u1", t.id, 1 * DOLLAR)).toMatchObject({ ok: false, status: 409 });
		expect(await raiseTicketBudget(env, "i1", "u1", t.id, 10_000 * DOLLAR)).toMatchObject({ ok: false, status: 400 });
		for (const bad of [0, -5, Number.NaN]) expect(await raiseTicketBudget(env, "i1", "u1", t.id, bad), String(bad)).toMatchObject({ ok: false, status: 400 });
		expect((await ticketBudgetView(env, "i1", "u1", t.id))?.limitMicros).toBe(2 * DOLLAR);
	});

	it("every raise is audited", async () => {
		const env = setup();
		const t = await ticket(env, "card-1");
		await raiseTicketBudget(env, "i1", "u1", t.id, 2 * DOLLAR);
		const ev = d1.sqlite.prepare("SELECT user_id, instance_id, context FROM agent_events WHERE event = 'ticket.budget_raised'").get() as { user_id: string; instance_id: string; context: string };
		expect(ev).toMatchObject({ user_id: "u1", instance_id: "i1" });
		expect(JSON.parse(ev.context)).toMatchObject({ ticketId: t.id, to: 2 * DOLLAR });
	});
});

describe("authorization (#865)", () => {
	it("another owner can neither read, open, raise nor annotate a ticket's budget or progress", async () => {
		const env = setup();
		const t = await ticket(env, "card-1");
		await ensureTicketBudget(env, "i1", "u1", t.id);
		expect(await ticketBudgetView(env, "i1", "u2", t.id)).toBeNull();
		expect(await ticketBudgetView(env, "i2", "u2", t.id)).toBeNull();
		expect(await raiseTicketBudget(env, "i1", "u2", t.id, 5 * DOLLAR)).toMatchObject({ ok: false, status: 404 });
		await expect(ensureTicketBudget(env, "i2", "u2", t.id)).rejects.toThrow(/not found/i);
		expect(await appendTicketProgress(env, { ticketId: t.id, instanceId: "i2", userId: "u2", runId: null, kind: "resumed", body: "injected" })).toBe(false);
		expect(await listTicketProgress(env, "i1", "u2", t.id)).toEqual([]);
		expect((d1.sqlite.prepare("SELECT COUNT(*) AS n FROM ticket_progress").get() as { n: number }).n).toBe(0);
	});

	it("a run on another tenant's instance cannot annotate this ticket, even through a stored relation naming it", async () => {
		const env = setup();
		const t = await ticket(env, "card-1");
		d1.exec(`INSERT INTO ticket_runs (ticket_id, task_id, instance_id, user_id, status) VALUES ('${t.id}', 'evil-run', 'i2', 'u2', 'running')`);
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, max_iterations, started_at, status) VALUES ('evil-run', 'u2', 'i2', 'x', 5, 1, 'running')`);
		await finishLoopRun(env, "evil-run", "done", "I did your ticket", Date.now());
		expect(await listTicketProgress(env, "i1", "u1", t.id)).toEqual([]);
	});
});

describe("progress history — accumulated, idempotent, separate from Q&A (#865)", () => {
	it("records each run's start and end in order across runs, and a repeated end writes nothing new", async () => {
		const env = setup();
		const t = await ticket(env, "card-1");
		await releaseToQueue(env, t.id);
		const d = runningStart();
		await pickupNextTicket(env, "i1", "u1", { ...green, start: d.start });
		const at = Date.now();
		await finishLoopRun(env, "run-1", "done", "3 commits pushed", at);
		await recordRunEvent(env, "run-1", "run.finished", at);
		await setTicketAuthority(env, "i1", "u1", t.id, "agent", true);
		await pickupNextTicket(env, "i1", "u1", { ...green, start: d.start });
		d1.exec(`UPDATE agent_loop_runs SET status = 'failed', stop_reason = 'failed', finished_at = 111 WHERE run_id = 'run-2'`);
		await recordRunEvent(env, "run-2", "run.stalled", 111);

		const notes = await listTicketProgress(env, "i1", "u1", t.id);
		expect(notes.map((n) => [n.kind, n.runId])).toEqual([
			["started", "run-1"],
			["finished", "run-1"],
			["started", "run-2"],
			["stalled", "run-2"],
		]);
		expect(notes[0].body).toMatch(/Started by the queue \(chat\): Ticket: Ticket card-1/);
		expect(notes[0].body).toMatch(/Budget: \$\d+\.\d\d of \$\d+\.\d\d left\./);
		expect(notes[1].body).toMatch(/Run completed \(done\) after 3 iteration\(s\)\. 3 commits pushed/);
		expect(notes[3].body).toMatch(/^Stalled:/);
	});

	it("is not the Q&A thread: progress writes no ticket events, and a question is not a progress note", async () => {
		const env = setup();
		const t = await ticket(env, "card-1");
		await releaseToQueue(env, t.id);
		await pickupNextTicket(env, "i1", "u1", { ...green, start: runningStart().start });
		await finishLoopRun(env, "run-1", "done", "ok", Date.now());
		expect((d1.sqlite.prepare("SELECT COUNT(*) AS n FROM instance_runtime_task_events WHERE type LIKE 'ticket.%'").get() as { n: number }).n).toBe(0);
		d1.exec(`INSERT INTO instance_runtime_task_events (id, instance_id, user_id, task_id, type, payload, created_at) VALUES ('q1', 'i1', 'u1', 'card-1', 'ticket.question', '{"text":"how is it going?"}', datetime('now'))`);
		const notes = await listTicketProgress(env, "i1", "u1", t.id);
		expect(notes.map((n) => n.kind)).toEqual(["started", "finished"]);
		expect(notes.some((n) => n.body.includes("how is it going"))).toBe(false);
	});
});
