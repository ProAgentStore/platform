import { fitPage } from "../wire-budget.js";

/**
 * The `coding_loop_status` listing, fitted to one response (#898): measured live at 135,799 chars,
 * and before that silently the newest 50. The API pages by `offset` and reports `total`; this fits
 * as many of its rows as the budget allows and continues from the first one that did not fit.
 */
export function loopRunsPage(data: unknown): string {
	const d = data as { runs?: unknown[]; total?: number; offset?: number | null; nextOffset?: number | null; nextCursor?: string | null; complete?: boolean } | null;
	if (!d || !Array.isArray(d.runs)) return JSON.stringify(data);
	const { runs, total, offset: rawOffset, nextOffset: _api, nextCursor: apiCursor = null, complete: _complete, ...head } = d;
	// `offset` is null on a keyset page (#1017): the page's place is its cursor, not a count from the head.
	const keyset = rawOffset === null;
	const offset = rawOffset ?? 0;
	const of = typeof total === "number" ? total : offset + runs.length;
	return fitPage({
		rows: runs,
		build: (page, meta) => {
			const end = offset + meta.count;
			// The keyset continuation must name the last run RETURNED: when this page was cut to fit the
			// wire, the API's cursor (its own last row) would skip the runs cut away. The cursor format
			// `<startedAt>:<runId>` is a copy of `workers/api/src/lib/keyset-cursor.ts` (no cross-worker import).
			const lastShown = page[page.length - 1] as { startedAt?: number; runId?: string } | undefined;
			const trimmed = meta.count < runs.length;
			const nextCursor = trimmed && lastShown?.runId && typeof lastShown.startedAt === "number" ? `${lastShown.startedAt}:${lastShown.runId}` : apiCursor;
			const hasMore = keyset ? trimmed || apiCursor !== null : end < of;
			return { ...head, runs: page, page: { offset: keyset ? null : offset, count: meta.count, of, nextOffset: keyset ? null : end < of ? end : null, nextCursor, hasMore, ...(meta.note ? { note: meta.note } : {}) } };
		},
	}).text;
}
