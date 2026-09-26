/**
 * First-class tickets (#757). The overlay is tested pure; everything that touches the database runs on
 * the REAL migrated schema (`d1-sqlite.ts`), because the properties that matter — idempotent promotion,
 * tenant isolation, the stored relation surviving a clear — are properties of the SQL, not of a stub.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildInstanceBoard } from "./board.js";
import { realSchemaD1, type RealSchemaD1, seedTenant } from "./d1-sqlite.js";
import { attachTicketRuns, createTicketCard, getTicket, overlayTickets, recordTicket, type Ticket, ticketsForInstance } from "./tickets.js";
import { mirrorRuntimeTask } from "../routes/instances-runtime.js";
import type { Env } from "../types.js";

const T = (over: Partial<Ticket> = {}): Ticket => ({ id: "tkt_1", instanceId: "i1", jobKey: "job-a", title: "A", description: "", createdBy: "human", createdAt: "2026-09-26T00:00:00Z", ...over });
const run = (id: string, status: string, updatedAt: string, ticketId?: string) => ({ id, status, updatedAt, ...(ticketId ? { ticketId } : {}) });

describe("overlayTickets — stored runs join their card, pure (#757)", () => {
	it("a card with a ticket gets its id, and a run not yet stored is stored", () => {
		const out = overlayTickets([{ jobKey: "job-a", attempts: [run("t1", "running", "2026-09-26T01:00:00Z")] }], { tickets: [T()], runs: [] });
		expect(out.byJobKey.get("job-a")).toEqual({ ticketId: "tkt_1", attempts: [{ id: "t1", status: "running", updatedAt: "2026-09-26T01:00:00Z" }] });
		expect(out.attach).toEqual([{ ticketId: "tkt_1", taskId: "t1", status: "running", updatedAt: "2026-09-26T01:00:00Z" }]);
	});

	it("nothing changed since the last read → nothing to write (a 2.5s poll does not write)", () => {
		const stored = { tickets: [T()], runs: [{ ticketId: "tkt_1", taskId: "t1", status: "done", updatedAt: "2026-09-26T01:00:00Z" }] };
		expect(overlayTickets([{ jobKey: "job-a", attempts: [run("t1", "done", "2026-09-26T01:00:00Z")] }], stored).attach).toEqual([]);
	});

	it("a run whose state moved is refreshed", () => {
		const stored = { tickets: [T()], runs: [{ ticketId: "tkt_1", taskId: "t1", status: "running", updatedAt: "2026-09-26T01:00:00Z" }] };
		expect(overlayTickets([{ jobKey: "job-a", attempts: [run("t1", "done", "2026-09-26T02:00:00Z")] }], stored).attach).toEqual([{ ticketId: "tkt_1", taskId: "t1", status: "done", updatedAt: "2026-09-26T02:00:00Z" }]);
	});

	it("a stored run whose row is gone keeps its attempt — the list no longer shrinks on a clear", () => {
		const stored = { tickets: [T()], runs: [{ ticketId: "tkt_1", taskId: "t-old", status: "failed", updatedAt: "2026-09-25T00:00:00Z" }] };
		const out = overlayTickets([{ jobKey: "job-a", attempts: [run("t-new", "running", "2026-09-26T00:00:00Z")] }], stored);
		expect(out.byJobKey.get("job-a")?.attempts.map((a) => a.id)).toEqual(["t-new", "t-old"]);
	});

	it("a run that names its ticket joins it from another card; a ticket id from nowhere is ignored", () => {
		const out = overlayTickets(
			[{ jobKey: "other", attempts: [run("t9", "running", "2026-09-26T00:00:00Z", "tkt_1"), run("t10", "running", "2026-09-26T00:00:00Z", "tkt_FOREIGN")] }],
			{ tickets: [T()], runs: [] },
		);
		expect(out.attach.map((a) => [a.ticketId, a.taskId])).toEqual([["tkt_1", "t9"]]);
	});

	it("a ticket with no card left on the board stands alone with its stored attempts", () => {
		const stored = { tickets: [T({ jobKey: "gone" })], runs: [{ ticketId: "tkt_1", taskId: "t1", status: "completed", updatedAt: "2026-09-25T00:00:00Z" }] };
		const out = overlayTickets([], stored);
		expect(out.standalone).toEqual([{ ticket: T({ jobKey: "gone" }), attempts: [{ id: "t1", status: "completed", updatedAt: "2026-09-25T00:00:00Z" }] }]);
	});
});

describe("tickets on the real schema (#757)", () => {
	let d1: RealSchemaD1;
	const env = () => ({ DB: d1.DB }) as unknown as Env;
	const fresh = () => {
		d1 = realSchemaD1();
		seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
		seedTenant(d1, { userId: "u2", instanceIds: ["i2"] });
	};
	afterEach(() => d1?.close());

	it("promotion is idempotent: the same card gives the same ticket, and only one row exists", async () => {
		fresh();
		const a = await recordTicket(env(), "i1", "u1", { jobKey: "job-a", title: "A", createdBy: "human" });
		const b = await recordTicket(env(), "i1", "u1", { jobKey: "job-a", title: "A again", createdBy: "agent" });
		expect(a.created).toBe(true);
		expect(b.created).toBe(false);
		expect(b.ticket.id).toBe(a.ticket.id);
		expect(b.ticket.title).toBe("A");
		expect((d1.sqlite.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n).toBe(1);
	});

	it("another owner cannot read a ticket, even by its id", async () => {
		fresh();
		const { ticket } = await recordTicket(env(), "i1", "u1", { jobKey: "job-a", title: "A", createdBy: "human" });
		expect(await getTicket(env(), "i1", "u2", ticket.id)).toBeNull();
		expect(await getTicket(env(), "i2", "u2", ticket.id)).toBeNull();
		expect((await ticketsForInstance(env(), "i1", "u2")).tickets).toEqual([]);
	});

	it("a run cannot be attached to another tenant's ticket", async () => {
		fresh();
		const { ticket } = await recordTicket(env(), "i1", "u1", { jobKey: "job-a", title: "A", createdBy: "human" });
		await attachTicketRuns(env(), "i2", "u2", [{ ticketId: ticket.id, taskId: "evil", status: "x", updatedAt: "" }]);
		expect((d1.sqlite.prepare("SELECT COUNT(*) AS n FROM ticket_runs").get() as { n: number }).n).toBe(0);
	});

	it("mirrorRuntimeTask cannot overwrite another tenant's row by reusing its id", async () => {
		fresh();
		await mirrorRuntimeTask(env(), "i1", "u1", { id: "shared-id", type: "ticket", status: "needs_approval", title: "mine" });
		await mirrorRuntimeTask(env(), "i2", "u2", { id: "shared-id", type: "ticket", status: "completed", title: "hijacked" });
		const row = d1.sqlite.prepare("SELECT instance_id, user_id, status, payload FROM instance_runtime_tasks WHERE id = 'shared-id'").get() as Record<string, string>;
		expect(row).toMatchObject({ instance_id: "i1", user_id: "u1", status: "needs_approval" });
		expect(JSON.parse(row.payload).title).toBe("mine");
	});

	it("createTicketCard: the card, the ticket, and the card as its first stored run — one path", async () => {
		fresh();
		const ticket = await createTicketCard(env(), "i1", "u1", { id: "card-1", type: "ticket", title: "Ship it", status: "needs_approval", updatedAt: "2026-09-26T00:00:00Z" }, "agent");
		expect(ticket).toMatchObject({ jobKey: "card-1", title: "Ship it", createdBy: "agent" });
		const runs = (await ticketsForInstance(env(), "i1", "u1")).runs;
		expect(runs).toEqual([{ ticketId: ticket.id, taskId: "card-1", status: "needs_approval", updatedAt: "2026-09-26T00:00:00Z" }]);
	});

	it("the board: a ticket's card carries ticketId, a run naming the ticket joins it, and the ticket survives its runs being cleared", async () => {
		fresh();
		const ticket = await createTicketCard(env(), "i1", "u1", { id: "card-1", type: "ticket", title: "Ship it", status: "needs_approval", updatedAt: "2026-09-26T00:00:00Z" }, "human");
		await mirrorRuntimeTask(env(), "i1", "u1", { id: "run-1", type: "browser.task", status: "running", ticketId: ticket.id, updatedAt: "2026-09-26T01:00:00Z" });

		const first = await buildInstanceBoard(env(), "i1", "u1");
		const card = first.items.find((i) => i.jobKey === "card-1")!;
		expect(card.ticketId).toBe(ticket.id);
		// The shape is unchanged: attempts are still {id, status, updatedAt}.
		expect(card.attempts.map((a) => a.id).sort()).toEqual(["card-1", "run-1"]);
		expect(Object.keys(card.attempts[0]).sort()).toEqual(["id", "status", "updatedAt"]);

		// A second read with nothing new writes nothing.
		const before = d1.issued.filter((s) => s.sql.includes("INSERT INTO ticket_runs")).length;
		await buildInstanceBoard(env(), "i1", "u1");
		expect(d1.issued.filter((s) => s.sql.includes("INSERT INTO ticket_runs")).length).toBe(before);

		// Every runtime row cleared: the ticket is still on the board, with its stored attempts.
		d1.exec("DELETE FROM instance_runtime_tasks");
		const after = await buildInstanceBoard(env(), "i1", "u1");
		const kept = after.items.find((i) => i.ticketId === ticket.id)!;
		expect(kept.title).toBe("Ship it");
		expect(kept.attempts.map((a) => a.id).sort()).toEqual(["card-1", "run-1"]);

		// And another owner's board never shows it.
		expect((await buildInstanceBoard(env(), "i2", "u2")).items.some((i) => i.ticketId === ticket.id)).toBe(false);
	});

	it("deleting the instance's rows through the cascade clears its tickets (the FK holds)", async () => {
		fresh();
		await createTicketCard(env(), "i1", "u1", { id: "card-1", type: "ticket", title: "t", status: "completed", updatedAt: "" }, "human");
		d1.exec("DELETE FROM ticket_runs WHERE instance_id = 'i1'; DELETE FROM tickets WHERE instance_id = 'i1'; DELETE FROM instance_runtime_tasks WHERE instance_id = 'i1'; DELETE FROM agent_triggers WHERE instance_id = 'i1'; DELETE FROM agent_instances WHERE id = 'i1';");
		expect((d1.sqlite.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n).toBe(0);
	});
});
