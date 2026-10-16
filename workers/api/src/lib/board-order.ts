/**
 * Board order is run order (#1097) — the ordering rule, shared by the board and both drains.
 *
 * Before this, every start order was a FIFO and none was the board's: the objective queue drained by
 * `created_at` (`objective-queue.ts`), the ticket queue by `tickets.created_at` (`ticket-queue.ts`),
 * and the board sorted by "last moved". A queued objective was not even a card. So "the top of
 * Waiting runs next" was false both ways, and nothing could change what started next.
 *
 * Now one key orders all of them: `board_items.position` (migration 0242), on the overlay every card
 * kind already has. The rule, in SQL and here: placed cards first by position, then the never-placed
 * ones in creation order — so append stays the default for every caller that does not place a card.
 *
 * This module is the low layer — the board (`board.ts`) and the ticket queue both import it, so it
 * imports neither at runtime. Placing a card is `board-reorder.ts`.
 */
import type { Env } from "../types.js";

// Structural, not imported: `board.ts`, `objective-queue.ts` and the ticket queue all import THIS module,
// and `import-graph.test.ts` counts a type-only cycle as a cycle.
/** What ordering reads off a board card (a `BoardItemView`). */
interface OrderedCard {
	jobKey: string;
	status: string;
	updatedAt: string;
	position?: number | null;
	ticketId?: string;
	queueEntry?: { id: string; repoId: string | null; createdAt: string };
	runQueue?: RunQueueMarker;
}
/** What ordering reads off a stored ticket (a `Ticket`). */
interface QueuedTicket {
	createdAt?: string;
	pickupAuthority?: "human" | "agent";
	queuePickedAt?: string | null;
}

/** A queued objective's card key: the entry IS a card, keyed on its id. */
export const objectiveJobKey = (entryId: string): string => `objective:${entryId}`;

/** `ORDER BY` for a drain or a list joined to `board_items` as `alias`. One rule everywhere. */
export const boardOrderSql = (alias: string, created: string, id: string): string => `(${alias}.position IS NULL), ${alias}.position, ${created}, ${id}`;

/**
 * The card statuses the ticket queue may start. `needs_human` and `blocked` are deliberately absent — they
 * mean a person is the blocker — and so is `failed`. Compare `RUNNABLE_STATUSES` (what a HUMAN may
 * approve), which includes all three; reusing it here is the mistake #757 §5 names.
 */
export const QUEUE_RUNNABLE_STATUSES: readonly string[] = ["queued", "needs_approval"];

export function isQueueRunnable(status: unknown): boolean {
	return typeof status === "string" && QUEUE_RUNNABLE_STATUSES.includes(status);
}

export async function ticketQueueEnabled(env: Pick<Env, "DB">, instanceId: string, userId: string): Promise<boolean> {
	const row = await env.DB.prepare("SELECT enabled FROM ticket_queues WHERE instance_id = ?1 AND user_id = ?2")
		.bind(instanceId, userId)
		.first<{ enabled: number }>();
	return row?.enabled === 1;
}

/**
 * Whether the platform will start a Waiting card by itself (#1097). `next` marks the card that starts
 * next on its queue: for an objective, when its repo (any repo, for a repo-agnostic one) frees up; for
 * a ticket, on the next sweep with the instance free. `queue: null` is a card that never starts by itself.
 */
export type RunQueueMarker =
	| { queue: "objective" | "ticket"; next: boolean }
	| { queue: null; reason: "human_authority" | "ticket_queue_off" | "picked" | "needs_approval" | "not_queued" };

/** One card per pending queue entry: status `queued`, so it lands in Waiting like any queued card. A `BoardItemView`. */
export function objectiveCards(entries: ReadonlyArray<{ id: string; repoId: string | null; objective: string; createdAt: number }>) {
	return entries.map((e) => ({
		jobKey: objectiveJobKey(e.id),
		latestTaskId: "",
		threadTurns: 0,
		title: e.objective.split("\n", 1)[0].trim() || "Queued objective",
		subtitle: "Queued objective",
		description: e.objective,
		url: "",
		runStatus: "queued",
		userStatus: null,
		status: "queued",
		attempts: [],
		updatedAt: new Date(e.createdAt).toISOString(),
		queueEntry: { id: e.id, repoId: e.repoId, createdAt: new Date(e.createdAt).toISOString() },
	}));
}

/**
 * Sort the board in place: placed cards by position; never-placed Waiting cards in creation order (the
 * order their queue starts them); every other never-placed card newest-moved first, as before.
 */
export function sortBoardItems(items: OrderedCard[], ticketsById: ReadonlyMap<string, QueuedTicket>): void {
	const created = (i: OrderedCard) => Date.parse(i.queueEntry?.createdAt ?? (i.ticketId ? ticketsById.get(i.ticketId)?.createdAt : undefined) ?? i.updatedAt ?? "") || 0;
	const rank = (i: OrderedCard) => (i.position != null ? 0 : isQueueRunnable(i.status) ? 1 : 2);
	items.sort((a, b) => {
		const ra = rank(a);
		const rb = rank(b);
		if (ra !== rb) return ra - rb;
		const d = ra === 0 ? (a.position as number) - (b.position as number) : ra === 1 ? created(a) - created(b) : Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || "");
		return d || (a.jobKey < b.jobKey ? -1 : a.jobKey > b.jobKey ? 1 : 0);
	});
}

/**
 * Which of these queue entries (in board order) starts next when its repo frees up: `dequeueNext` for repo R
 * takes the first entry for R or for any repo, so an entry is next when nothing before it could be taken
 * for the same repo. One rule for the board's marker and for `GET /loop/queue`.
 */
export function objectiveNextFlags(entries: ReadonlyArray<{ repoId: string | null }>): boolean[] {
	let agnosticSeen = false;
	const reposSeen = new Set<string>();
	return entries.map((e) => {
		const next = !agnosticSeen && (e.repoId === null || !reposSeen.has(e.repoId));
		if (e.repoId === null) agnosticSeen = true;
		else reposSeen.add(e.repoId);
		return next;
	});
}

/** Mark every Waiting card with whether — and how soon — the platform starts it. `items` is in board order. */
export function markRunQueue(items: OrderedCard[], ticketsById: ReadonlyMap<string, QueuedTicket>, ticketQueueOn: boolean): void {
	const waiting = items.filter((i) => isQueueRunnable(i.status));
	const objectives = waiting.filter((i) => i.queueEntry);
	const objectiveNext = objectiveNextFlags(objectives.map((i) => ({ repoId: i.queueEntry?.repoId ?? null })));
	objectives.forEach((item, n) => {
		item.runQueue = { queue: "objective", next: objectiveNext[n] };
	});
	let ticketSeen = false;
	for (const item of waiting) {
		if (item.queueEntry) continue;
		const ticket = item.ticketId ? ticketsById.get(item.ticketId) : undefined;
		if (ticket) {
			if (ticket.pickupAuthority !== "agent") item.runQueue = { queue: null, reason: "human_authority" };
			else if (ticket.queuePickedAt) item.runQueue = { queue: null, reason: "picked" };
			else if (!ticketQueueOn) item.runQueue = { queue: null, reason: "ticket_queue_off" };
			else {
				item.runQueue = { queue: "ticket", next: !ticketSeen };
				ticketSeen = true;
			}
			continue;
		}
		item.runQueue = { queue: null, reason: item.status === "needs_approval" ? "needs_approval" : "not_queued" };
	}
}
