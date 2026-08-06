/**
 * The predicate shared by the operator list pages (#280).
 *
 * `/v1/admin/agents` and `/v1/admin/instances` each return a page AND a `total` computed
 * from the same server-side WHERE clause. That only stays true if the client sends ONE
 * predicate — so the fields are declared once, here, and both the query string and the
 * page-reset key are derived from that single declaration.
 *
 * The bug class this closes is a quiet one: add a filter, wire it into the query, forget
 * the reset. The narrowed result set keeps an offset it no longer has rows for, the table
 * renders empty, and the operator reads "no matches" for a filter that matched plenty.
 */

export const LIST_FILTER_FIELDS = ["search", "agent", "owner", "visibility", "status"] as const;
export type ListFilterField = (typeof LIST_FILTER_FIELDS)[number];
export type ListFilters = Partial<Record<ListFilterField, string>>;

export const LIST_PAGE = 50;

/** Trimmed values in a fixed field order — the shape both derivations read. */
function normalize(filters: ListFilters): Array<[ListFilterField, string]> {
	return LIST_FILTER_FIELDS.map((f) => [f, (filters[f] ?? "").trim()] as [ListFilterField, string]).filter(([, v]) => v !== "");
}

/**
 * The dependency key for "reset to page 1". Every filter field is in it by construction,
 * so a new field cannot be added to the query and left out of the reset.
 */
export function predicateKey(filters: ListFilters): string {
	return JSON.stringify(normalize(filters));
}

/** Is anything actually narrowing the list? Drives the Clear button and the "N matching" count. */
export function isFiltered(filters: ListFilters): boolean {
	return normalize(filters).length > 0;
}

/**
 * The filter fields alone, for keeping the address bar in step so a narrowed view is
 * linkable between operators. Derived from the same declaration as the request query —
 * a URL that carries a different predicate from the fetch is a shared link that shows
 * the recipient something else.
 */
export function predicateParams(filters: ListFilters): URLSearchParams {
	const p = new URLSearchParams();
	for (const [field, value] of normalize(filters)) p.set(field, value);
	return p;
}

/**
 * The request query. Empty and whitespace-only filters are OMITTED, not sent blank — a
 * `search=%20` matches nothing while the UI still looks unfiltered. `offset` is omitted
 * at 0 so the first page has one canonical URL.
 */
export function buildListQuery(filters: ListFilters, offset: number, page: number = LIST_PAGE): string {
	const p = predicateParams(filters);
	p.set("limit", String(page));
	if (offset > 0) p.set("offset", String(offset));
	return p.toString();
}

export interface PagerRange {
	/** A pager over a single page of results is noise. */
	visible: boolean;
	from: number;
	to: number;
	hasPrev: boolean;
	hasNext: boolean;
	prevOffset: number;
	nextOffset: number;
}

/**
 * Prev/next over a server-side total. `hasNext` is computed from the LAST ROW SHOWN, not
 * from the offset, so the final page cannot offer a Next that lands past the end of the
 * result set and renders as "no instances match these filters".
 */
export function pagerRange(total: number, offset: number, page: number = LIST_PAGE): PagerRange {
	const from = total === 0 ? 0 : offset + 1;
	const to = Math.min(offset + page, total);
	return {
		visible: total > page,
		from,
		to,
		hasPrev: offset > 0,
		hasNext: to < total,
		prevOffset: Math.max(0, offset - page),
		nextOffset: offset + page,
	};
}
