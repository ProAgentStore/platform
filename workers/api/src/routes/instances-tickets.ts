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
import { raiseTicketBudget, ticketBudgetView } from "../lib/ticket-budget.js";
import { listTicketProgress } from "../lib/ticket-progress.js";
import { setTicketAuthority, setTicketQueueEnabled, ticketQueueEnabled, ticketQueueState } from "../lib/ticket-queue.js";
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
	const [queue, budget, progress] = await Promise.all([
		ticketQueueState(c.env, instanceId, session.uid, ticket.id),
		ticketBudgetView(c.env, instanceId, session.uid, ticket.id),
		listTicketProgress(c.env, instanceId, session.uid, ticket.id),
	]);
	return c.json({ ticket, attempts, queue, budget, progress });
});

// ── The opt-in ticket queue (#864, #757 slice 3) ───────────────────────────────────────────────────
//
// Human-session routes only, owner-scoped by `requireOwnedInstance` and by instance+owner in every
// statement. There is deliberately no agent tool that reaches them: an agent that could turn the queue
// on, or release a ticket to itself, would convert one prompt injection into standing unattended work.

/** GET /v1/instances/:instanceId/ticket-queue — is this instance's queue on? Off unless its owner turned it on. */
ticketRoutes.get("/:instanceId/ticket-queue", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	return c.json({ enabled: await ticketQueueEnabled(c.env, instanceId, session.uid) });
});

/** PUT /v1/instances/:instanceId/ticket-queue { enabled } — turn autonomous ticket pickup on or off. */
ticketRoutes.put("/:instanceId/ticket-queue", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
	if (typeof body.enabled !== "boolean") return c.json({ error: "enabled (true or false) is required" }, 400);
	await setTicketQueueEnabled(c.env, instanceId, session.uid, body.enabled);
	return c.json({ enabled: body.enabled });
});

/**
 * PUT /v1/instances/:instanceId/tickets/:ticketId/authority { authority, requeue? } — may the queue
 * pick this ticket up on its own (`agent`), or must a person release it (`human`, the default)?
 * `requeue: true` also clears an earlier pickup, offering a ticket whose run failed to the queue again.
 */
ticketRoutes.put("/:instanceId/tickets/:ticketId/authority", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const body = (await c.req.json().catch(() => ({}))) as { authority?: unknown; requeue?: unknown };
	if (body.authority !== "human" && body.authority !== "agent") return c.json({ error: 'authority must be "human" or "agent"' }, 400);
	const ok = await setTicketAuthority(c.env, instanceId, session.uid, c.req.param("ticketId"), body.authority, body.requeue === true);
	if (!ok) return c.json({ error: "Ticket not found" }, 404);
	return c.json({ queue: await ticketQueueState(c.env, instanceId, session.uid, c.req.param("ticketId")) });
});

/**
 * PUT /v1/instances/:instanceId/tickets/:ticketId/budget { limitMicros, requeue? } — the ticket's own
 * allowance (#865). Before its first run it sets the pool the ticket will open; after, it raises that
 * pool and re-opens it if it was exhausted, keeping what was spent — the resume. It never lowers an
 * opened pool. `requeue: true` also offers the ticket to the queue again. A person-only route: an
 * agent that could raise its own ticket's budget would have no budget at all.
 */
ticketRoutes.put("/:instanceId/tickets/:ticketId/budget", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const ticketId = c.req.param("ticketId");
	const body = (await c.req.json().catch(() => ({}))) as { limitMicros?: unknown; requeue?: unknown };
	const raised = await raiseTicketBudget(c.env, instanceId, session.uid, ticketId, Number(body.limitMicros));
	if (!raised.ok) return c.json({ error: raised.error }, raised.status);
	if (body.requeue === true) {
		const state = await ticketQueueState(c.env, instanceId, session.uid, ticketId);
		if (state) await setTicketAuthority(c.env, instanceId, session.uid, ticketId, state.authority, true);
	}
	return c.json({ budget: raised.view, queue: await ticketQueueState(c.env, instanceId, session.uid, ticketId) });
});
