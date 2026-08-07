/**
 * What a "turn" IS, as one pure rule (#342).
 *
 * The platform could clear a whole conversation but not remove one exchange, so a mis-heard voice
 * turn — the phantom "Coder Lead" transcripts of #332, or anything the recogniser mangled — was
 * permanent unless you destroyed everything. That matters beyond tidiness: the thread is the
 * context, so a noise message keeps shaping every later reply until the conversation rolls over.
 *
 * ── Why the unit is the exchange, not the message
 *
 * A user message never stands alone. The assistant's reply and the tool-log system message are
 * written in the same turn and are meaningless without it; deleting one line would leave an answer
 * to a question nobody asked. So the unit of deletion is: the user message, everything the agent
 * wrote in response, and nothing belonging to the next exchange.
 *
 * ── The anchor rule
 *
 * Deleting is invoked by pointing at ONE message — which may be the user's or the agent's. So the
 * target is resolved to its turn:
 *
 *   1. Walk BACK to the nearest `user` message at or before the target. That is the anchor.
 *   2. Take everything from the anchor up to (excluding) the NEXT `user` message.
 *
 * A message with no user message before it anywhere — a loop-status notice, the interrupted-turn
 * notice of #251, a system message written before the first thing the user ever said — is its own
 * span of one. It is not part of anyone's exchange, and quietly swallowing the messages after it
 * would delete an exchange the user never pointed at.
 *
 * ── Why this is here and not in the SDK
 *
 * The server is the authority on what a delete removes: it is the only side that can see the whole
 * log (the console holds a page of it) and the only side that can act. The console's confirmation
 * text summarises the same span from what it has on screen, but that is presentation — if the two
 * ever disagree, what the server deleted is what happened, which is why the delete response
 * reports the ids it actually removed rather than assuming the caller knew.
 */

/** The shape this rule needs off a stored message — deliberately minimal, so the DO's own
 *  `AgentMessage` and any test fixture satisfy it without conversion. */
export interface TurnMessageLike {
	id: string;
	role: string;
}

/**
 * The messages that make up the turn containing `targetId`, in log order.
 *
 * Returns an empty array when no message has that id — the caller answers 404 rather than
 * deleting a neighbouring turn, because an id the caller made up must not resolve to something.
 */
export function turnSpanFor<T extends TurnMessageLike>(messages: T[], targetId: string): T[] {
	const index = messages.findIndex((m) => m?.id === targetId);
	if (index < 0) return [];

	// The anchor: the target itself if it is the user's, else the nearest user message before it.
	let start = -1;
	for (let i = index; i >= 0; i--) {
		if (messages[i].role === "user") {
			start = i;
			break;
		}
	}
	// No user message anywhere before the target → a standalone system row, its own span of one.
	if (start < 0) return [messages[index]];

	let end = messages.length;
	for (let i = start + 1; i < messages.length; i++) {
		if (messages[i].role === "user") {
			end = i;
			break;
		}
	}
	return messages.slice(start, end);
}
