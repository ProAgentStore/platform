// Turning a repo's raw timeline into something readable (#257).
//
// The server now answers "what has happened in this repo" across every session it ever had, which
// is the question a user means by "the terminal". What comes back is one flat, seq-ordered stream
// spanning many sessions, so the view needs two decisions, and both are pure:
//
//   1. WHERE the session boundaries are — they become separators, not the unit of retrieval. That
//      inversion is the whole fix: before, a session was how you asked for history, so when the
//      Pilot ended a session at the end of a run (which it does on every run) the history became
//      unreachable while sitting intact in D1.
//   2. WHICH entries belong in a terminal transcript. `coding_timeline` also carries the Co-pilot
//      conversation; replaying that here would be a third copy of the chat.
import type { TimelineEntry } from "./types";

/** Entry types that belong in a terminal transcript — output and actions, not conversation. */
const TRANSCRIPT_TYPES = new Set(["terminal", "command", "brain", "outcome", "system"]);

export interface HistorySection {
	sessionId: string;
	entries: TimelineEntry[];
}

/**
 * Group a repo's timeline into per-session sections, oldest first.
 *
 * Consecutive runs of the same `sessionId` — not a map keyed by it. The stream is already in `seq`
 * order and that order is the truth; grouping by key would silently reorder interleaved sessions
 * (two machines, or a reclaimed session) into an order that never happened.
 */
export function groupRepoHistory(entries: readonly TimelineEntry[]): HistorySection[] {
	const sections: HistorySection[] = [];
	for (const e of entries) {
		if (!TRANSCRIPT_TYPES.has(e.type ?? "")) continue;
		const sessionId = e.sessionId ?? "";
		const last = sections[sections.length - 1];
		if (last && last.sessionId === sessionId) last.entries.push(e);
		else sections.push({ sessionId, entries: [e] });
	}
	return sections;
}

/** The label on a section separator. Short ids: the full uuid is noise the user never types. */
export function sessionLabel(section: HistorySection, index: number): string {
	const when = section.entries[0]?.createdAt;
	const shortId = section.sessionId ? section.sessionId.slice(0, 8) : "unknown";
	return when ? `Session ${index + 1} · ${shortId} · ${when}` : `Session ${index + 1} · ${shortId}`;
}

/**
 * The text of one entry as the transcript should show it.
 *
 * A `command` is the user's own input and reads wrong bare — it looks like output. Prefixed so a
 * reader can tell what the engine said from what was said to it.
 */
export function entryText(entry: TimelineEntry): string {
	const body = entry.content ?? entry.text ?? "";
	if (entry.type === "command") return `$ ${body}`;
	if (entry.type === "outcome") return `── ${body}`;
	if (entry.type === "brain") return `» ${body}`;
	return body;
}
