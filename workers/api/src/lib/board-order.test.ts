/**
 * Board order is run order (#1097), on the REAL migrated schema: the order is a property of the drains'
 * SELECTs and of `board_items.position`, so it is tested against those statements — what the board shows,
 * what `listQueue` lists and what `dequeueNext` / `pickupNextTicket` actually claim.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types.js";
import { objectiveJobKey } from "./board-order.js";
import { buildInstanceBoard, setBoardItemStatus } from "./board.js";
import { parseBoardPlace, reorderBoardItem } from "./board-reorder.js";
import { realSchemaD1, type RealSchemaD1, seedTenant } from "./d1-sqlite.js";
import type { LoopStartInput, LoopStartResult } from "./loop-drivers.js";
import { dequeueNext, enqueueObjective, listQueue, requeueEntry } from "./objective-queue.js";
import { pickupNextTicket, setTicketAuthority, setTicketQueueEnabled } from "./ticket-queue.js";
import { createTicketCard } from "./tickets.js";

let d1: RealSchemaD1;
let env: Env;
let clock: number;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	env = { DB: d1.DB, AGENT_LOOP: { create: async () => ({ id: "wf" }) } } as unknown as Env;
	// Every entry gets its own millisecond, so "oldest first" is a fact rather than a uuid coin toss.
	clock = Date.parse("2026-10-16T00:00:00Z");
	vi.spyOn(Date, "now").mockImplementation(() => (clock += 1000));
});
afterEach(() => {
	vi.restoreAllMocks();
	d1.close();
});

const queue = async (objective: string, repoId: string | null = "r1") => (await enqueueObjective(env, { instanceId: "i1", repoId, userId: "u1", objective })).id;
const order = async (repoId?: string | null) => (await listQueue(env, "i1", repoId)).map((e) => e.objective);
const place = (entryId: string, p: Parameters<typeof reorderBoardItem>[4]) => reorderBoardItem(env, "i1", "u1", objectiveJobKey(entryId), p);
const waiting = async () => (await buildInstanceBoard(env, "i1", "u1")).items.filter((i) => i.status === "queued" || i.status === "needs_approval");

describe("the objective queue starts in board order (#1097)", () => {
	it("append stays the default: never-placed entries start oldest first", async () => {
		await queue("A");
		await queue("B");
		await queue("C");
		expect(await order()).toEqual(["A", "B", "C"]);
		expect((await dequeueNext(env, "i1", "r1"))?.objective).toBe("A");
	});

	it("an entry moved to the top starts next — ahead of earlier-queued ones — and the board and the queue say so", async () => {
		await queue("A");
		await queue("B");
		const c = await queue("C");
		await place(c, { to: "top" });
		expect(await order()).toEqual(["C", "A", "B"]);
		// Queued objectives ARE Waiting cards, in the same order, with the next one marked.
		const cards = (await waiting()).filter((i) => i.queueEntry);
		expect(cards.map((i) => i.title)).toEqual(["C", "A", "B"]);
		expect(cards.map((i) => i.runQueue)).toEqual([{ queue: "objective", next: true }, { queue: "objective", next: false }, { queue: "objective", next: false }]);
		expect((await dequeueNext(env, "i1", "r1"))?.objective).toBe("C");
	});

	it("before / after another entry places it there; the rest keep their order", async () => {
		const a = await queue("A");
		const b = await queue("B");
		const c = await queue("C");
		const d = await queue("D");
		await place(d, { before: objectiveJobKey(b) });
		expect(await order()).toEqual(["A", "D", "B", "C"]);
		await place(a, { after: objectiveJobKey(c) });
		expect(await order()).toEqual(["D", "B", "C", "A"]);
		// A new entry still appends behind everything.
		await queue("E");
		expect(await order()).toEqual(["D", "B", "C", "A", "E"]);
		await place(c, { to: "bottom" });
		expect((await order()).at(0)).toBe("D");
	});

	it("queue_position next puts a new entry at the front in one call", async () => {
		await queue("A");
		await enqueueObjective(env, { instanceId: "i1", repoId: "r1", userId: "u1", objective: "URGENT", position: "next" });
		expect(await order()).toEqual(["URGENT", "A"]);
	});

	it("a requeued entry keeps its place — losing a race never costs it the front", async () => {
		await queue("A");
		const c = await queue("C");
		await place(c, { to: "top" });
		const claimed = await dequeueNext(env, "i1", "r1");
		expect(claimed?.objective).toBe("C");
		expect((await requeueEntry(env, c, "the repo was busy again")).requeued).toBe(true);
		expect(await order()).toEqual(["C", "A"]);
	});

	it("repo-agnostic entries interleave by board order with each repo's own", async () => {
		await queue("r1-first", "r1");
		const any = await queue("any-repo", null);
		const r2 = await queue("r2-own", "r2");
		// r2's eligible set is its own entries plus the repo-agnostic ones, in board order.
		expect(await order("r2")).toEqual(["any-repo", "r2-own"]);
		await place(r2, { to: "top" });
		expect(await order("r2")).toEqual(["r2-own", "any-repo"]);
		expect((await dequeueNext(env, "i1", "r2"))?.objective).toBe("r2-own");
		expect((await dequeueNext(env, "i1", "r1"))?.objective).toBe("r1-first");
		expect((await dequeueNext(env, "i1", "r1"))?.id).toBe(any);
	});

	it("a reorder racing two drains starts each entry exactly once — nothing double-started, nothing dropped", async () => {
		await queue("A");
		await queue("B");
		const c = await queue("C");
		const [, first, second] = await Promise.all([place(c, { to: "top" }), dequeueNext(env, "i1", "r1"), dequeueNext(env, "i1", "r1")]);
		const started = [first?.objective, second?.objective];
		expect(new Set(started).size).toBe(2);
		const rows = d1.sqlite.prepare("SELECT status, COUNT(*) AS n FROM instance_objective_queue GROUP BY status").all() as Array<{ status: string; n: number }>;
		expect(Object.fromEntries(rows.map((r) => [r.status, r.n]))).toEqual({ running: 2, pending: 1 });
		// Once the reorder has committed, the next drain's SELECT sees it: C is never left behind B.
		const third = await dequeueNext(env, "i1", "r1");
		expect([...started, third?.objective].sort()).toEqual(["A", "B", "C"]);
	});

	it("a reorder committed before the drain's SELECT decides that start", async () => {
		await queue("A");
		const b = await queue("B");
		await place(b, { to: "top" });
		expect((await dequeueNext(env, "i1", "r1"))?.objective).toBe("B");
	});

	it("an entry that leaves the queue takes its board place with it", async () => {
		const a = await queue("A");
		await place(a, { to: "top" });
		const claimed = await dequeueNext(env, "i1", "r1");
		expect(claimed?.id).toBe(a);
		const { finishQueueEntry } = await import("./objective-queue.js");
		await finishQueueEntry(env, a, "started", null, "run-1");
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM board_items WHERE job_key = ?").get(objectiveJobKey(a))).toEqual({ n: 0 });
	});
});

describe("placing a card (#1097)", () => {
	it("takes exactly one of before, after or to", () => {
		expect(parseBoardPlace({ to: "top" })).toEqual({ to: "top" });
		expect(parseBoardPlace({ before: "objective:x" })).toEqual({ before: "objective:x" });
		expect(parseBoardPlace({})).toMatchObject({ error: expect.any(String) });
		expect(parseBoardPlace({ to: "top", after: "x" })).toMatchObject({ error: expect.any(String) });
		expect(parseBoardPlace({ to: "middle" })).toMatchObject({ error: expect.any(String) });
	});

	it("a card that is not on the board is a 404; a before-card in another column is a 409, and nothing moves", async () => {
		const a = await queue("A");
		await expect(reorderBoardItem(env, "i1", "u1", "objective:nope", { to: "top" })).rejects.toMatchObject({ status: 404 });
		// A card moved by hand into another column ("Needs you").
		await setBoardItemStatus(env, "i1", "u1", "job-elsewhere", "needs_human", { title: "Elsewhere" });
		await expect(place(a, { before: "job-elsewhere" })).rejects.toMatchObject({ status: 409 });
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM board_items WHERE position IS NOT NULL").get()).toEqual({ n: 0 });
	});

	it("moving a card to another column clears its place; staying in the column keeps it", async () => {
		await setBoardItemStatus(env, "i1", "u1", "job-x", "queued", { title: "X" });
		await setBoardItemStatus(env, "i1", "u1", "job-y", "queued", { title: "Y" });
		await reorderBoardItem(env, "i1", "u1", "job-y", { to: "top" });
		const position = () => (d1.sqlite.prepare("SELECT position FROM board_items WHERE job_key = 'job-y'").get() as { position: number | null }).position;
		expect(position()).not.toBeNull();
		await setBoardItemStatus(env, "i1", "u1", "job-y", "queued", { title: "Y" });
		expect(position()).not.toBeNull();
		await setBoardItemStatus(env, "i1", "u1", "job-y", "needs_human");
		expect(position()).toBeNull();
	});

	it("a Waiting card nothing will start says so", async () => {
		await setBoardItemStatus(env, "i1", "u1", "job-approval", "needs_approval", { title: "Waits on a person" });
		const card = (await waiting()).find((i) => i.jobKey === "job-approval");
		expect(card?.runQueue).toEqual({ queue: null, reason: "needs_approval" });
	});
});

describe("the ticket queue starts in board order (#1097)", () => {
	const start = () => {
		const calls: LoopStartInput[] = [];
		return {
			calls,
			start: async (input: LoopStartInput): Promise<LoopStartResult> => {
				calls.push(input);
				return { ok: true, runId: `run-${calls.length}`, driver: "chat" };
			},
		};
	};
	const ticket = (id: string) => createTicketCard(env, "i1", "u1", { id, type: "ticket", title: `Ticket ${id}`, description: `Do ${id}`, status: "needs_approval", updatedAt: "2026-10-16T00:00:00Z" }, "human");

	it("oldest released ticket first by default; a card placed on top starts first; a held ticket says it never will", async () => {
		await setTicketQueueEnabled(env, "i1", "u1", true);
		const a = await ticket("a");
		d1.exec(`UPDATE tickets SET created_at = '2026-01-01 00:00:00' WHERE id = '${a.id}'`);
		const b = await ticket("b");
		const held = await ticket("held");
		for (const t of [a, b]) await setTicketAuthority(env, "i1", "u1", t.id, "agent");

		const before = await waiting();
		expect(before.find((i) => i.ticketId === a.id)?.runQueue).toEqual({ queue: "ticket", next: true });
		expect(before.find((i) => i.ticketId === held.id)?.runQueue).toEqual({ queue: null, reason: "human_authority" });

		await reorderBoardItem(env, "i1", "u1", b.jobKey, { to: "top" });
		expect((await waiting()).find((i) => i.ticketId === b.id)?.runQueue).toEqual({ queue: "ticket", next: true });
		expect(await pickupNextTicket(env, "i1", "u1", { redDeploy: async () => null, start: start().start })).toMatchObject({ started: true, ticketId: b.id });
	});
});
