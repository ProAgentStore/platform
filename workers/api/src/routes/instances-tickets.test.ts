/**
 * Promote a board card to a first-class ticket, and read one (#757) — authorization, idempotency and
 * the one creation path, driven through the real routes on the real migrated schema.
 */
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1, seedTenant } from "../lib/d1-sqlite.js";
import { signSession } from "../lib/session.js";
import { mirrorRuntimeTask } from "./instances-runtime.js";
import { registerTaskRoutes } from "./instances-tasks.js";
import { ticketRoutes } from "./instances-tickets.js";
import type { Env } from "../types.js";

const SECRET = "tickets-secret";
let d1: RealSchemaD1;
afterEach(() => d1?.close());

function setup() {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["i2"] });
	const env = { SESSION_SIGNING_KEY: SECRET, DB: d1.DB } as unknown as Env;
	const app = new Hono<{ Bindings: Env }>();
	const tasks = new Hono<{ Bindings: Env }>();
	registerTaskRoutes(tasks);
	app.route("/v1/instances", tasks);
	app.route("/v1/instances", ticketRoutes);
	app.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message }, err.status as 400) : c.json({ error: String(err) }, 500)));
	const call = async (method: string, path: string, uid: string, body?: unknown) => {
		const res = await app.request(
			path,
			{ method, headers: { Authorization: `Bearer ${await signSession(uid, SECRET, { roles: [] })}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) },
			env,
		);
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	};
	return { env, call };
}

const promote = (jobKey: string) => `/v1/instances/i1/board/items/${encodeURIComponent(jobKey)}/ticket`;

describe("POST /board/items/:jobKey/ticket — promote a card (#757)", () => {
	it("promotes a card that exists only as runs: 201 the first time with its runs stored, 200 and the SAME ticket after", async () => {
		const { env, call } = setup();
		await mirrorRuntimeTask(env, "i1", "u1", { id: "run-1", type: "job.apply_agent", status: "failed", input: { url: "https://jobs.example/role/42" }, updatedAt: "2026-09-26T00:00:00Z" });
		await mirrorRuntimeTask(env, "i1", "u1", { id: "run-2", type: "job.apply_agent", status: "running", input: { url: "https://jobs.example/role/42" }, updatedAt: "2026-09-26T01:00:00Z" });
		const board = await call("GET", "/v1/instances/i1/board", "u1");
		const card = (board.body.items as Array<{ jobKey: string; ticketId?: string }>)[0];
		expect(card.ticketId).toBeUndefined();

		const first = await call("POST", promote(card.jobKey), "u1");
		expect(first.status).toBe(201);
		expect(first.body.created).toBe(true);
		const ticketId = (first.body.ticket as { id: string }).id;
		const again = await call("POST", promote(card.jobKey), "u1");
		expect(again.status).toBe(200);
		expect((again.body.ticket as { id: string }).id).toBe(ticketId);
		expect((d1.sqlite.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n).toBe(1);

		// Its runs are stored now — not merely grouped — and the board says it is a ticket.
		const stored = await call("GET", `/v1/instances/i1/tickets/${ticketId}`, "u1");
		expect((stored.body.attempts as Array<{ id: string }>).map((a) => a.id)).toEqual(["run-2", "run-1"]);
		const after = await call("GET", "/v1/instances/i1/board", "u1");
		expect((after.body.items as Array<{ jobKey: string; ticketId?: string }>).find((i) => i.jobKey === card.jobKey)?.ticketId).toBe(ticketId);
	});

	it("another owner cannot promote on this instance — 404, nothing written", async () => {
		const { env, call } = setup();
		await mirrorRuntimeTask(env, "i1", "u1", { id: "run-1", type: "task", status: "done" });
		const res = await call("POST", promote("run-1"), "u2");
		expect(res.status).toBe(404);
		expect((d1.sqlite.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n).toBe(0);
	});

	it("a key that is not on THIS board is refused — another tenant's card key included", async () => {
		const { env, call } = setup();
		await mirrorRuntimeTask(env, "i2", "u2", { id: "their-run", type: "task", status: "done" });
		expect((await call("POST", promote("their-run"), "u1")).status).toBe(404);
		expect((await call("POST", promote("nope"), "u1")).status).toBe(404);
		expect((d1.sqlite.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n).toBe(0);
	});
});

describe("GET /tickets/:ticketId (#757)", () => {
	it("is the owner's alone: another owner gets 404 on either instance", async () => {
		const { env, call } = setup();
		await mirrorRuntimeTask(env, "i1", "u1", { id: "run-1", type: "task", status: "done" });
		const ticketId = ((await call("POST", promote("run-1"), "u1")).body.ticket as { id: string }).id;
		expect((await call("GET", `/v1/instances/i1/tickets/${ticketId}`, "u2")).status).toBe(404);
		expect((await call("GET", `/v1/instances/i2/tickets/${ticketId}`, "u2")).status).toBe(404);
		expect((await call("GET", `/v1/instances/i1/tickets/${ticketId}`, "u1")).status).toBe(200);
	});
});

describe("POST /tasks/direct — a human's ticket is first-class from creation (#757)", () => {
	it("creates the card AND the ticket, returning its ticketId; the card's lifecycle is unchanged", async () => {
		const { call } = setup();
		const res = await call("POST", "/v1/instances/i1/tasks/direct", "u1", { title: "Review the contract", reasoning: "Owner asked", action: "add_knowledge", config: {}, params: { title: "x", content: "y" } });
		expect(res.status).toBe(201);
		expect(res.body.status).toBe("needs_approval");
		expect(typeof res.body.ticketId).toBe("string");
		const board = await call("GET", "/v1/instances/i1/board", "u1");
		const card = (board.body.items as Array<{ jobKey: string; ticketId?: string; status: string }>).find((i) => i.jobKey === res.body.id);
		expect(card).toMatchObject({ ticketId: res.body.ticketId, status: "needs_approval" });
	});

	it("cannot be used to overwrite another tenant's card by passing its id — refused with 409, nothing recorded", async () => {
		const { env, call } = setup();
		await mirrorRuntimeTask(env, "i2", "u2", { id: "victim", type: "ticket", status: "needs_approval", title: "theirs" });
		const res = await call("POST", "/v1/instances/i1/tasks/direct", "u1", { id: "victim", title: "hijack", status: "completed" });
		expect(res.status).toBe(409);
		expect((d1.sqlite.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n).toBe(0);
		const row = d1.sqlite.prepare("SELECT instance_id, status, payload FROM instance_runtime_tasks WHERE id = 'victim'").get() as Record<string, string>;
		expect(row).toMatchObject({ instance_id: "i2", status: "needs_approval" });
		expect(JSON.parse(row.payload).title).toBe("theirs");
	});
});

describe("the opt-in ticket queue's owner controls (#864)", () => {
	it("the queue is OFF until the owner turns it on, and another owner can neither read nor flip it", async () => {
		const { call } = setup();
		expect((await call("GET", "/v1/instances/i1/ticket-queue", "u1")).body).toEqual({ enabled: false });
		expect((await call("PUT", "/v1/instances/i1/ticket-queue", "u2", { enabled: true })).status).toBe(404);
		expect((await call("GET", "/v1/instances/i1/ticket-queue", "u2")).status).toBe(404);
		expect((await call("PUT", "/v1/instances/i1/ticket-queue", "u1", { enabled: "yes" })).status).toBe(400);
		expect((await call("PUT", "/v1/instances/i1/ticket-queue", "u1", { enabled: true })).body).toEqual({ enabled: true });
		expect((await call("GET", "/v1/instances/i1/ticket-queue", "u1")).body).toEqual({ enabled: true });
		expect((d1.sqlite.prepare("SELECT COUNT(*) AS n FROM ticket_queues").get() as { n: number }).n).toBe(1);
	});

	it("only the owner releases a ticket to the queue; the ticket read reports it", async () => {
		const { env, call } = setup();
		await mirrorRuntimeTask(env, "i1", "u1", { id: "run-1", type: "task", status: "queued" });
		const ticketId = ((await call("POST", promote("run-1"), "u1")).body.ticket as { id: string }).id;
		expect(((await call("GET", `/v1/instances/i1/tickets/${ticketId}`, "u1")).body.queue as { authority: string }).authority).toBe("human");

		expect((await call("PUT", `/v1/instances/i1/tickets/${ticketId}/authority`, "u2", { authority: "agent" })).status).toBe(404);
		expect((await call("PUT", `/v1/instances/i2/tickets/${ticketId}/authority`, "u2", { authority: "agent" })).status).toBe(404);
		expect((await call("PUT", `/v1/instances/i1/tickets/${ticketId}/authority`, "u1", { authority: "robot" })).status).toBe(400);
		expect((await call("PUT", `/v1/instances/i1/tickets/nope/authority`, "u1", { authority: "agent" })).status).toBe(404);

		const ok = await call("PUT", `/v1/instances/i1/tickets/${ticketId}/authority`, "u1", { authority: "agent" });
		expect(ok.status).toBe(200);
		expect(ok.body.queue).toMatchObject({ authority: "agent", pickedAt: null });
	});
});

describe("the ticket's own budget over HTTP (#865)", () => {
	it("only the owner sets or raises it; bad figures are 400; the ticket read reports budget and progress", async () => {
		const { env, call } = setup();
		await mirrorRuntimeTask(env, "i1", "u1", { id: "run-1", type: "task", status: "queued" });
		const ticketId = ((await call("POST", promote("run-1"), "u1")).body.ticket as { id: string }).id;
		expect((await call("PUT", `/v1/instances/i1/tickets/${ticketId}/budget`, "u2", { limitMicros: 5_000_000 })).status).toBe(404);
		expect((await call("PUT", `/v1/instances/i2/tickets/${ticketId}/budget`, "u2", { limitMicros: 5_000_000 })).status).toBe(404);
		expect((await call("PUT", `/v1/instances/i1/tickets/${ticketId}/budget`, "u1", { limitMicros: "lots" })).status).toBe(400);
		const ok = await call("PUT", `/v1/instances/i1/tickets/${ticketId}/budget`, "u1", { limitMicros: 5_000_000, requeue: true });
		expect(ok.status).toBe(200);
		expect(ok.body.budget).toMatchObject({ allowanceMicros: 5_000_000, status: "unopened" });
		const read = await call("GET", `/v1/instances/i1/tickets/${ticketId}`, "u1");
		expect(read.body.budget).toMatchObject({ allowanceMicros: 5_000_000 });
		expect(read.body.progress).toEqual([]);
	});
});
