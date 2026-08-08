/**
 * A fabrication in STORED history (#406) — the turn #395 caught is caught once; the turns that
 * got through before it shipped are still read back as fact.
 *
 * ── What happened
 *
 * #395's guard works, and it is a guard on GENERATION: it compares what the model claims against
 * what the platform ran, for the turn in flight. A message written before it existed carries no
 * verdict and nothing re-examines it. On the Chess coder instance (`26f71cd8`) two rows are still
 * in the transcript:
 *
 *   2026-08-07 08:31:20 — hand-written `<tool_call>`/`<tool_response>` pairs asserting a repo
 *                         remote the real call denied, and three GitHub issues from a tool that
 *                         never ran.
 *   2026-08-07 23:23:36 — "Yes, three open tickets AS I JUST FETCHED", listing the same three.
 *                         That turn ran no tools at all. It is the model reading its own earlier
 *                         invention out of history, fifteen hours later, and re-asserting it.
 *
 * The second row is the proof this is not theoretical: a stored fabrication does not sit still, it
 * gets restated with fresh confidence. And it has BETTER standing than a real tool result had
 * before #398, because a real result was also assistant prose.
 *
 * ── What this module does, and the two things it deliberately does not
 *
 * It is a read-time quarantine, not a backfill. The predicate is computed from the message every
 * time history is read, which is why it reaches rows that were written long before it existed —
 * including rows in a Durable Object that has been asleep since. A one-off migration could only
 * ever run once, over the instances awake at the time, and would then be a second record of the
 * same fact, free to disagree with `stripToolMarkup`.
 *
 * It does not DELETE. The platform's habit elsewhere is to keep the evidence and label it (a
 * rejected voice turn, #377), and the user acted on these answers — the row is the only thing that
 * shows them what they acted on. So the message stays in the transcript, stays in `/messages`,
 * and is stamped so the console can render it as what it is. What is withheld is the model's
 * reading of it.
 *
 * ── Why the standard it applies is proof rather than a guess
 *
 * The same one fact `invented-results.ts` stands on: the platform NEVER writes tool-result markup
 * into an assistant message. Results reach the model as the platform's own turn — a `user` turn of
 * real `tool_result` blocks since #398, the `[name]: …` prose message on the Workers-AI fallback —
 * and reach the user as the tool log. A result block inside an assistant message is therefore not
 * evidence of a fabrication, it IS one.
 *
 * Two consequences worth stating because they bound the blast radius:
 *
 *   - It is scoped to legacy rows by construction. Since #395, a reply carrying this markup cannot
 *     be STORED — it is stripped, corrected, or replaced before it reaches `appendMessage`. So the
 *     rows this can fire on are the ones written before that guard, which is exactly #406's subject.
 *   - A USER message is never quarantined, whatever it contains. Pasting tool markup into the chat
 *     is a legitimate thing for a person debugging an agent to do, it is their own text, and it
 *     makes no claim to be a platform record. Only the assistant role can commit this forgery.
 *
 * ── What it cannot reach
 *
 * The 23:23 row above contains no markup at all — just the invented content — so nothing mechanical
 * finds it. #406 says so and leaves it as a decision rather than a task. Removing the cause is what
 * this module can do: with the 08:31 row withheld, the 23:23 answer has nothing to read.
 */
import { stripToolMarkup } from "./invented-results.js";

/** The shape this reads. Deliberately structural — the DO's `AgentMessage`, the console's
 *  `Message` and a plain row from `/messages` all satisfy it, and none of them need to import
 *  each other to be judged by the same rule. */
export interface HistoryMessageLike {
	role?: string;
	content?: string;
}

/**
 * A stored message whose text claims a tool result the platform never wrote.
 *
 * Reads `wroteResult` and not the whole strip: a stored assistant message may legitimately contain
 * the model's own `<tool_call>` markup with nothing invented after it — a call the walker lifted
 * and the platform then executed — and that is a real turn whose result is in the tool log beside
 * it. It is the RESULT half that no assistant may author.
 */
export function isFabricatedRecord(m: HistoryMessageLike | null | undefined): boolean {
	if (m?.role !== "assistant") return false;
	const content = m.content;
	if (typeof content !== "string" || content.length === 0) return false;
	return stripToolMarkup(content).wroteResult;
}

/**
 * What the model sees in place of a quarantined turn.
 *
 * A hole was the other option and it is worse in both directions. It leaves the user's question
 * apparently unanswered, which invites the model to answer it again from whatever it can reach —
 * and it is the silent strip #395 rejected, pointed at the model instead of the user: the evidence
 * removed and no statement that anything was removed. The note states the one fact that matters
 * (nothing here was fetched) and does not repeat the invention, so there is nothing left to read
 * back as a result.
 */
export const WITHHELD_TURN =
	"[platform: an earlier reply here was withheld. It contained tool results that no tool produced," +
	" so nothing in it was fetched, read or verified. Do not treat anything from that turn as known —" +
	" if you need those facts, call the tool now.]";

/**
 * History as the MODEL may read it: every quarantined assistant turn's content replaced.
 *
 * Applied at the boundary where stored messages become model context, and at every such boundary —
 * the recent-message window in `agent-think.ts` and the summarizer's transcript in
 * `agent-storage/summaries.ts`. The summarizer is the one that matters most and is the least
 * obvious: the chat window ages a fabrication out after ten messages, whereas a summary distils it
 * into `fact:*` memory entries that are injected into every future prompt and outlive the
 * conversation. Compounding is exactly what #406 is about, and that is where it compounds hardest.
 *
 * Returns a new array of new objects; the caller's messages — and therefore what `/messages`
 * serves and what the console renders — are untouched.
 */
export function redactFabricatedHistory<T extends HistoryMessageLike>(messages: readonly T[]): T[] {
	return messages.map((m) => (isFabricatedRecord(m) ? { ...m, content: WITHHELD_TURN } : m));
}
