/**
 * First-class tickets over HTTP (#757) — promote a board card to a ticket, and read one.
 *
 * Owner-scoped like every board route: `requireOwnedInstance` first, then every read and write in
 * `lib/tickets.ts` is keyed by BOTH instance and owner. A card is promoted only if it is on THIS
 * instance's own board, so a job key cannot be used to mint a ticket over another tenant's runs.
 */
import { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { buildInstanceBoard } from "../lib/board.js";
import { attachTicketRuns, getTicket, recordTicket, ticketsForInstance } from "../lib/tickets.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

export const ticketRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /v1/instances/:instanceId/board/items/:jobKey/ticket — make this card a first-class ticket.
 *
 * Idempotent: the first call creates the ticket and stores the card's current runs as its attempts
 * (201); every later call, including a concurrent one, returns the same ticket (200). The card's status,
 * columns and actions are untouched — a ticket's status IS its card's.
 */
ticketRoutes.post("/:instanceId/board/items/:jobKey/ticket", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const jobKey = decodeURIComponent(c.req.param("jobKey")).slice(0, 400);
	if (!jobKey) return c.json({ error: "jobKey required" }, 400);

	const board = await buildInstanceBoard(c.env, instanceId, session.uid);
	const card = board.items.find((i) => i.jobKey === jobKey);
	if (!card) return c.json({ error: "No card with that key on this instance's board" }, 404);

	const { ticket, created } = await recordTicket(c.env, instanceId, session.uid, {
		jobKey,
		title: card.title,
		description: card.description,
		createdBy: "human",
	});
	await attachTicketRuns(
		c.env,
		instanceId,
		session.uid,
		card.attempts.filter((a) => a.id).map((a) => ({ ticketId: ticket.id, taskId: a.id, status: a.status, updatedAt: a.updatedAt })),
	);
	return c.json({ ticket, created, attempts: card.attempts }, created ? 201 : 200);
});

/** GET /v1/instances/:instanceId/tickets/:ticketId — one ticket and its stored runs, newest first. */
ticketRoutes.get("/:instanceId/tickets/:ticketId", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const ticket = await getTicket(c.env, instanceId, session.uid, c.req.param("ticketId"));
	if (!ticket) return c.json({ error: "Ticket not found" }, 404);
	const { runs } = await ticketsForInstance(c.env, instanceId, session.uid);
	const attempts = runs
		.filter((r) => r.ticketId === ticket.id)
		.map((r) => ({ id: r.taskId, status: r.status, updatedAt: r.updatedAt }))
		.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
	return c.json({ ticket, attempts });
});
