/**
 * Agent-mediated transfer, and its reversal (#279) — the pure half.
 *
 * ── Where a transfer comes from, and why it can only come from there
 *
 * An agent moves you by resolving a destination inside a chat turn and returning it on the
 * RESPONSE to that turn — the one the browser is already awaiting. `parseChatTransfer` is the
 * only reader of that field in the console, and it is called from exactly one place: the awaited
 * `POST /v1/instances/:id/chat`. Nothing polls for a transfer, nothing subscribes to one, and
 * there is no path from the message list, the notification list or a socket to a switch.
 *
 * That is the security property, and it is structural rather than enforced: a response exists
 * only because the user just spoke, so this channel physically cannot deliver a move nobody asked
 * for. It is also idempotent for free — a response is consumed once, so a reload cannot replay a
 * transfer the way a directive sitting in the transcript would.
 *
 * What the channel does NOT bound is intent within a turn: the user spoke, so a response exists,
 * and an agent could still misread "what does the FWS coder think?" as "take me there". Two
 * things cover that, and both are why they exist: the arrival is ANNOUNCED by name and cannot be
 * silenced, and "go back" ships in the same change.
 *
 * ── What "go back" does not undo
 *
 * It moves you. It does not remove anything you said while you were there. The destination's
 * transcript, the memory its summariser extracted from it, and its activity log all keep what
 * happened — the platform deletes a turn's messages but deliberately never the facts derived
 * from them, because a summary is an aggregate over twenty messages and cannot be un-mixed. So
 * the spoken line promises a MOVE and nothing more; over-promising here would be worse than
 * saying nothing, because a user who believes a stray sentence was withdrawn will not go and
 * clear it.
 */

import type { RosterEntry } from "./nextAgent";

/** Where an agent has handed the conversation, as it arrives on the chat response. */
export interface ChatTransfer {
	instanceId: string;
	name: string;
	/** The handing agent's reason, spoken on arrival. May be empty — the destination is the part
	 *  that cannot be dropped. */
	note: string;
}

/**
 * Read a destination off a chat response, or `null`.
 *
 * Validated rather than trusted even though the server built it: a switch navigates the app, and
 * a half-formed field would navigate it to `/instances/undefined/chat` — a dead route with the
 * mic reopening into nothing, which is a worse outcome than not moving at all.
 */
export function parseChatTransfer(data: unknown): ChatTransfer | null {
	if (!data || typeof data !== "object") return null;
	const t = (data as { transfer?: unknown }).transfer;
	if (!t || typeof t !== "object") return null;
	const { instanceId, name, note } = t as { instanceId?: unknown; name?: unknown; note?: unknown };
	if (typeof instanceId !== "string" || !instanceId.trim()) return null;
	if (typeof name !== "string" || !name.trim()) return null;
	return { instanceId: instanceId.trim(), name: name.trim(), note: typeof note === "string" ? note.trim() : "" };
}

/**
 * Resolve "go back" — the agent you were with before this one.
 *
 * Deliberately NOT `pickNextConversation`: that one only returns you to `lastEngagedId` when that
 * agent has an unread notification, and being transferred AWAY from an agent does not raise one.
 * Routing "go back" through it would silently do nothing, or take you to a third agent that
 * happened to be asking for you — both of which are worse than saying there is nowhere to go.
 *
 * The roster is required, not decorative: it supplies the NAME for the announcement, and it is
 * what stops a move to an instance that has since been cancelled or unsubscribed.
 */
export function resolveGoBack(input: {
	roster: RosterEntry[] | null | undefined;
	lastEngagedId?: string | null;
	/** The agent you are with now — never a destination. */
	currentId?: string | null;
}): { instanceId: string; name: string } | null {
	const id = (input.lastEngagedId ?? "").trim();
	if (!id || id === input.currentId) return null;
	const hit = (input.roster ?? []).find((r) => r.id === id);
	return hit ? { instanceId: hit.id, name: hit.name } : null;
}

/**
 * What arriving BACK says, as the `reason` half of the announcement.
 *
 * The second sentence is the honest one and is not padding: the user's most likely worry, having
 * been moved somewhere they did not choose, is what their last sentence did over there. Saying
 * "nothing was changed" would be a lie the moment they spoke a word to it.
 */
export function backFromLine(leavingName: string): string {
	const name = leavingName.trim();
	return name ? `Back from ${name}. Anything you said there stays there.` : "Back where you were.";
}

/** …and what to say when there is nowhere to return to. Staying put is the answer; saying so is
 *  what stops it looking like the command was not heard. */
export function noWayBackLine(currentName?: string): string {
	const name = (currentName ?? "").trim();
	return name ? `There's nowhere to go back to. Still with ${name}.` : "There's nowhere to go back to.";
}
