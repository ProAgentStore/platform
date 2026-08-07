// Reading `coding_timeline` as a Co-pilot conversation.
//
// `GET …/sessions/:id/timeline` returns `{ chat }`, or `{ chat, timeline }` with `?full=1`. Five
// of the row types are things a human said or was told; the rest (brain decisions, commands,
// outcomes, terminal snapshots) are machinery. Turning the former into chat bubbles was written
// out TWICE, verbatim — once in the 4.5s poll, once when a session opens — including the nested
// ternary that assigns a role. Two copies of a mapping is how the two views of one conversation
// start disagreeing about what a `system` row is.
//
// Kept pure and separate so a test can state the mapping as a table instead of a fetch stub.

import type { TimelineEntry } from "./types";

/** What the timeline routes answer with. `timeline` only exists on a `?full=1` read. */
export interface TimelinePayload {
	chat?: TimelineEntry[];
	timeline?: TimelineEntry[];
}

export interface ChatMessage {
	role: "user" | "assistant" | "system";
	content: string;
	time?: string;
	audioKey?: string;
}

/**
 * `chat` when it is there, else `timeline`.
 *
 * Note what this means for a `?full=1` read, which returns BOTH: the typed timeline half is
 * unreachable through this function whenever the session has any conversation at all. `full=1`
 * buys the terminal snapshot below, not a richer transcript.
 */
function rows(payload: TimelinePayload): TimelineEntry[] {
	return payload.chat || payload.timeline || [];
}

/** The row types that are part of the conversation, mapped to who is speaking. */
const ROLE: Record<string, ChatMessage["role"]> = {
	chat_user: "user",
	// A command the user drove the engine with is something the USER said, even though the row
	// type is named for the mechanism.
	command: "user",
	chat_assistant: "assistant",
	chat_system: "system",
	system: "system",
};

/** The conversation, in order, as the Co-pilot thread renders it. Everything else is dropped. */
export function chatMessagesFrom(payload: TimelinePayload): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (const e of rows(payload)) {
		const role = e.type ? ROLE[e.type] : undefined;
		if (!role) continue;
		// `content` is what the store writes; `text` is the older column name. Neither is
		// guaranteed, and an empty bubble is better than `undefined` reaching the renderer.
		out.push({ role, content: e.content || e.text || "", time: e.createdAt, audioKey: e.audioKey });
	}
	return out;
}

/**
 * The last persisted terminal snapshot — the Terminal view's fallback when there is no live pane
 * (ended session, detached runner), so finishing a run does not blank the screen.
 *
 * Reads `timeline` ONLY: terminal rows are not part of `chat`, so this is empty unless the caller
 * asked for `?full=1`. Empty string, not null — the caller only ever tests it for truthiness.
 */
export function lastTerminalSnapshot(payload: TimelinePayload): string {
	const terminals = (payload.timeline || []).filter((e) => e.type === "terminal");
	const last = terminals[terminals.length - 1];
	return (last?.content || last?.text || "").trim();
}

/**
 * What the ⧉ button puts on the clipboard: the tail of the conversation, flattened.
 *
 * A tail, not the whole thing — the history is kept server-side and what a person pastes into a
 * bug report is the recent context.
 */
export function timelineExcerpt(payload: TimelinePayload, limit = 10) {
	return rows(payload)
		.slice(-limit)
		.map((e) => ({ type: e.type, role: e.role, content: e.content || e.text || "", seq: e.seq }));
}
