// The Terminal view's scrollback, and the sentence it shows when there is nothing to scroll (#432).
//
// Two separate defects lived behind one placeholder:
//
//  1. There was no scrollback. `?full=1` fetched every persisted snapshot and the client kept the
//     last one, so the view was always exactly one pane — "load older" had nothing to load because
//     nothing had ever been kept. The rows exist and are `seq`-ordered; the fix is to page them
//     and JOIN them, which is what `stitchSnapshots` is for.
//
//  2. `(waiting for output...)` was shown for four different states — runner offline, history not
//     loaded yet, engine busy with nothing persisted, and genuinely no output. One sentence for
//     four causes is why the screen reads as broken rather than as waiting.
//
// Pure so both can be stated as tables in a test rather than driven through a poll.

import type { TimelineEntry } from "./types";

/** How many characters of the previous text are used to find where the next snapshot overlaps it. */
const ANCHOR = 96;

/** Drawn between two snapshots that do not overlap at all — a restart, or a pane that rotated. */
export const SNAPSHOT_GAP = "\n… earlier output not captured …\n";

/**
 * Append `next` to `acc`, dropping the part of it `acc` already ends with.
 *
 * A snapshot is the TAIL of the session's whole transcript, so consecutive rows overlap almost
 * entirely: snapshot N+1 is usually snapshot N plus a few new lines. Concatenating them would
 * render the same output five times over and make the scrollback worse than the single pane it
 * replaces. This is therefore not a nicety — it is what makes paging the rows usable at all.
 *
 * Anchored on the last {@link ANCHOR} characters rather than searching every overlap length: the
 * naive longest-common-overlap search is quadratic over 8000-char strings and this runs on every
 * poll. `lastIndexOf` finds the most recent occurrence, which is the right one when a short
 * anchor happens to repeat earlier in the buffer.
 */
export function appendSnapshot(acc: string, next: string): string {
	if (!next) return acc;
	if (!acc) return next;
	// Already a suffix (or the identical pane) — nothing new to show.
	if (acc.endsWith(next)) return acc;
	const anchor = acc.slice(-ANCHOR);
	const at = next.lastIndexOf(anchor);
	if (at >= 0) {
		const tail = next.slice(at + anchor.length);
		return tail ? acc + tail : acc;
	}
	// `next` may instead CONTAIN everything we have (the very first live pane after a short
	// snapshot), in which case it supersedes rather than extends.
	if (acc.length <= ANCHOR && next.includes(acc)) return next;
	return acc + SNAPSHOT_GAP + next;
}

/** Join a page of snapshots (oldest→newest) into one continuous scrollback. */
export function stitchSnapshots(entries: Array<TimelineEntry | string>): string {
	let out = "";
	for (const e of entries) {
		const text = typeof e === "string" ? e : e.content || e.text || "";
		out = appendSnapshot(out, text);
	}
	return out;
}

/** What `GET …/timeline?terminal=1[&before=<seq>]` answers with. */
export interface TerminalPage {
	terminal?: TimelineEntry[];
	/** Are there snapshots older than this page? Drives the "Load older" control. */
	hasMore?: boolean;
	/** The `seq` of the OLDEST row in this page — the cursor for the next page back. */
	oldestSeq?: number | null;
}

export interface TerminalState {
	/** Is a machine running `pags up` reachable for this instance? From `/capture`. */
	runnerConnected?: boolean;
	/** Does the runner still hold this session? From `/capture`. */
	alive?: boolean;
	/** `idle` | `thinking` | `responding`. From `/capture`. */
	runState?: string;
	/** True between opening a session and the persisted snapshots arriving. */
	loadingHistory?: boolean;
}

/**
 * Why the terminal is empty, in the words the owner can act on.
 *
 * Ordered by what the person can DO about it, not by how the poll discovers it. "Runner offline"
 * outranks everything because nothing else can be true until it is fixed, and it is the only one
 * with a command attached.
 */
export function terminalPlaceholder(s: TerminalState): string {
	if (s.runnerConnected === false) return "Runner offline — run `pags up` on the machine with this repo, and output will appear here.";
	if (s.loadingHistory) return "Loading saved output…";
	if (s.alive === false) return "This session isn't running on the runner — reopen it, or start a new one.";
	if (s.runState && s.runState !== "idle") return "The engine is working — nothing has been captured yet. The first snapshot lands shortly.";
	return "No output yet — send the engine an instruction to get started.";
}
