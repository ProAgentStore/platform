/**
 * The Original Finder's console rules (#1616): the settings form, the status line Settings keeps, and the
 * order of the recent-leads panel in Activity → History. Pure, so vitest drives the real thing.
 * The routes are `workers/api/src/routes/instances-original-finder.ts`; this only reads them.
 */
import { needingFirst } from "./activityView";
import type { HistoryLineState } from "./historyLine";

export interface OriginalFinderSettings {
	dailyCap: number;
	roles: string[];
	locations: string[];
	exclude: string[];
}

export interface FinderScope {
	roles: string[];
	locations: string[];
	exclude: string[];
	source: "finder" | "runner" | "none";
}

export interface FinderLead {
	lead_id: string;
	state: string;
	attempts: number;
	next_attempt_at: number | null;
	detail: string | null;
	original_url: string | null;
	updated_at: number;
}

/** `GET /v1/instances/:id/original-finder`. */
export interface OriginalFinderOverview {
	settings: OriginalFinderSettings;
	scope: FinderScope;
	budget: { dailyCap: number; usedToday: number; remaining: number };
	counts: Record<string, number>;
	leads: FinderLead[];
}

/** The line shown under Roles while it is empty: the scope in force, or why there is none. */
export const FOLLOWS_RUNNER_LINE = "Follows your Application Runner's auto-submit roles";

/** One entry per line, as typed; the server trims, lowercases and dedupes. */
export const termsFromText = (text: string): string[] => text.split("\n").map((l) => l.trim()).filter(Boolean);
export const termsToText = (terms: readonly string[]): string => terms.join("\n");

export interface FinderForm {
	dailyCap: string;
	roles: string;
	locations: string;
	exclude: string;
}

export const formFromSettings = (s: OriginalFinderSettings): FinderForm => ({ dailyCap: String(s.dailyCap), roles: termsToText(s.roles), locations: termsToText(s.locations), exclude: termsToText(s.exclude) });

/**
 * Only the fields that changed, so saving the budget sends `{ dailyCap }` and nothing else. A blank or
 * non-numeric budget is sent as typed (`NaN` is not JSON): the server refuses it and says why.
 */
export function patchFromForm(form: FinderForm, saved: OriginalFinderSettings): Partial<OriginalFinderSettings> {
	const patch: Partial<OriginalFinderSettings> = {};
	const cap = form.dailyCap.trim() === "" ? Number.NaN : Number(form.dailyCap);
	if (cap !== saved.dailyCap) patch.dailyCap = Number.isNaN(cap) ? (form.dailyCap as unknown as number) : cap;
	for (const key of ["roles", "locations", "exclude"] as const) {
		const next = termsFromText(form[key]);
		if (next.join("\n") !== saved[key].join("\n")) patch[key] = next;
	}
	return patch;
}

/** Settings' one status line: `<remaining> of <dailyCap> research runs left today · <queued> waiting`, then the shared `· View in Activity`. */
export function finderLine(overview: OriginalFinderOverview): HistoryLineState {
	const { remaining, dailyCap } = overview.budget;
	const queued = overview.counts.queued ?? 0;
	return { status: "ready", text: `${remaining} of ${dailyCap} research runs left today · ${queued} waiting`, tone: "muted" };
}

/** A failed lead is the one a person has to look at. */
export const leadNeedsOwner = (lead: Pick<FinderLead, "state">): boolean => lead.state === "failed";

/** Failed rows first, then the server's order (most recently updated first). Stable. */
export const orderLeads = (leads: readonly FinderLead[]): FinderLead[] => needingFirst(leads, leadNeedsOwner);

/** Counts by state, failed first, then the lifecycle order; states with no leads are left out. */
const STATE_ORDER = ["failed", "queued", "dispatched", "found", "not_found", "out_of_scope", "superseded"];
export function countRows(counts: Record<string, number>): Array<{ state: string; n: number }> {
	const known = (s: string) => (STATE_ORDER.includes(s) ? STATE_ORDER.indexOf(s) : STATE_ORDER.length);
	return Object.entries(counts)
		.filter(([, n]) => n > 0)
		.sort(([a], [b]) => known(a) - known(b))
		.map(([state, n]) => ({ state, n }));
}

/** `original_url` becomes a link only when it is http(s). */
export const safeHref = (url: string | null): string | null => (url && /^https?:\/\//i.test(url) ? url : null);

export const stateLabel = (state: string): string => state.replace(/_/g, " ");
