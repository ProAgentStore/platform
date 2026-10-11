// How `coding_session_capture` pages a live pane (#1018). Its own module: `coding-tools.ts` is at its size limit.
//
// The runner keeps the session's last 64 KiB, which JSON-escaped can exceed a calling host's limit, so
// the pane is paged. NEWEST first by default: the reported failure was a first page that began with
// the oldest kept output, so a busy engine read as frozen and old output passed for current activity.
// `before` walks back into older output; `offset` walks forward from a position, as it always has.

import { pageText, pageTextTail } from "./wire-budget.js";

export interface CaptureCursor {
	offset?: number;
	before?: number;
}

/** What the counts in a capture MEAN — `paneChars` and `panePage.of` measure two different things. */
export const PANE_REPRESENTATION =
	"paneChars = everything the engine printed this session; panePage.of = the characters of it the runner still holds (its last 64 KiB, beginning with a [cut: …] line when it dropped older output) — the text these pages are taken from. Positions are within THIS capture: output that arrives between calls shifts them, so read a stable history with coding_terminal (stored snapshots, seq cursor).";

export function capturePane(head: Record<string, unknown>, pane: string, cursor: CaptureCursor, budget?: number): string {
	const body = { ...head, capturedAt: new Date().toISOString(), source: "live" };
	const build = (slice: string, meta: unknown) => ({ ...body, pane: slice, ...(meta ? { panePage: meta, paneRepresentation: PANE_REPRESENTATION } : {}) });
	if (cursor.offset !== undefined && cursor.before === undefined) return pageText({ text: pane, offset: cursor.offset, budget, build }).text;
	return pageTextTail({ text: pane, before: cursor.before, budget, build }).text;
}
