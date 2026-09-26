/**
 * First-class tickets (#757, slices 1+2): a board card with an identity that exists before any run,
 * and runs attached to it as a stored relation.
 *
 * Until this, a card was only a read-time grouping of runtime-task rows (`jobKeyForTask` in
 * `board.ts`): nothing could sit on the board before something dispatched it, and "which runs belong
 * to this card" was a `Map` rebuilt on every 2.5s poll. Now:
 *
 *   - A ticket is a row in `tickets` (migration 0160), unique per `(instance_id, job_key)`, so
 *     promoting a card is idempotent and two promotions cannot mint two tickets.
 *   - Its runs are rows in `ticket_runs`, each with the run's last observed status, so an attempt
 *     survives its runtime row being cleared or aged out of the board window.
 *   - Humans (`POST /tasks/direct`, promotion) and agents (`create_ticket`) create tickets through ONE
 *     function, {@link createTicketCard}.
 *
 * What does NOT change: `BoardItemView`'s shape (one optional `ticketId` is added), and the ticket's
 * status — it is its card's status, so the human overlay, approvals and runs work exactly as before.
 * Scheduling, authority, budget and progress notes (#757 slices 3-4) are separate issues.
 *
 * Tenancy: every read and write here is scoped by BOTH `instance_id` and `user_id`, and a run is
 * attached only when it was read from that same instance's own board.
 *
 * This module must not import `board.ts` (the board imports it).
 */
import { HttpError } from "./auth.js";
import { mirrorRuntimeTask } from "../routes/instances-runtime.js";
import type { Env } from "../types.js";

export interface Ticket {
	id: string;
	instanceId: string;
	jobKey: string;
	title: string;
	description: string;
	createdBy: "human" | "agent";
	createdAt: string;
}

/** A stored attempt: one run attached to a ticket, with its last observed state. */
export interface TicketRun {
	ticketId: string;
	taskId: string;
	status: string;
	updatedAt: string;
}

interface TicketRow {
	id: string;
	instance_id: string;
	job_key: string;
	title: string;
	description: string;
	created_by: "human" | "agent";
	created_at: string;
}

const toTicket = (r: TicketRow): Ticket => ({
	id: r.id,
	instanceId: r.instance_id,
	jobKey: r.job_key,
	title: r.title,
	description: r.description,
	createdBy: r.created_by,
	createdAt: r.created_at,
});

/**
 * The ticket for a board card, creating it if there is none — idempotent by construction: the unique
 * `(instance_id, job_key)` index decides, so a repeat or a concurrent promotion gets the existing row.
 */
export async function recordTicket(
	env: Env,
	instanceId: string,
	userId: string,
	input: { jobKey: string; title: string; description?: string; createdBy: "human" | "agent" },
): Promise<{ ticket: Ticket; created: boolean }> {
	const id = `tkt_${crypto.randomUUID()}`;
	const res = await env.DB.prepare(
		`INSERT INTO tickets (id, instance_id, user_id, job_key, title, description, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(instance_id, job_key) DO NOTHING`,
	)
		.bind(id, instanceId, userId, input.jobKey.slice(0, 400), input.title.slice(0, 200) || input.jobKey.slice(0, 200), (input.description ?? "").slice(0, 2000), input.createdBy)
		.run();
	const row = await env.DB.prepare(
		"SELECT id, instance_id, job_key, title, description, created_by, created_at FROM tickets WHERE instance_id = ?1 AND user_id = ?2 AND job_key = ?3",
	)
		.bind(instanceId, userId, input.jobKey.slice(0, 400))
		.first<TicketRow>();
	// Another tenant cannot hold this instance's job key (instance ids are owner-scoped by the caller),
	// so a missing row after the insert is a genuine failure, not a conflict to paper over.
	if (!row) throw new Error("ticket could not be recorded");
	return { ticket: toTicket(row), created: (res.meta?.changes ?? 0) > 0 };
}

/** One of this owner's tickets on this instance, or null. */
export async function getTicket(env: Env, instanceId: string, userId: string, ticketId: string): Promise<Ticket | null> {
	const row = await env.DB.prepare(
		"SELECT id, instance_id, job_key, title, description, created_by, created_at FROM tickets WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3",
	)
		.bind(ticketId, instanceId, userId)
		.first<TicketRow>();
	return row ? toTicket(row) : null;
}

/** Every ticket on an instance with its stored runs — what the board overlays onto its cards. */
export async function ticketsForInstance(env: Env, instanceId: string, userId: string): Promise<{ tickets: Ticket[]; runs: TicketRun[] }> {
	const [t, r] = await Promise.all([
		env.DB.prepare("SELECT id, instance_id, job_key, title, description, created_by, created_at FROM tickets WHERE instance_id = ?1 AND user_id = ?2")
			.bind(instanceId, userId)
			.all<TicketRow>()
			.catch(() => ({ results: [] as TicketRow[] })),
		env.DB.prepare("SELECT ticket_id, task_id, status, updated_at FROM ticket_runs WHERE instance_id = ?1 AND user_id = ?2")
			.bind(instanceId, userId)
			.all<{ ticket_id: string; task_id: string; status: string; updated_at: string }>()
			.catch(() => ({ results: [] as Array<{ ticket_id: string; task_id: string; status: string; updated_at: string }> })),
	]);
	return {
		tickets: (t.results ?? []).map(toTicket),
		runs: (r.results ?? []).map((x) => ({ ticketId: x.ticket_id, taskId: x.task_id, status: x.status, updatedAt: x.updated_at })),
	};
}

/** Store runs against a ticket, or refresh their last observed state. Only for runs read from this instance. */
export async function attachTicketRuns(env: Env, instanceId: string, userId: string, runs: readonly TicketRun[]): Promise<void> {
	if (!runs.length) return;
	await env.DB.batch(
		runs.map((r) =>
			env.DB.prepare(
				`INSERT INTO ticket_runs (ticket_id, task_id, instance_id, user_id, status, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM tickets WHERE id = ?1 AND instance_id = ?3 AND user_id = ?4)
         ON CONFLICT(ticket_id, task_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
			).bind(r.ticketId, r.taskId, instanceId, userId, r.status, r.updatedAt),
		),
	);
}

/**
 * One board card, as the ticket overlay sees it: its key, its attempts as grouped from runtime rows,
 * and the explicit `ticketId` any of those rows carries.
 */
export interface CardAttempts {
	jobKey: string;
	attempts: Array<{ id: string; status: string; updatedAt: string; ticketId?: string }>;
}

/**
 * Overlay stored tickets onto the board's cards (#757). Pure: it returns what the board should show
 * and what should be written, and writes nothing.
 *
 *   - A card with a ticket gets `ticketId`, and its attempts become the STORED runs plus any grouped
 *     run not yet stored — which is then stored (`attach`). A stored run whose row is gone keeps its
 *     last observed status, so the attempt list no longer shrinks when runs are cleared.
 *   - A run whose payload names a `ticketId` of this instance is attached to that ticket even when its
 *     job key is different — the explicit form of the relation.
 *   - A stored run whose status changed since it was stored is refreshed (`attach` again); nothing is
 *     written when nothing changed, so a 2.5s poll does not write.
 *   - A ticket with no card on the board (created before any run, or every run cleared) is returned in
 *     `standalone`, with its stored attempts, so it still shows.
 */
export function overlayTickets(
	cards: readonly CardAttempts[],
	stored: { tickets: readonly Ticket[]; runs: readonly TicketRun[] },
): {
	byJobKey: Map<string, { ticketId: string; attempts: Array<{ id: string; status: string; updatedAt: string }> }>;
	standalone: Array<{ ticket: Ticket; attempts: Array<{ id: string; status: string; updatedAt: string }> }>;
	attach: TicketRun[];
} {
	const ticketByKey = new Map(stored.tickets.map((t) => [t.jobKey, t]));
	const ticketIds = new Set(stored.tickets.map((t) => t.id));
	const runsByTicket = new Map<string, Map<string, TicketRun>>();
	for (const r of stored.runs) {
		if (!ticketIds.has(r.ticketId)) continue;
		const m = runsByTicket.get(r.ticketId) ?? new Map<string, TicketRun>();
		m.set(r.taskId, r);
		runsByTicket.set(r.ticketId, m);
	}
	const attach: TicketRun[] = [];
	const observe = (ticketId: string, a: { id: string; status: string; updatedAt: string }) => {
		if (!a.id) return;
		const m = runsByTicket.get(ticketId) ?? new Map<string, TicketRun>();
		const had = m.get(a.id);
		if (!had || had.status !== a.status || had.updatedAt !== a.updatedAt) attach.push({ ticketId, taskId: a.id, status: a.status, updatedAt: a.updatedAt });
		m.set(a.id, { ticketId, taskId: a.id, status: a.status, updatedAt: a.updatedAt });
		runsByTicket.set(ticketId, m);
	};

	// Explicit attachments first, so a run naming its ticket joins it whatever card it grouped under.
	for (const card of cards) for (const a of card.attempts) if (a.ticketId && ticketIds.has(a.ticketId)) observe(a.ticketId, a);
	for (const card of cards) {
		const t = ticketByKey.get(card.jobKey);
		if (t) for (const a of card.attempts) if (!a.ticketId || !ticketIds.has(a.ticketId)) observe(t.id, a);
	}

	const newestFirst = (m: Map<string, TicketRun> | undefined) =>
		[...(m?.values() ?? [])]
			.map((r) => ({ id: r.taskId, status: r.status, updatedAt: r.updatedAt }))
			.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
	const onBoard = new Set(cards.map((c) => c.jobKey));
	const byJobKey = new Map<string, { ticketId: string; attempts: Array<{ id: string; status: string; updatedAt: string }> }>();
	const standalone: Array<{ ticket: Ticket; attempts: Array<{ id: string; status: string; updatedAt: string }> }> = [];
	for (const t of stored.tickets) {
		const attempts = newestFirst(runsByTicket.get(t.id));
		if (onBoard.has(t.jobKey)) byJobKey.set(t.jobKey, { ticketId: t.id, attempts });
		else standalone.push({ ticket: t, attempts });
	}
	return { byJobKey, standalone, attach };
}

/**
 * Put a ticket card on the board AND record it as a first-class ticket — the ONE creation path for
 * humans (`POST /tasks/direct`) and agents (`create_ticket`). The card is the same runtime-task row it
 * always was (so approvals, the thread and `/tasks/:id/run` are untouched); the ticket is keyed on it
 * and holds that row as its first attempt. The card has no URL, so its board key is its id.
 */
export async function createTicketCard(
	env: Env,
	instanceId: string,
	userId: string,
	task: { id: string; title: string; description?: string; status: string; updatedAt: string } & Record<string, unknown>,
	createdBy: "human" | "agent",
): Promise<Ticket> {
	await mirrorRuntimeTask(env, instanceId, userId, task);
	// A caller-chosen id (`POST /tasks/direct` accepts one) that is another tenant's row: the mirror
	// refuses to overwrite it, and the ticket must not be recorded over it either.
	const own = await env.DB.prepare("SELECT 1 AS ok FROM instance_runtime_tasks WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3")
		.bind(task.id, instanceId, userId)
		.first<{ ok: number }>();
	if (!own) throw new HttpError(409, "That task id is already in use — omit `id` to let the platform choose one.");
	const { ticket } = await recordTicket(env, instanceId, userId, { jobKey: task.id, title: task.title, description: task.description, createdBy });
	await attachTicketRuns(env, instanceId, userId, [{ ticketId: ticket.id, taskId: task.id, status: task.status, updatedAt: task.updatedAt }]);
	return ticket;
}
