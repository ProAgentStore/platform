/**
 * #1698, the owner-approved design, on the real schema: unstarted work shows in Queued in the auto-pickup's OWN order; once work starts
 * there is one card per run; a resumed run keeps its card and a fresh attempt gets a new one; the four lanes; and an owner action
 * carries its #1697 triage without ever becoming a second action.
 *
 * NOT COVERED: the old `buildInstanceBoard` and its consumers (still the Board and List views), MCP and iOS.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBoardProjection, type ProjectedCard } from "./board-projection.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { writeTriage } from "./inbox-triage.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
let env: Env;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const T = 1_800_000_000_000;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["coder", "coder-2"] });
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

const read = (instance = "coder", user = "u1") => readBoardProjection(env, instance, user, T);
const byId = (cards: ProjectedCard[], id: string) => cards.find((c) => c.cardId === id);

const session = (id: string) => {
	d1.exec(`INSERT OR IGNORE INTO coding_repos (id, instance_id, user_id, name) VALUES (${q(`r-${id}`)}, 'coder', 'u1', ${q(id)})`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status) VALUES (${q(id)}, 'coder', ${q(`r-${id}`)}, 'u1', 'active')`);
};
const run = (id: string, sessionId: string, status: string, over: { wait?: string; ticket?: string } = {}) =>
	d1.exec(
		`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id, waiting_reason, ticket_id)
		 VALUES (${q(id)}, 'u1', 'coder', ${q(`objective of ${id}`)}, ${q(status)}, 10, ${T}, ${q(sessionId)}, ${over.wait ? q(over.wait) : "NULL"}, ${over.ticket ? q(over.ticket) : "NULL"})`,
	);
const question = (id: string, runId: string, sessionId: string, state: string, over: { answered?: boolean; applied?: boolean; at?: number } = {}) =>
	d1.exec(
		`INSERT INTO coder_questions (id, instance_id, user_id, session_id, run_id, question, state, asked_at, expires_at, answered_at, applied_at)
		 VALUES (${q(id)}, 'coder', 'u1', ${q(sessionId)}, ${q(runId)}, ${q(`question ${id}?`)}, ${q(state)}, ${over.at ?? T}, ${T + 86_400_000}, ${over.answered ? T + 1 : "NULL"}, ${over.applied ? T + 2 : "NULL"})`,
	);
const ticket = (id: string, over: { job?: string; pickup?: "human" | "agent"; created?: string; budget?: string; instance?: string; user?: string; picked?: boolean } = {}) =>
	d1.exec(
		`INSERT INTO tickets (id, instance_id, user_id, job_key, title, created_by, pickup_authority, created_at, budget_id, queue_picked_at)
		 VALUES (${q(id)}, ${q(over.instance ?? "coder")}, ${q(over.user ?? "u1")}, ${q(over.job ?? `issue:r1#${id}`)}, ${q(`Ticket ${id}`)}, 'human', ${q(over.pickup ?? "agent")}, ${q(over.created ?? "2026-11-01 00:00:00")}, ${over.budget ? q(over.budget) : "NULL"}, ${over.picked ? "'2026-11-02 00:00:00'" : "NULL"})`,
	);
const place = (jobKey: string, position: number) => d1.exec(`INSERT INTO board_items (instance_id, user_id, job_key, position) VALUES ('coder', 'u1', ${q(jobKey)}, ${position})`);
const task = (id: string, type: string, status: string, over: { hidden?: number; instance?: string; user?: string; at?: string } = {}) =>
	d1.exec(
		`INSERT INTO instance_runtime_tasks (id, instance_id, user_id, type, status, payload, created_at, updated_at, hidden)
		 VALUES (${q(id)}, ${q(over.instance ?? "coder")}, ${q(over.user ?? "u1")}, ${q(type)}, ${q(status)}, ${q(JSON.stringify({ id, type, status, title: `Task ${id}` }))}, '2026-11-01T00:00:00Z', ${q(over.at ?? "2026-11-01T00:00:00Z")}, ${over.hidden ?? 0})`,
	);

describe("unstarted work is Queued, in the auto-pickup's own order", () => {
	it("an unstarted ticket is a Queued card, with its old board key kept as read-only metadata", async () => {
		ticket("t1", { job: "issue:r1#12" });
		const c = byId(await read(), "ticket:t1");
		expect(c).toMatchObject({ kind: "queued-ticket", lane: "queued", needsYou: false, legacyJobKey: "issue:r1#12", native: { ticketId: "t1", pickup: "agent" } });
		expect(c?.title).toBe("Ticket t1");
	});

	it("the rank is exactly the order the auto-pickup takes them in (the picker's own SQL, run against the same rows)", async () => {
		ticket("a", { created: "2026-11-03 00:00:00" });
		ticket("b", { created: "2026-11-01 00:00:00" });
		ticket("c", { created: "2026-11-02 00:00:00" });
		ticket("d", { created: "2026-11-05 00:00:00" });
		place("issue:r1#d", 1); // the owner placed d at the top: it starts first
		const ranked = (await read()).filter((x) => x.kind === "queued-ticket").sort((x, y) => (x.queueRank ?? 99) - (y.queueRank ?? 99));
		const picker = d1.sqlite
			.prepare(
				`SELECT t.id FROM tickets t LEFT JOIN delegation_budgets b ON b.id = t.budget_id AND b.user_id = t.user_id
				   LEFT JOIN board_items bi ON bi.instance_id = t.instance_id AND bi.user_id = t.user_id AND bi.job_key = t.job_key
				  WHERE t.instance_id = 'coder' AND t.user_id = 'u1' AND t.pickup_authority = 'agent' AND t.queue_picked_at IS NULL AND (b.id IS NULL OR b.status = 'open')
				  ORDER BY (bi.position IS NULL), bi.position, t.created_at, t.id LIMIT 50`,
			)
			.all() as Array<{ id: string }>;
		expect(ranked.map((c) => c.native.ticketId)).toEqual(picker.map((r) => r.id));
		expect(ranked.map((c) => c.queueRank)).toEqual([0, 1, 2, 3]);
		expect(ranked[0].native.ticketId).toBe("d");
	});

	it("a ticket waiting for the owner to release it is Queued with no rank; a used-up budget parks it as Blocked on the owner and it does not hold the line", async () => {
		ticket("human", { pickup: "human" });
		d1.exec(`INSERT INTO delegation_budgets (id, user_id, root_instance_id, cost_micros_limit, delegations_limit, max_depth, status) VALUES ('b1', 'u1', 'coder', 1, 1, 1, 'exhausted')`);
		ticket("broke", { budget: "b1" });
		ticket("ok");
		const cards = await read();
		expect(byId(cards, "ticket:human")).toMatchObject({ lane: "queued", native: { pickup: "human" } });
		expect(byId(cards, "ticket:human")?.queueRank).toBeUndefined();
		expect(byId(cards, "ticket:broke")).toMatchObject({ lane: "blocked", needsYou: true, blocker: { nextOwner: "owner" } });
		expect(byId(cards, "ticket:broke")?.queueRank).toBeUndefined();
		expect(byId(cards, "ticket:ok")?.queueRank).toBe(0);
	});

	it("a started ticket is not shown as unstarted (its run's card owns it), and neither is a picked one or one with attached runs", async () => {
		ticket("started");
		session("s1");
		run("r-t", "s1", "running", { ticket: "started" });
		ticket("picked", { picked: true });
		ticket("withtask");
		d1.exec(`INSERT INTO ticket_runs (ticket_id, task_id, instance_id, user_id) VALUES ('withtask', 'task-x', 'coder', 'u1')`);
		const ids = (await read()).map((c) => c.cardId);
		expect(ids).toContain("csess-s1");
		for (const gone of ["ticket:started", "ticket:picked", "ticket:withtask"]) expect(ids).not.toContain(gone);
	});

	it("another owner's tickets, and another instance's, never appear", async () => {
		seedTenant(d1, { userId: "u2", instanceIds: ["theirs"] });
		ticket("theirs-t", { instance: "theirs", user: "u2" });
		ticket("sibling-t", { instance: "coder-2" });
		ticket("mine");
		expect((await read()).filter((c) => c.kind === "queued-ticket").map((c) => c.cardId)).toEqual(["ticket:mine"]);
	});
});

describe("one card per run for generic runtime tasks", () => {
	it("a retry at the same URL is a new task and so a new card, each classified by its own status", async () => {
		task("t1", "job.apply_agent", "failed", { at: "2026-11-01T00:00:00Z" });
		task("t2", "job.apply_agent", "running", { at: "2026-11-02T00:00:00Z" });
		task("t3", "browser.task", "needs_human");
		task("t4", "browser.task", "queued");
		task("t5", "browser.task", "completed");
		task("t6", "job.apply_agent", "needs_approval");
		const cards = (await read()).filter((c) => c.kind === "task");
		expect(cards.map((c) => c.cardId).sort()).toEqual(["task:t1", "task:t2", "task:t3", "task:t4", "task:t5", "task:t6"]);
		// Held until the owner approves it: an owner action (Needs you), not a wait for a turn.
		expect(byId(cards, "task:t6")).toMatchObject({ lane: "blocked", needsYou: true, blocker: { nextOwner: "owner" }, native: { status: "needs_approval" } });
		expect(byId(cards, "task:t1")).toMatchObject({ lane: "done", outcome: "failed" });
		expect(byId(cards, "task:t2")).toMatchObject({ lane: "in_progress" });
		expect(byId(cards, "task:t3")).toMatchObject({ lane: "blocked", needsYou: true });
		expect(byId(cards, "task:t4")).toMatchObject({ lane: "queued" });
		expect(byId(cards, "task:t5")).toMatchObject({ lane: "done", outcome: "succeeded" });
		expect(byId(cards, "task:t1")?.native).toMatchObject({ taskId: "t1", taskType: "job.apply_agent" });
	});

	it("tasks that are already a session, scan or application card are not shown twice, and hidden tasks are not shown", async () => {
		task("csess-s1", "coding.session", "running");
		task("scan-r1", "local_browser.scan", "running");
		task("app-a1", "application.run", "running");
		task("gone", "browser.task", "running", { hidden: 1 });
		task("real", "browser.task", "running");
		expect((await read()).map((c) => c.cardId)).toEqual(["task:real"]);
	});

	it("another owner's tasks never appear", async () => {
		seedTenant(d1, { userId: "u2", instanceIds: ["theirs"] });
		task("theirs-t", "browser.task", "running", { instance: "theirs", user: "u2" });
		task("mine-t", "browser.task", "running");
		expect((await read()).map((c) => c.cardId)).toEqual(["task:mine-t"]);
	});
});

describe("owner actions carry their #1697 triage and never become a second action", () => {
	it("an open question's card points at its inbox item, New by default", async () => {
		session("s1");
		run("run-1", "s1", "running", { wait: "decision" });
		question("q1", "run-1", "s1", "waiting_human");
		expect((await read())[0].ownerAction).toMatchObject({ itemId: "coder_question:q1", triage: { status: "new", needsComputer: false } });
	});

	it("deferring or discussing the question changes its triage, not the card: still one card, still Blocked on the owner", async () => {
		session("s1");
		run("run-1", "s1", "running", { wait: "decision" });
		question("q1", "run-1", "s1", "waiting_human");
		await writeTriage(env, "u1", "coder_question:q1", { status: "deferred", needsComputer: true, deferUntil: T + 86_400_000 }, T);
		let cards = await read();
		expect(cards).toHaveLength(1);
		expect(cards[0]).toMatchObject({ cardId: "csess-s1", lane: "blocked", needsYou: true, ownerAction: { itemId: "coder_question:q1", triage: { status: "deferred", needsComputer: true } } });
		await writeTriage(env, "u1", "coder_question:q1", { status: "discussed" }, T);
		cards = await read();
		expect(cards).toHaveLength(1);
		expect(cards[0].ownerAction?.triage.status).toBe("discussed");
	});

	it("two successive questions in one session: the second starts New, and triaging the first never revives it as another action", async () => {
		session("s1");
		run("run-1", "s1", "running", { wait: "decision" });
		question("q1", "run-1", "s1", "answered_human", { answered: true, applied: true, at: T });
		question("q2", "run-1", "s1", "waiting_human", { at: T + 5 });
		await writeTriage(env, "u1", "coder_question:q1", { status: "deferred" }, T);
		const cards = await read();
		expect(cards).toHaveLength(1);
		expect(cards[0].ownerAction).toMatchObject({ itemId: "coder_question:q2", triage: { status: "new" } });
		expect(cards[0].blocker?.what).toContain("q2");
	});

	it("a run parked on the owner points at its parked-run item", async () => {
		session("s1");
		run("run-1", "s1", "running", { wait: "human" });
		expect((await read())[0].ownerAction?.itemId).toBe("run_parked:run-1");
	});

	it("a recorded, unapplied answer has no owner action at all: it is waiting on the run", async () => {
		session("s1");
		run("run-1", "s1", "running", { wait: "decision" });
		question("q1", "run-1", "s1", "answered_human", { answered: true });
		const [c] = await read();
		expect(c).toMatchObject({ lane: "queued", waitingToResume: true, needsYou: false });
		expect(c.ownerAction).toBeUndefined();
	});

	it("another owner's triage never decorates my card", async () => {
		seedTenant(d1, { userId: "u2", instanceIds: ["theirs"] });
		session("s1");
		run("run-1", "s1", "running", { wait: "human" });
		await writeTriage(env, "u2", "run_parked:run-1", { status: "deferred" }, T);
		expect((await read())[0].ownerAction?.triage.status).toBe("new");
	});
});
