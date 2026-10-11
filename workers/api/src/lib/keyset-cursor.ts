/**
 * A keyset cursor over a newest-first listing ordered by `(timestamp DESC, id DESC)` (#1017).
 *
 * OFFSET paging counts rows from the head of the listing, so a row inserted ahead of the reader (a new
 * receipt, a new run, a new queue entry — the normal state of a busy instance) shifts every later page
 * by one and repeats a row; a row deleted ahead of it skips one. A keyset cursor names the last row the
 * reader SAW, and the next page is "strictly older than that row", which no insert above it or delete
 * anywhere can move: a newer row is not in the remaining range, an older row inserted later appears in
 * its place, and a deleted row is simply absent. Ties on the timestamp are broken by the id, which is
 * unique, so the order is total.
 *
 * The cursor is `<timestamp>:<id>`. Callers must treat it as opaque and pass back exactly what a page
 * returned; it is readable only so a person debugging a page can see where it points.
 */
import { HttpError } from "./auth.js";

export interface Keyset {
	at: number;
	id: string;
}

export function keysetCursor(at: number, id: string): string {
	return `${at}:${id}`;
}

/** The cursor a previous page returned, or null when `raw` is not one. Ids are this platform's own. */
export function parseKeysetCursor(raw: string | undefined | null): Keyset | null {
	const m = /^(\d{1,16}):([A-Za-z0-9_.-]{1,200})$/.exec(raw ?? "");
	return m ? { at: Number(m[1]), id: m[2] } : null;
}

/** A route's cursor query parameter: absent is null, malformed is a 400 rather than a silent first page. */
export function cursorParam(raw: string | undefined, name: string): Keyset | null {
	if (raw === undefined || raw === "") return null;
	const k = parseKeysetCursor(raw);
	if (!k) throw new HttpError(400, `${name} must be the ${name === "starts_cursor" ? "startsNextCursor" : "nextCursor"} of a previous page`);
	return k;
}

/** `WHERE` fragment for "strictly older than the cursor" under `ORDER BY at DESC, id DESC`. */
export function olderThan(atCol: string, idCol: string, first: number): string {
	return `(${atCol} < ?${first} OR (${atCol} = ?${first} AND ${idCol} < ?${first + 1}))`;
}
