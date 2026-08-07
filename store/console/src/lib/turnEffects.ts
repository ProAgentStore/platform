import { classifyMessage, toolCallSummary, type ChatMessageLike } from "@proagentstore/sdk/ui";

/**
 * What a turn DID, and how to say so before deleting it (#342).
 *
 * ── The failure this exists to prevent
 *
 * Deleting the message does not undo what it caused. That is the whole motivation for the feature
 * — *"it picked up some noise and did something based on that"* — and the naive implementation
 * makes it worse: if noise triggered `start_work`, removing the transcript leaves the run going
 * with nothing on screen explaining why the agent is working. #251 was that shape by accident (the
 * side effects persisted while the record vanished); doing it deliberately would be worse.
 *
 * So the confirmation names the tools the turn ran, and says plainly that deleting the transcript
 * is not a retraction. If nothing can be undone, the honest thing is to say so and let the user
 * delete anyway. The goal is an accurate record, not a flattering one.
 *
 * ── Why the span is recomputed here instead of trusted from the server
 *
 * The server owns what is actually deleted (`turnSpanFor` in workers/api/src/lib/chat-turns.ts)
 * and reports the ids it removed. This is the same rule applied to what is ON SCREEN, purely so
 * the sentence can be written BEFORE the request. Presentation, not authority: if the console has
 * only a page of the log and the server sees more, the server's answer is what happened.
 */

/** The tool names a turn ran, as a short label ("write_memory, start_work" / "4 tools"), or
 *  `null` when the turn ran none. */
export function turnEffectSummary(messages: ChatMessageLike[], targetId: string): string | null {
	const index = messages.findIndex((m) => m?.id === targetId);
	if (index < 0) return null;
	let start = index;
	while (start > 0 && messages[start].role !== "user") start--;
	if (messages[start].role !== "user") start = index; // no ask before it — a standalone notice
	let end = messages.length;
	for (let i = start + 1; i < messages.length; i++) {
		if (messages[i].role === "user") {
			end = i;
			break;
		}
	}
	const tools = messages.slice(start, end).filter((m) => classifyMessage(m) === "tool");
	if (!tools.length) return null;
	return tools.map((m) => toolCallSummary(m.content)).join(", ");
}

/**
 * The confirmation text. One sentence for what goes, one for what stays — the second is the one
 * that matters, and it is present even when the turn ran no tools, because "nothing to undo" is
 * itself information the user is entitled to before they act.
 */
export function deleteTurnPrompt(effects: string | null): string {
	const removes =
		"Delete this turn?\n\nRemoves your message, the agent's reply, the tool log and the voice recording from the transcript — and from the context of every later reply.";
	const keeps = effects
		? `\n\nThis turn ran: ${effects}.\nDeleting the transcript does NOT undo that. Anything it started keeps running; anything it wrote stays written.`
		: "\n\nThis turn ran no tools, so there is nothing it did that could outlive it.";
	return removes + keeps;
}

/** Asked only when a run is still going: the transcript is gone, the work is not. */
export const STOP_RUN_PROMPT =
	"That turn is deleted, but a run is still going. Stop it too?";
