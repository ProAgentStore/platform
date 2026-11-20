/**
 * The "Needs you" inbox view-model (#1640): the URL is the state, the API does the filtering.
 *
 * Filters and sort live in the query string so a filtered view survives reload and can be shared; this module
 * parses them (ignoring anything it does not know), turns them back into the API query, and holds the labels
 * and time wording the page shows. Pure, so it is tested without a DOM.
 */

export const INBOX_KINDS = ["secure_input", "website_access", "permission", "takeover", "mcp_input", "coder_question", "approval", "task", "application", "run_parked"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];
export const INBOX_URGENCIES = ["blocking", "normal", "low"] as const;
export type InboxUrgency = (typeof INBOX_URGENCIES)[number];
export const INBOX_SORTS = ["urgency", "newest", "oldest", "expiring"] as const;
export type InboxSort = (typeof INBOX_SORTS)[number];

export interface InboxItem {
	id: string;
	kind: InboxKind;
	instanceId: string | null;
	instanceName: string | null;
	agentSlug: string | null;
	title: string;
	summary: string;
	createdAt: string;
	expiresAt: string | null;
	urgency: InboxUrgency;
	route: string;
}

export interface InboxSourceStatus {
	kind: InboxKind;
	ok: boolean;
	truncated?: boolean;
	error?: string;
}

export interface InboxResponse {
	asOf: number;
	items: InboxItem[];
	total: number;
	counts: {
		total: number;
		byKind: Partial<Record<InboxKind, number>>;
		byInstance: Array<{ instanceId: string; name: string | null; count: number }>;
		byAgent: Array<{ slug: string; count: number }>;
		byUrgency: Partial<Record<InboxUrgency, number>>;
	};
	sources: InboxSourceStatus[];
	complete: boolean;
}

/** `GET /v1/inbox/count`: `partial` means a source could not be counted, so `count` is a lower bound. */
export interface InboxCountResponse {
	count: number;
	partial: boolean;
}

export interface InboxFilters {
	kinds: InboxKind[];
	instances: string[];
	agent: string | null;
	urgency: InboxUrgency | null;
	sort: InboxSort;
}

export const KIND_LABEL: Record<InboxKind, string> = {
	secure_input: "Secret to enter",
	website_access: "Website access",
	permission: "Permission",
	takeover: "Browser takeover",
	mcp_input: "Tool input",
	coder_question: "Coder question",
	approval: "Approval",
	task: "Task",
	application: "Application review",
	run_parked: "Run waiting",
};

export const SORT_LABEL: Record<InboxSort, string> = { urgency: "Most urgent", newest: "Newest", oldest: "Oldest", expiring: "Expiring soon" };

const isIn = <T extends string>(all: readonly T[], v: string): v is T => (all as readonly string[]).includes(v);

/** `?kind=a&kind=b&instance=…&agent=…&urgency=…&sort=…` → filters. Unknown values are dropped, not trusted. */
export function parseFilters(search: URLSearchParams): InboxFilters {
	const urgency = search.get("urgency") ?? "";
	const sort = search.get("sort") ?? "";
	return {
		kinds: search.getAll("kind").filter((k): k is InboxKind => isIn(INBOX_KINDS, k)),
		instances: search.getAll("instance").filter(Boolean),
		agent: search.get("agent") || null,
		urgency: isIn(INBOX_URGENCIES, urgency) ? urgency : null,
		sort: isIn(INBOX_SORTS, sort) ? sort : "urgency",
	};
}

/** Filters → the query string for both the URL and `GET /v1/inbox` (the default sort is left out). */
export function filtersToQuery(f: InboxFilters): URLSearchParams {
	const q = new URLSearchParams();
	for (const k of f.kinds) q.append("kind", k);
	for (const i of f.instances) q.append("instance", i);
	if (f.agent) q.set("agent", f.agent);
	if (f.urgency) q.set("urgency", f.urgency);
	if (f.sort !== "urgency") q.set("sort", f.sort);
	return q;
}

/** Add the value to a multi-select dimension, or remove it when it is already chosen. */
export function toggled<T extends string>(list: readonly T[], value: T): T[] {
	return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** "3h" / "2d" / "just now" — compact, since it sits in a phone-width row. */
export function ageLabel(iso: string, now: number): string {
	const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86400) return `${Math.floor(s / 3600)}h`;
	return `${Math.floor(s / 86400)}d`;
}

/** "gives up in 12m", or null when the item never expires. */
export function expiryLabel(iso: string | null, now: number): string | null {
	if (!iso) return null;
	const s = Math.round((Date.parse(iso) - now) / 1000);
	if (s <= 0) return "expiring now";
	if (s < 3600) return `gives up in ${Math.max(1, Math.floor(s / 60))}m`;
	if (s < 86400) return `gives up in ${Math.floor(s / 3600)}h`;
	return `gives up in ${Math.floor(s / 86400)}d`;
}

/** Sources that could not be read, named for the banner: an empty list is only "nothing waiting" when this is empty. */
export function failedSources(res: Pick<InboxResponse, "sources">): InboxKind[] {
	return res.sources.filter((s) => !s.ok).map((s) => s.kind);
}
export function truncatedSources(res: Pick<InboxResponse, "sources">): InboxKind[] {
	return res.sources.filter((s) => s.ok && s.truncated).map((s) => s.kind);
}
