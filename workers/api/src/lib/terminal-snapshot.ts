/**
 * When `/capture` persists a terminal snapshot (#432).
 *
 * The rule used to be one line — `runState === "idle"` — and its reasoning was sound as far as it
 * went: `/capture` polls every 1.5s per open session, and a read plus a write on each is a lot of
 * D1 for a pane that is not moving. What it optimised was the case where nothing is happening.
 * What it failed was the case where everything is: a session that has been BUSY since it started
 * never reaches the gate, so it has no snapshot at all. That is exactly a Loop run working through
 * forty steps — the output the owner most wants to see was the output never written, and closing
 * the tab left nothing behind.
 *
 * So the gate is now "changed AND (idle OR the last one is old)". Idle behaviour is byte-identical
 * to before, which matters: the end-of-turn snapshot is the one that is worth keeping in full, and
 * it still lands the moment the turn ends. The throttle only ADDS coverage during a run.
 *
 * Pure, and separate from the route, because the two things that can go wrong here are both
 * arithmetic: the interval, and reading SQLite's timestamp.
 */

/**
 * How long a busy session may run without persisting anything.
 *
 * Not measured against a live Loop run — this is an arithmetic bound, and it is stated as one
 * rather than dressed up as a measurement. `/capture` polls at 1.5s while a session is active
 * (`useTieredPolling` in `CodingTab.tsx`), so ~40 polls a minute reach this decision. At 20s a
 * busy session writes at most 3 rows a minute; today it writes roughly one per finished turn. A
 * whole hour of continuous work is therefore bounded at ~180 rows of ≤8000 chars.
 *
 * `coding_timeline` has NO retention policy — rows are deleted only when the session's repo is
 * deleted (`coding-store.ts`) or the chat is cleared, and neither touches `terminal` rows. That
 * gap is real and predates this change; raising write frequency makes it matter sooner, which is
 * why the bound above is written down rather than left to be re-derived.
 */
export const SNAPSHOT_THROTTLE_MS = 20_000;

/**
 * Read `coding_timeline.created_at` as an instant.
 *
 * The column defaults to `datetime('now')`, which is UTC and has NO zone suffix:
 * `"2026-08-09 07:00:00"`. `Date.parse` on that shape treats it as LOCAL time — on a Worker that
 * happens to be UTC, so it looks correct in production and is wrong the moment anything runs
 * anywhere else, including a test machine. The `T` and the `Z` are both added on purpose.
 * A value that already carries a zone (an ISO string written by application code) is left alone.
 */
export function parseTimelineTimestamp(value: string | null | undefined): number | null {
	if (!value) return null;
	const trimmed = value.trim();
	const iso = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(trimmed) ? trimmed.replace(" ", "T") : `${trimmed.replace(" ", "T")}Z`;
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? null : ms;
}

/**
 * Should this poll write the pane to `coding_timeline`?
 *
 * - Nothing to store, or nothing NEW to store → no. The dedup is what stops an idle session
 *   appending an identical row every 1.5s forever.
 * - Changed and the engine has gone idle → yes, immediately. Unchanged from before #432.
 * - Changed while the engine is still working → yes, but at most once every
 *   {@link SNAPSHOT_THROTTLE_MS}.
 *
 * An unparseable or missing timestamp counts as "old". A row we cannot date is one we cannot
 * throttle against, and the failure that matters here is losing a busy session's output, not
 * writing one extra row.
 */
export function shouldPersistSnapshot(args: {
	pane: string;
	lastContent: string | null;
	lastAt: string | null;
	runState: string;
	now: number;
}): boolean {
	const pane = args.pane.trim();
	if (!pane) return false;
	if (pane === (args.lastContent ?? "").trim()) return false;
	if (args.runState === "idle") return true;
	const at = parseTimelineTimestamp(args.lastAt);
	return at === null || args.now - at >= SNAPSHOT_THROTTLE_MS;
}
