/**
 * `application_trace`'s order and paging (#1107).
 *
 * ── Order
 *
 * The trace joins five sources, and they do not write time the same way: run traces and the audit
 * are ISO (`2026-10-16T01:02:03.000Z`), the outbox's `created_at` is SQLite text (`2026-10-16
 * 01:02:03`). Sorted as STRINGS, a space sorts before `T`, so on the same day every delivery sorted
 * ahead of every run step whatever its real time. Each entry's time is read as UTC (`sqlTimeMs`,
 * either format) and re-stated as ISO, then ordered by that instant.
 *
 * ── Paging
 *
 * A Tailor run keeps up to 200 events and a Runner run 500, and an application can have several of
 * each — past the 64 KiB a calling host accepts. Each entry gets a deterministic id (its source,
 * run, type, time, and a counter among identical ones), and a page is every entry strictly after
 * the cursor `(at, id)` — the #1090 keyset rule — so a page never repeats or skips an entry while a
 * run keeps appending (a new entry is newer than any cursor already issued).
 */
import { encodeHistoryCursor, parseHistoryCursor } from "../history-page.js";
import { sqlTimeMs } from "../sql-time.js";
/** The fields of an `application_trace` entry this module reads — structural, so it imports nothing from `control.ts`. */
interface TraceFields {
	at: string;
	source: string;
	runId: string | null;
	type: string;
}

export type PagedTraceEntry<T extends TraceFields = TraceFields> = T & { id: string };

/** ISO times, a stable id per entry, ordered by instant then id. Pure. */
export function normaliseTraceEntries<T extends TraceFields>(entries: readonly T[]): PagedTraceEntry<T>[] {
	const seen = new Map<string, number>();
	const out = entries.map((e) => {
		const ms = sqlTimeMs(e.at);
		const at = Number.isFinite(ms) ? new Date(ms).toISOString() : e.at;
		const base = `${e.source}|${e.runId ?? ""}|${e.type}|${at}`;
		const n = (seen.get(base) ?? 0) + 1;
		seen.set(base, n);
		return { ...e, at, id: `${base}|${n}` };
	});
	return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const TRACE_PAGE_DEFAULT = 100;
export const TRACE_PAGE_MAX = 500;

/** One page after `cursor`, oldest first. `{error}` for a cursor this trace never issued. */
export function pageTraceEntries<T extends PagedTraceEntry>(entries: readonly T[], cursor: string | undefined, limit: number | undefined): { entries: T[]; hasMore: boolean; nextCursor: string | null; total: number } | { error: string } {
	const c = parseHistoryCursor(cursor ?? "", "string");
	if (c.kind === "invalid") return { error: "cursor is not one this trace returned — pass a reply's nextCursor, or omit it" };
	const n = Math.min(Math.max(Math.trunc(Number(limit) || TRACE_PAGE_DEFAULT), 1), TRACE_PAGE_MAX);
	const after = c.kind === "after" ? entries.filter((e) => e.at > (c.key as string) || (e.at === c.key && e.id > c.id)) : [...entries];
	const page = after.slice(0, n);
	const last = page[page.length - 1];
	const hasMore = after.length > n;
	return { entries: page, hasMore, nextCursor: hasMore && last ? encodeHistoryCursor(last.at, last.id) : null, total: entries.length };
}
