/**
 * Paging over an agent's stored chat transcript (#428).
 *
 * ── The defect this exists to make impossible
 *
 * "Load older messages" returned the NEWEST page again, forever. Three independent defects had to
 * line up for that, and each on its own would have broken the feature:
 *
 *   1. the console sent `oldest.id` — a UUID — as the `before` cursor;
 *   2. the API route rebuilt the DO query string from scratch with only `limit`, dropping it;
 *   3. the DO never read `before` at all, and `getRecentMessages` was unconditionally "the newest N".
 *
 * Defect 1 is the interesting one: the storage key is `msg:${createdAt}:${id}`, so the ordering
 * dimension is `createdAt`. A UUID has no ordering relationship to that key, so even a perfect
 * server could not have sought with it. That is what this module is for — the key format lives in
 * ONE place, the cursor IS that key, and the client no longer needs to know either. A cursor the
 * client mints from a field it picked can drift again; a cursor the server hands back cannot.
 *
 * ── Why an unrecognised cursor is an error rather than a fallback
 *
 * The old behaviour on an unusable cursor was to silently return the newest page. That is precisely
 * how this stayed invisible: the response was well-formed, the button kept working, and the thread
 * quietly filled with duplicates. A cursor that cannot be honoured now fails loudly, because "I
 * could not seek there" and "there is nothing older" must not look alike.
 *
 * Pure and unit-tested here; the DO owns the storage and the fabrication stamping (#406), which
 * applies per message and therefore composes with any page this produces.
 */

/** Every stored chat message key starts with this. The ONE definition of the key format. */
export const MESSAGE_KEY_PREFIX = "msg:";

/** The DO storage key for a message: prefix, then the ordering dimension, then the tiebreak. */
export function messageStorageKey(msg: { createdAt: string; id: string }): string {
	return `${MESSAGE_KEY_PREFIX}${msg.createdAt}:${msg.id}`;
}

/** A cursor is either absent, a bound we can seek to, or something we refuse to guess about. */
export type CursorResolution =
	| { kind: "none" }
	| { kind: "end"; end: string }
	| { kind: "invalid"; reason: string };

/** ISO-8601 as `new Date().toISOString()` writes it — the only bare form a cursor may take. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

/**
 * Turn whatever the caller sent as `before` into an exclusive upper bound on the key range.
 *
 * Accepts the opaque cursor this module emits (a full storage key), and — for callers that only
 * ever had a timestamp, such as a script reading the API by hand — a bare ISO `createdAt`. A bare
 * timestamp bounds at `msg:${ts}`, which sorts BELOW every `msg:${ts}:${id}`, so a message written
 * in that exact millisecond is excluded rather than repeated. Anything else, including a UUID, is
 * refused: it names no position in the ordering, so honouring it would mean returning some other
 * page and calling it the one that was asked for.
 */
export function resolveCursor(before: string | null | undefined): CursorResolution {
	const raw = (before ?? "").trim();
	if (!raw) return { kind: "none" };
	if (raw.startsWith(MESSAGE_KEY_PREFIX)) return { kind: "end", end: raw };
	if (ISO_TIMESTAMP.test(raw)) return { kind: "end", end: `${MESSAGE_KEY_PREFIX}${raw}` };
	return {
		kind: "invalid",
		reason:
			"Unrecognised `before` cursor. Pass the `nextCursor` from the previous page (or an ISO createdAt); a message id cannot be used — it has no ordering.",
	};
}

/**
 * The storage `list()` options for one page, newest-first.
 *
 * `end` is EXCLUSIVE, which is exactly the "strictly older than the cursor" semantic wanted, and it
 * is paired with an explicit inclusive `start` at the prefix so the range is bounded on both sides
 * by two independent, separately-assertable bounds rather than by a prefix filter interacting with
 * one of them. `limit + 1` is the probe: one row past the page is how "is there anything older"
 * becomes a fact instead of the `older.length >= PAGE` guess that was wrong in this exact failure.
 */
export function messageListOptions(
	cursor: CursorResolution,
	limit: number,
): { start?: string; end?: string; prefix?: string; reverse: true; limit: number } {
	const probe = { reverse: true as const, limit: limit + 1 };
	return cursor.kind === "end"
		? { start: MESSAGE_KEY_PREFIX, end: cursor.end, ...probe }
		: { prefix: MESSAGE_KEY_PREFIX, ...probe };
}

export interface MessagePage<T> {
	/** Oldest-first, the order the transcript renders in. */
	messages: T[];
	/** The cursor for the NEXT (older) page, or null when this page reaches the start. */
	nextCursor: string | null;
	/** Whether anything older exists. Measured, not inferred from the page length. */
	hasMore: boolean;
}

/**
 * Assemble one page from a newest-first `list()` result of at most `limit + 1` entries.
 *
 * The extra entry is dropped, never returned: it exists only to answer `hasMore`. `nextCursor` is
 * the key of the OLDEST message actually returned, so the next request's exclusive `end` lands
 * immediately below it — no overlap (a visible duplicate) and no gap (a silent loss).
 */
export function assembleMessagePage<T>(newestFirst: Array<[string, T]>, limit: number): MessagePage<T> {
	const size = Math.max(0, limit);
	const hasMore = newestFirst.length > size;
	const page = hasMore ? newestFirst.slice(0, size) : newestFirst;
	const oldest = page.length > 0 ? page[page.length - 1][0] : null;
	return {
		messages: page.map(([, value]) => value).reverse(),
		nextCursor: hasMore ? oldest : null,
		hasMore,
	};
}
