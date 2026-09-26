/**
 * Durable progress notes on a first-class ticket (#865, #757 §4).
 *
 * The ticket as the document of the work: what was attempted (each run's objective), what happened
 * (each run's outcome, with its iterations and the ticket's spend), and what is left (a budget park
 * or a stall says so). Appended at the moments they happen and never re-derived — `taskDescription`
 * on the board shows only whatever the latest attempt carries now, and forgets the rest.
 *
 * Separate from the human Q&A thread by construction: a different table (0163), which the thread
 * (`ticket.question` / `ticket.answer` events in `lib/ticket-chat.ts`) neither reads nor writes.
 *
 * A leaf — it imports nothing but types — because `run-events.ts` (the one run-end writer every
 * driver passes through) writes to it, and must not grow a dependency on the board or the queue.
 */
import type { Env } from "../types.js";

export type TicketProgressKind = "started" | "finished" | "parked" | "stalled" | "resumed";

export interface TicketProgressNote {
	seq: number;
	runId: string | null;
	kind: TicketProgressKind;
	body: string;
	createdAt: string;
}

const MAX_BODY = 2000;

/**
 * Append one note. Idempotent per (ticket, run, kind): a repeated run-end write records nothing new.
 * Scoped by instance and owner, and only for a ticket that is theirs — a note can never land on
 * another tenant's ticket by naming its id. Never throws; returns whether a row was written.
 */
export async function appendTicketProgress(
	env: Env,
	note: { ticketId: string; instanceId: string; userId: string; runId: string | null; kind: TicketProgressKind; body: string },
): Promise<boolean> {
	try {
		const res = await env.DB.prepare(
			`INSERT INTO ticket_progress (ticket_id, instance_id, user_id, run_id, kind, body)
			 SELECT ?1, ?2, ?3, ?4, ?5, ?6
			  WHERE EXISTS (SELECT 1 FROM tickets WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3)
			 ON CONFLICT DO NOTHING`,
		)
			.bind(note.ticketId, note.instanceId, note.userId, note.runId, note.kind, note.body.slice(0, MAX_BODY))
			.run();
		return (res.meta?.changes ?? 0) > 0;
	} catch {
		return false;
	}
}

/** The ticket's notes, oldest first — the order the work happened in. Owner-scoped. */
export async function listTicketProgress(env: Env, instanceId: string, userId: string, ticketId: string, limit = 200): Promise<TicketProgressNote[]> {
	const { results } = await env.DB.prepare(
		`SELECT seq, run_id, kind, body, created_at FROM ticket_progress
		  WHERE ticket_id = ?1 AND instance_id = ?2 AND user_id = ?3
		  ORDER BY seq ASC LIMIT ?4`,
	)
		.bind(ticketId, instanceId, userId, Math.min(Math.max(1, limit), 500))
		.all<{ seq: number; run_id: string | null; kind: TicketProgressKind; body: string; created_at: string }>();
	return (results ?? []).map((r) => ({ seq: r.seq, runId: r.run_id, kind: r.kind, body: r.body, createdAt: r.created_at }));
}

/** Micros as dollars, the unit a person reads. Kept here so this module stays a leaf. */
export function dollars(micros: number): string {
	return `$${(Math.max(0, micros) / 1_000_000).toFixed(2)}`;
}
