/**
 * Per-ticket conversation — #150 P2, the last of the three ticket properties.
 *
 * A ticket already carries WHAT happened (title/description/status) and WHY (`reasoning`,
 * #150 P1), and a runner-less agent can raise one (`/tasks/direct` + the `create_ticket`
 * registry tool, #150 P3). What was missing is the ability to ASK: open a ticket and
 * interrogate it — "why did you decide that", "what did you actually change", "what did
 * you skip". Without it, review is read-only: a supervisor can see a card but cannot
 * question it, and the follow-up ends up in the Assistant chat where it is detached from
 * the work it is about and answered from the whole instance's context rather than this
 * one unit of work.
 *
 * NO NEW STORAGE. `instance_runtime_task_events` (migration 0012) is already a per-task,
 * append-only, tenant-scoped log — exactly the shape a scoped thread needs — so a turn is
 * just another event on the ticket (`ticket.question` / `ticket.answer`). That also means
 * the conversation is deleted with the ticket, is already carried by every reader of the
 * task-event stream, and did not add a fifth record of "what happened" alongside
 * `agent_events`, `board_items`, `coding_timeline` and the delegation runs.
 *
 * This module is PURE (no env, no I/O, no D1) so the thread projection and the prompt
 * assembly are unit-testable; the route owns persistence and the model call.
 */

/** One turn of a ticket's conversation. `agent` is the model answering AS the agent that
 *  did the work — there is no third party in a ticket thread. */
import { overLimit } from "./write-limits.js";
import { clipMarked } from "./clip-marked.js";

export interface TicketTurn {
	id: string;
	role: "user" | "agent";
	text: string;
	at: string;
}

/** Event types that ARE the conversation. Everything else on the task is activity. */
export const TICKET_QUESTION_EVENT = "ticket.question";
export const TICKET_ANSWER_EVENT = "ticket.answer";

/** Hard caps. A ticket thread is a focused interrogation of one card, not a second chat
 *  surface, so the history it replays is deliberately short and the answer is short too. */
export const MAX_TICKET_QUESTION_CHARS = 4000;
export const MAX_TICKET_ANSWER_CHARS = 8000;
/** The answer's output budget: room for a detailed answer when asked (~6,000 chars). It was 700
 *  tokens (~2,800 chars), and the stop reason was never read, so a detailed answer ended mid-word. */
export const TICKET_ANSWER_MAX_TOKENS = 1500;
/** Prior turns replayed into the prompt (newest kept). */
export const TICKET_THREAD_CONTEXT_TURNS = 12;
/** Activity lines replayed into the prompt (newest kept). */
export const TICKET_ACTIVITY_CONTEXT_LINES = 40;

function isRecord(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function eventStamp(ev: Record<string, unknown>): string {
	return str(ev.createdAt) || str(ev.created_at) || str(ev.timestamp) || "";
}

function byStampAsc(a: { at: string }, b: { at: string }): number {
	const x = Date.parse(a.at) || 0;
	const y = Date.parse(b.at) || 0;
	return x - y;
}

/**
 * Project a task's raw event stream into the conversation, oldest → newest. Only the two
 * conversation event types are picked up, so the ticket's ordinary activity (screenshots,
 * lifecycle, tool steps) stays out of the thread even though it shares the table.
 */
export function ticketThreadFromEvents(events: unknown[]): TicketTurn[] {
	const turns: TicketTurn[] = [];
	for (const raw of events) {
		if (!isRecord(raw)) continue;
		const type = str(raw.type);
		if (type !== TICKET_QUESTION_EVENT && type !== TICKET_ANSWER_EVENT) continue;
		const text = str(raw.message).trim();
		if (!text) continue;
		turns.push({
			id: str(raw.id) || `${type}:${turns.length}`,
			role: type === TICKET_QUESTION_EVENT ? "user" : "agent",
			text,
			at: eventStamp(raw),
		});
	}
	return turns.sort(byStampAsc);
}

/**
 * The ticket record, rendered for the model. Everything the answer is allowed to rest on
 * lives here — the fields are labelled in plain words rather than dumped as raw JSON,
 * because a model given `{"status":"needs_approval"}` reliably narrates the JSON back.
 */
export function ticketFactsBlock(task: unknown): string {
	if (!isRecord(task)) return "TICKET: (not found)";
	const lines: string[] = [];
	const push = (label: string, value: unknown) => {
		const s = typeof value === "string" ? value.trim() : value == null ? "" : String(value);
		if (s) lines.push(`${label}: ${s}`);
	};
	push("Title", task.title);
	push("Kind", task.type);
	push("Status", task.status);
	push("Created", task.createdAt ?? task.created_at);
	push("Last updated", task.updatedAt ?? task.updated_at);
	if (isRecord(task.input) && task.input.url) push("URL", task.input.url);
	push("Description", task.description);
	push("Error", task.error);
	// The result of an actionable ticket's declared work — what approving it actually did.
	if (task.result !== undefined && task.result !== null && task.result !== "") {
		push("Result", clipMarked(typeof task.result === "string" ? task.result : JSON.stringify(task.result), 2000));
	}
	// The declared action is the ticket's PROMISE: what approving it will run. A question
	// like "what happens if I approve this?" is answerable only from this.
	if (isRecord(task.action) && task.action.action) {
		const cfg = isRecord(task.action.config) ? clipMarked(JSON.stringify(task.action.config), 1000) : "";
		push("Declared action (runs on approval)", `${String(task.action.action)}${cfg && cfg !== "{}" ? ` ${cfg}` : ""}`);
	}
	const reasoning = str(task.reasoning).trim();
	const facts = lines.length ? lines.join("\n") : "(no fields recorded)";
	return `TICKET:\n${facts}\n\nWHY (the agent's own recorded reasoning for this ticket):\n${reasoning || "(none recorded)"}`;
}

/** The ticket's activity, newest-last, as plain lines. Excludes screenshots (binary noise)
 *  and the conversation itself (replayed separately, with roles). */
export function ticketActivityBlock(events: unknown[], max = TICKET_ACTIVITY_CONTEXT_LINES): string {
	const lines: { at: string; text: string }[] = [];
	for (const raw of events) {
		if (!isRecord(raw)) continue;
		const type = str(raw.type);
		if (type === "agent.shot" || type === TICKET_QUESTION_EVENT || type === TICKET_ANSWER_EVENT) continue;
		const msg = str(raw.message).trim() || type;
		if (!msg) continue;
		lines.push({ at: eventStamp(raw), text: clipMarked(`${eventStamp(raw) || "?"} — ${msg}`, 400) });
	}
	if (!lines.length) return "ACTIVITY: (nothing recorded for this ticket)";
	const kept = lines.sort(byStampAsc).slice(-max);
	// Said, not silent (#898): the prompt tells the model an unrecorded detail is "not recorded",
	// so an event that merely fell outside the window was denied as if it never happened.
	const omitted = lines.length - kept.length;
	const note = omitted > 0 ? `(${omitted} earlier activity line${omitted === 1 ? "" : "s"} not shown)\n` : "";
	return `ACTIVITY (what was recorded for this ticket, oldest→newest):\n${note}${kept.map((l) => l.text).join("\n")}`;
}

/**
 * The system prompt. Two rules carry the weight:
 *
 *  • GROUNDING. The model is answering about work it cannot re-inspect — the run is over
 *    and this thread has no tools. Its only honest source is the record below, so an
 *    unrecorded detail must come back as "that isn't recorded", never as a plausible
 *    reconstruction. A confabulated answer here is worse than no ticket thread at all,
 *    because it is read as the audit trail.
 *  • NO ACTION. A thread is for understanding, not instructing. The ticket's declared
 *    action is fixed at creation and only approval runs it (see actionable-ticket.ts); if
 *    a question could be read as a command, the answer says what to press, and does
 *    nothing. Otherwise the approval gate would have a free-text bypass.
 */
export const TICKET_CHAT_SYSTEM =
	"You are the agent that produced the ticket below, answering the owner's questions about THIS ONE ticket.\n" +
	"GROUND EVERY CLAIM in the ticket record and activity you are given. You cannot re-run anything, re-read any repo, or look anything up — this thread has no tools. If the answer is not in the record, say plainly that it is not recorded (e.g. \"That isn't in this ticket's record\") and stop. Where the record is marked as cut or says earlier lines are not shown, a detail that could sit in the missing part is \"not in the part of the record I was given\" — never \"it did not happen\". Never reconstruct, estimate, or infer what probably happened: a guess here is read as the audit trail. A negative is a claim too — only say \"nothing changed\" or \"it did not do X\" if the record shows it.\n" +
	"NEVER say an action succeeded, was skipped, or was undone unless the record says so.\n" +
	"You CANNOT act from this thread — you cannot start work, change the ticket, approve it, or run its declared action. If asked to do something, say what the owner should do instead (e.g. \"Approve the ticket to run that\") and do not claim to have done it.\n" +
	"Answer in plain language, 1-3 short sentences by default; go longer only when asked for detail. Do not restate the whole ticket back — answer the question that was asked.";

/** Assemble the model messages for one question on one ticket. Pure: the caller supplies
 *  the stored ticket, its events, and the new question. */
export function buildTicketChatMessages(args: {
	task: unknown;
	events: unknown[];
	question: string;
	/** Owner's standing rules (instance Special Instructions), when set. */
	specialInstructions?: string;
	/** Events older than the ones loaded (#898) — named in the prompt so they are not denied. */
	olderEventsNotLoaded?: number;
}): Array<{ role: string; content: string }> {
	const all = ticketThreadFromEvents(args.events);
	const thread = all.slice(-TICKET_THREAD_CONTEXT_TURNS);
	const older = all.length - thread.length;
	const history = thread.length
		? `EARLIER IN THIS TICKET'S THREAD (oldest→newest):\n${older > 0 ? `(${older} earlier turn${older === 1 ? "" : "s"} not shown)\n` : ""}${thread.map((t) => `${t.role === "user" ? "Owner" : "You"}: ${t.text}`).join("\n")}`
		: "";
	const content = [
		ticketFactsBlock(args.task),
		ticketActivityBlock(args.events),
		args.olderEventsNotLoaded ? `(This ticket has ${args.olderEventsNotLoaded} older recorded event${args.olderEventsNotLoaded === 1 ? "" : "s"} that were not loaded for this answer.)` : "",
		args.specialInstructions?.trim() ? `OWNER'S STANDING RULES:\n${clipMarked(args.specialInstructions.trim(), 4000)}` : "",
		history,
		`THE OWNER ASKS:\n${args.question.trim()}`,
	]
		.filter(Boolean)
		.join("\n\n");
	return [
		{ role: "system", content: TICKET_CHAT_SYSTEM },
		{ role: "user", content },
	];
}

/** Validate + normalize an incoming question. Returns an error string, or the trimmed text. */
export function normalizeTicketQuestion(value: unknown): { question: string } | { error: string } {
	if (typeof value !== "string" || !value.trim()) return { error: "message required" };
	// Refused, not cut (#898): a question that lost its end is answered as a different question.
	const tooLong = overLimit({ message: [value.trim(), MAX_TICKET_QUESTION_CHARS] });
	return tooLong ? { error: tooLong } : { question: value.trim() };
}
