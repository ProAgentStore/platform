import { fitPage } from "../wire-budget.js";

/**
 * The `coding_loop_status` listing, fitted to one response (#898): measured live at 135,799 chars,
 * and before that silently the newest 50. The API pages by `offset` and reports `total`; this fits
 * as many of its rows as the budget allows and continues from the first one that did not fit.
 */
export function loopRunsPage(data: unknown): string {
	const d = data as { runs?: unknown[]; total?: number; offset?: number; nextOffset?: number | null } | null;
	if (!d || !Array.isArray(d.runs)) return JSON.stringify(data);
	const { runs, total, offset = 0, nextOffset: _api, ...head } = d;
	const of = typeof total === "number" ? total : offset + runs.length;
	return fitPage({
		rows: runs,
		build: (page, meta) => {
			const end = offset + meta.count;
			return { ...head, runs: page, page: { offset, count: meta.count, of, nextOffset: end < of ? end : null, hasMore: end < of, ...(meta.note ? { note: meta.note } : {}) } };
		},
	}).text;
}
