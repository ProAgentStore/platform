/**
 * The opt-in ticket queue (#864) on the REAL migrated schema: every gate that stops unattended work
 * is a property of a SQL statement (the opt-in row, the authority column, the claim, the lease), so
 * it is tested against the statements, not a double that matches their text.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { BuildRun } from "./build-history.js";
import { finishLoopRun } from "./agent-loop-store.js";
import { buildInstanceBoard } from "./board.js";
import { realSchemaD1, type RealSchemaD1, seedTenant } from "./d1-sqlite.js";
import type { LoopStartInput, LoopStartResult } from "./loop-drivers.js";
import {
	isQueueRunnable,
	pickupNextTicket,
	QUEUE_RUNNABLE_STATUSES,
	redDefaultBranchBuild,
	runTicketQueue,
	setTicketAuthority,
	setTicketQueueEnabled,
	ticketQueueEnabled,
	ticketQueueState,
} from "./ticket-queue.js";
import { createTicketCard } from "./tickets.js";
import { isRunnableStatus } from "./actionable-ticket.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
afterEach(() => {
	d1?.close();
	d1 = undefined as unknown as RealSchemaD1;
});

function setup() {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["i2"] });
	const loops: Array<Record<string, unknown>> = [];
	const env = {
		DB: d1.DB,
		// The real chat driver's executor, recorded rather than run.
		AGENT_LOOP: { create: async (o: { params: Record<string, unknown> }) => { loops.push(o.params); return { id: "wf" }; } },
	} as unknown as Env;
	return { env, loops };
}

/** A driver double: records what the queue asked to start, answers as told. */
function fakeStart(answer: (n: number) => LoopStartResult = (n) => ({ ok: true, runId: `run-${n}`, driver: "chat" })) {
	const calls: LoopStartInput[] = [];
	return { calls, start: async (input: LoopStartInput) => { calls.push(input); return answer(calls.length); } };
}
const green = { redDeploy: async () => null };

async function ticket(env: Env, id: string, status = "needs_approval", opts: { instanceId?: string; userId?: string; by?: "human" | "agent" } = {}) {
	return createTicketCard(env, opts.instanceId ?? "i1", opts.userId ?? "u1", { id, type: "ticket", title: `Ticket ${id}`, description: `Do ${id}`, status, updatedAt: "2026-09-27T00:00:00Z" }, opts.by ?? "human");
}
const col = (sql: string) => d1.sqlite.prepare(sql).get() as Record<string, unknown> | undefined;

describe("default OFF, and only a person releases a ticket (#757 §3, §7)", () => {
	it("an instance's queue is off until its owner turns it on — a released ticket is not touched", async () => {
		const { env } = setup();
		const t = await ticket(env, "card-1");
		await setTicketAuthority(env, "i1", "u1", t.id, "agent");
		const d = fakeStart();
		expect(await ticketQueueEnabled(env, "i1", "u1")).toBe(false);
		expect(await pickupNextTicket(env, "i1", "u1", { ...green, start: d.start })).toEqual({ started: false, reason: "disabled" });
		expect(d.calls).toEqual([]);
		expect(col("SELECT queue_picked_at FROM tickets")?.queue_picked_at).toBeNull();
	});

	it("every ticket starts as human-released-only — including the ones an agent creates", async () => {
		const { env } = setup();
		await setTicketQueueEnabled(env, "i1", "u1", true);
		await ticket(env, "by-human");
		await ticket(env, "by-agent", "needs_approval", { by: "agent" });
		const d = fakeStart();
		expect(await pickupNextTicket(env, "i1", "u1", { ...green, start: d.start })).toEqual({ started: false, reason: "none" });
		expect(d.calls).toEqual([]);
		expect((d1.sqlite.prepare("SELECT DISTINCT pickup_authority AS a FROM tickets").all() as Array<{ a: string }>).map((r) => r.a)).toEqual(["human"]);
	});
});

describe("pickup — a released ticket becomes a run that names it (#864)", () => {
	it("starts through the loop driver with its own budget, and the run carries ticketId onto the board", async () => {
		const { env } = setup();
		await setTicketQueueEnabled(env, "i1", "u1", true);
		const t = await ticket(env, "card-1");
		await setTicketAuthority(env, "i1", "u1", t.id, "agent");
		const d = fakeStart();
		const out = await pickupNextTicket(env, "i1", "u1", { ...green, start: d.start });
		expect(out).toEqual({ started: true, ticketId: t.id, runId: "run-1", driver: "chat" });
		expect(d.calls[0]).toMatchObject({ instanceId: "i1", userId: "u1", depth: 0 });
		expect(d.calls[0].objective).toBe("Ticket: Ticket card-1\n\nDo card-1");
		expect(d.calls[0].budgetId).toMatch(/.+/);
		expect(await ticketQueueState(env, "i1", "u1", t.id)).toMatchObject({ authority: "agent", runId: "run-1", note: null });

		const task = col("SELECT type, status, payload FROM instance_runtime_tasks WHERE id = 'run-1'") as { type: string; status: string; payload: string };
		expect(task).toMatchObject({ type: "ticket.run", status: "running" });
		expect(JSON.parse(task.payload)).toMatchObject({ ticketId: t.id, loopRunId: "run-1" });
		const card = (await buildInstanceBoard(env, "i1", "u1")).items.find((i) => i.ticketId === t.id);
		expect(card?.attempts.map((a) => a.id)).toContain("run-1");
	});

	it("takes a ticket once: a picked ticket is not re-offered by the next sweep", async () => {
		const { env } = setup();
		await setTicketQueueEnabled(env, "i1", "u1", true);
		const t = await ticket(env, "card-1");
		await setTicketAuthority(env, "i1", "u1", t.id, "agent");
		const d = fakeStart();
		await pickupNextTicket(env, "i1", "u1", { ...green, start: d.start });
		expect(await pickupNextTicket(env, "i1", "u1", { ...green, start: d.start })).toEqual({ started: false, reason: "none" });
		expect(d.calls).toHaveLength(1);
	});

	it("oldest released ticket first", async () => {
		const { env } = setup();
		await setTicketQueueEnabled(env, "i1", "u1", true);
		const a = await ticket(env, "a");
		const b = await ticket(env, "b");
		d1.exec(`UPDATE tickets SET created_at = '2026-01-01 00:00:00' WHERE id = '${b.id}'`);
		for (const x of [a, b]) await setTicketAuthority(env, "i1", "u1", x.id, "agent");
		expect(await pickupNextTicket(env, "i1", "u1", { ...green, start: fakeStart().start })).toMatchObject({ ticketId: b.id });
	});
});

describe("needs_human and blocked are inviolable (#757 §5)", () => {
	it("the queue's runnable set excludes needs_human, blocked and failed — unlike the human approval set", () => {
		for (const s of ["needs_human", "blocked", "failed"]) {
			expect(isQueueRunnable(s), s).toBe(false);
			expect(isRunnableStatus(s), `${s} is approvable by a PERSON`).toBe(true);
		}
		expect([...QUEUE_RUNNABLE_STATUSES].sort()).toEqual(["needs_approval", "queued"]);
	});

	it("never picks a ticket whose card is needs_human, blocked or failed, and picks the queued one", async () => {
		const { env } = setup();
		await setTicketQueueEnabled(env, "i1", "u1", true);
		for (const s of ["needs_human", "blocked", "failed", "queued"]) {
			const t = await ticket(env, `c-${s}`, s);
			await setTicketAuthority(env, "i1", "u1", t.id, "agent");
		}
		const d = fakeStart();
		const out = await pickupNextTicket(env, "i1", "u1", { ...green, start: d.start });
		expect(out).toMatchObject({ started: true });
		expect(d.calls[0].objective).toContain("c-queued");
		expect(await pickupNextTicket(env, "i1", "u1", { ...green, start: d.start })).toEqual({ started: false, reason: "none" });
	});

	it("a card a PERSON moved to Needs you is not runnable, whatever its run status says", async () => {
		const { env } = setup();
		await setTicketQueueEnabled(env, "i1", "u1", true);
		const t = await ticket(env, "card-1", "needs_approval");
		await setTicketAuthority(env, "i1", "u1", t.id, "agent");
		d1.exec(`INSERT INTO board_items (instance_id, user_id, job_key, user_status, updated_at) VALUES ('i1', 'u1', 'card-1', 'needs_human', datetime('now'))`);
		const d = fakeStart();
		expect(await pickupNextTicket(env, "i1", "u1", { ...green, start: d.start })).toEqual({ started: false, reason: "none" });
		expect(d.calls).toEqual([]);
	});
});

describe("yield to a red deploy on the default branch (#757 §6)", () => {
	const run = (branch: string, status: string, conclusion: string | null): BuildRun => ({ branch, status, conclusion, name: "Deploy" });

	it("judges only the newest COMPLETED run on the default branch", () => {
		expect(redDefaultBranchBuild([run("main", "completed", "failure")], null)).toMatchObject({ conclusion: "failure" });
		expect(redDefaultBranchBuild([run("fix/x", "completed", "failure"), run("main", "completed", "success")], null)).toBeNull();
		expect(redDefaultBranchBuild([run("main", "in_progress", null), run("main", "completed", "failure")], null)).toMatchObject({ conclusion: "failure" });
		expect(redDefaultBranchBuild([run("main", "completed", "cancelled"), run("main", "completed", "success")], null)).toBeNull();
		expect(redDefaultBranchBuild([run("main", "completed", "failure")], "trunk")).toBeNull();
		expect(redDefaultBranchBuild([run("trunk", "completed", "timed_out")], "trunk")).toMatchObject({ conclusion: "timed_out" });
		expect(redDefaultBranchBuild([], null)).toBeNull();
	});

	it("a red deploy stops pickup before anything is claimed — the ticket waits for green", async () => {
		const { env } = setup();
		await setTicketQueueEnabled(env, "i1", "u1", true);
		const t = await ticket(env, "card-1");
		await setTicketAuthority(env, "i1", "u1", t.id, "agent");
		const d = fakeStart();
		const out = await pickupNextTicket(env, "i1", "u1", { redDeploy: async () => "main is red", start: d.start });
		expect(out).toMatchObject({ started: false, reason: "deploy_red", ticketId: t.id });
		expect(d.calls).toEqual([]);
		expect((await ticketQueueState(env, "i1", "u1", t.id))?.pickedAt).toBeNull();
	});
});

describe("one run at a time, and the session invariant through the existing driver (#757 §6)", () => {
	it("an instance with a run already going starts nothing", async () => {
		const { env } = setup();
		await setTicketQueueEnabled(env, "i1", "u1", true);
		const t = await ticket(env, "card-1");
		await setTicketAuthority(env, "i1", "u1", t.id, "agent");
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, max_iterations, started_at, status) VALUES ('live', 'u1', 'i1', 'x', 5, 1, 'running')`);
		const d = fakeStart();
		expect(await pickupNextTicket(env, "i1", "u1", { ...green, start: d.start })).toEqual({ started: false, reason: "busy" });
		expect(d.calls).toEqual([]);
	});

	it("RACE: overlapping sweeps on one instance start exactly one run", async () => {
		const { env } = setup();
		await setTicketQueueEnabled(env, "i1", "u1", true);
		for (const id of ["a", "b", "c"]) await setTicketAuthority(env, "i1", "u1", (await ticket(env, id)).id, "agent");
		const d = fakeStart();
		const results = await Promise.all(Array.from({ length: 6 }, () => pickupNextTicket(env, "i1", "u1", { ...green, start: d.start })));
		expect(results.filter((r) => r.started)).toHaveLength(1);
		expect(d.calls).toHaveLength(1);
	});

	it("RACE: while one sweep is mid-start (claimed, no run row yet), a second sweep cannot start ANOTHER ticket", async () => {
		// The window the per-instance lease exists for: the first sweep has claimed ticket `a` and is
		// inside the driver's start, whose run row does not exist yet, so the "is a run going" check
		// cannot see it. Without the lease the second sweep would claim `b` and start a second run.
		const { env } = setup();
		await setTicketQueueEnabled(env, "i1", "u1", true);
		for (const id of ["a", "b"]) await setTicketAuthority(env, "i1", "u1", (await ticket(env, id)).id, "agent");
		let letFirstFinish: () => void = () => undefined;
		const calls: LoopStartInput[] = [];
		const slowStart = async (input: LoopStartInput): Promise<LoopStartResult> => {
			calls.push(input);
			await new Promise<void>((r) => { letFirstFinish = r; });
			return { ok: true, runId: "run-a", driver: "chat" };
		};
		const first = pickupNextTicket(env, "i1", "u1", { ...green, start: slowStart });
		for (let i = 0; i < 200 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 1));
		expect(calls).toHaveLength(1);
		const second = await pickupNextTicket(env, "i1", "u1", { ...green, start: fakeStart().start });
		expect(second).toEqual({ started: false, reason: "leased" });
		letFirstFinish();
		expect(await first).toMatchObject({ started: true, runId: "run-a" });
		// …and the lease is released afterwards, so the next sweep is not locked out.
		expect(col("SELECT lease_holder FROM ticket_queues WHERE instance_id = 'i1'")?.lease_holder).toBeNull();
	});

	it("RACE: a ticket another sweep already claimed is not claimed again", async () => {
		const { env } = setup();
		await setTicketQueueEnabled(env, "i1", "u1", true);
		const t = await ticket(env, "card-1");
		await setTicketAuthority(env, "i1", "u1", t.id, "agent");
		d1.exec(`UPDATE tickets SET queue_picked_at = datetime('now') WHERE id = '${t.id}'`);
		const d = fakeStart();
		expect(await pickupNextTicket(env, "i1", "u1", { ...green, start: d.start })).toEqual({ started: false, reason: "none" });
		expect(d.calls).toEqual([]);
	});

	it("a busy session gives the ticket back — the coding driver's single-flight is respected, not bypassed", async () => {
		const { env } = setup();
		await setTicketQueueEnabled(env, "i1", "u1", true);
		const t = await ticket(env, "card-1");
		await setTicketAuthority(env, "i1", "u1", t.id, "agent");
		const busy = fakeStart(() => ({ ok: false, status: 409, reason: "busy", error: "platform is already being worked on" }));
		expect(await pickupNextTicket(env, "i1", "u1", { ...green, start: busy.start })).toMatchObject({ started: false, reason: "driver_busy" });
		expect(await ticketQueueState(env, "i1", "u1", t.id)).toMatchObject({ pickedAt: null, note: "platform is already being worked on" });
		expect(await pickupNextTicket(env, "i1", "u1", { ...green, start: fakeStart().start })).toMatchObject({ started: true, ticketId: t.id });
	});

	it("a structural refusal keeps the ticket taken with the driver's sentence, until a person re-queues it", async () => {
		const { env } = setup();
		await setTicketQueueEnabled(env, "i1", "u1", true);
		const t = await ticket(env, "card-1");
		await setTicketAuthority(env, "i1", "u1", t.id, "agent");
		const refuse = fakeStart(() => ({ ok: false, status: 409, error: "This agent has no repository yet." }));
		expect(await pickupNextTicket(env, "i1", "u1", { ...green, start: refuse.start })).toMatchObject({ reason: "refused" });
		expect(await pickupNextTicket(env, "i1", "u1", { ...green, start: refuse.start })).toEqual({ started: false, reason: "none" });
		expect(refuse.calls).toHaveLength(1);
		expect((await ticketQueueState(env, "i1", "u1", t.id))?.note).toBe("This agent has no repository yet.");
		await setTicketAuthority(env, "i1", "u1", t.id, "agent", true);
		expect(await pickupNextTicket(env, "i1", "u1", { ...green, start: fakeStart().start })).toMatchObject({ started: true });
	});
});

describe("every instance type goes through its own driver (#757 §2)", () => {
	it("a cloud-only instance (no runtime, no workflow) starts the platform's chat loop, with a run row", async () => {
		const { env, loops } = setup();
		await setTicketQueueEnabled(env, "i1", "u1", true);
		const t = await ticket(env, "card-1");
		await setTicketAuthority(env, "i1", "u1", t.id, "agent");
		const out = await pickupNextTicket(env, "i1", "u1", green);
		expect(out).toMatchObject({ started: true, driver: "chat" });
		const runId = (out as { runId: string }).runId;
		expect(loops[0]).toMatchObject({ runId, instanceId: "i1", userId: "u1" });
		expect(col(`SELECT status FROM agent_loop_runs WHERE run_id = '${runId}'`)?.status).toBe("running");
	});

	it("a coding instance is sent to the Pilot's driver — and with no repo it refuses structurally, never around the session APIs", async () => {
		const { env, loops } = setup();
		d1.exec(`INSERT INTO agents (id, owner_id, slug, name, category, config) VALUES ('agent-code', 'u2', 'code-x', 'Code', 'code', '{"capabilities":{"surfaces":["coding"],"runtime":"coding","workflow":"CODING_SESSION","tools":[]}}')`);
		d1.exec(`UPDATE agent_instances SET agent_id = 'agent-code' WHERE id = 'i2'`);
		await setTicketQueueEnabled(env, "i2", "u2", true);
		const t = await ticket(env, "card-1", "needs_approval", { instanceId: "i2", userId: "u2" });
		await setTicketAuthority(env, "i2", "u2", t.id, "agent");
		const out = await pickupNextTicket(env, "i2", "u2", green);
		expect(out).toMatchObject({ started: false, reason: "refused", ticketId: t.id });
		expect(loops).toEqual([]); // the chat loop was NOT used for a coder
		expect((await ticketQueueState(env, "i2", "u2", t.id))?.note).toMatch(/repo/i);
	});
});

describe("the run's end settles its ticket.run row (#864)", () => {
	it("finishLoopRun moves the ticket's attempt off `running`", async () => {
		const { env } = setup();
		await setTicketQueueEnabled(env, "i1", "u1", true);
		const t = await ticket(env, "card-1");
		await setTicketAuthority(env, "i1", "u1", t.id, "agent");
		const out = (await pickupNextTicket(env, "i1", "u1", green)) as { runId: string };
		await finishLoopRun(env, out.runId, "done", "shipped", Date.now());
		expect(col(`SELECT status FROM instance_runtime_tasks WHERE id = '${out.runId}'`)?.status).toBe("completed");
		const card = (await buildInstanceBoard(env, "i1", "u1")).items.find((i) => i.ticketId === t.id);
		expect(card?.attempts.find((a) => a.id === out.runId)?.status).toBe("completed");
	});
});

describe("authorization (#864)", () => {
	it("another owner cannot release a ticket, and their queue never reaches it", async () => {
		const { env } = setup();
		const t = await ticket(env, "card-1");
		expect(await setTicketAuthority(env, "i1", "u2", t.id, "agent")).toBe(false);
		expect(await setTicketAuthority(env, "i2", "u2", t.id, "agent")).toBe(false);
		expect((await ticketQueueState(env, "i1", "u1", t.id))?.authority).toBe("human");
		// u2 turning on a queue row for u1's instance changes nothing for u1.
		await setTicketQueueEnabled(env, "i1", "u2", true);
		expect(await ticketQueueEnabled(env, "i1", "u1")).toBe(false);
	});

	it("the sweep runs only enabled queues, only on active instances, only the owner's own released tickets", async () => {
		const { env } = setup();
		const mine = await ticket(env, "mine");
		await setTicketAuthority(env, "i1", "u1", mine.id, "agent");
		const theirs = await ticket(env, "theirs", "needs_approval", { instanceId: "i2", userId: "u2" });
		await setTicketAuthority(env, "i2", "u2", theirs.id, "agent");
		const d = fakeStart();
		expect(await runTicketQueue(env, { ...green, start: d.start })).toEqual([]); // nobody opted in
		await setTicketQueueEnabled(env, "i2", "u2", true);
		d1.exec(`UPDATE agent_instances SET status = 'cancelled' WHERE id = 'i2'`);
		expect(await runTicketQueue(env, { ...green, start: d.start })).toEqual([]); // not active
		d1.exec(`UPDATE agent_instances SET status = 'active' WHERE id = 'i2'`);
		const out = await runTicketQueue(env, { ...green, start: d.start });
		expect(out).toEqual([{ started: true, ticketId: theirs.id, runId: "run-1", driver: "chat" }]);
		expect(d.calls[0]).toMatchObject({ instanceId: "i2", userId: "u2" });
		expect((await ticketQueueState(env, "i1", "u1", mine.id))?.pickedAt).toBeNull();
	});
});
