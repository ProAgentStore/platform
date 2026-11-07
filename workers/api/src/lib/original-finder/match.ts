/**
 * The Original Finder's match rule and what it writes to a lead (#1608). Pure: the Scout's DO runs
 * {@link planOriginalFinding} serialized with every other write to its leads, exactly as it does for a browser
 * verification, so whatever the Finder's dispatcher sent is validated again where the lead lives.
 *
 * A candidate is the lead's ORIGINAL only when ALL of these hold (strict; anything else is `not_found`):
 *   - https, on a host that is not a job board or aggregator, live, with a description to publish (`acceptOriginal`,
 *     the rule the Scout's own Apply-link path uses);
 *   - the SAME title once normalised - not "contains": "Software Engineer" is not "Senior Software Engineer";
 *   - a location compatible with the lead's;
 *   - posted within the lead's window, when the page states a date.
 */
import { type OriginalCandidate, acceptOriginal, cleanVerifiedName, jobLeadStatus, squashName } from "../job-lead-triage.js";
import type { CollectionRecord } from "../../agent-storage-types.js";
import { clipMarked } from "../clip-marked.js";

/** Why a Finder run is not the original, beyond the reasons `acceptOriginal` already gives. */
export type FinderRejection = "job_board" | "title_mismatch" | "not_live" | "not_https" | "no_description" | "location_mismatch" | "outside_window";

/** The Finder's candidate: `acceptOriginal`'s, plus the two facts only this stricter rule reads. */
export type FinderCandidate = Extract<OriginalCandidate, { kind: "external" }> & { location?: string; posted?: string };

/** The originals' posting date may differ from the lead's by this much either way. */
export const POSTED_WINDOW_MS = 30 * 24 * 60 * 60_000;

/** A title for comparison: no bracketed notes, nothing after a " - ", " | " separator (a place or a company), punctuation flattened. */
export function normaliseTitle(raw: string | null | undefined): string {
	const head = (raw ?? "").replace(/\([^)]*\)|\[[^\]]*\]/g, " ").split(/\s[-–|]\s/)[0] ?? "";
	return squashName(head);
}

const STATES: Array<[string, string]> = [["vic", "victoria"], ["nsw", "new south wales"], ["qld", "queensland"], ["wa", "western australia"], ["sa", "south australia"], ["tas", "tasmania"], ["act", "australian capital territory"], ["nt", "northern territory"]];
const NOISE = new Set(["au", "aus", "australia", "and", "the", "area", "region", "greater", "city", "of"]);

/** The place words of a location, with every Australian state spelled both ways. */
function placeWords(location: string): Set<string> {
	const words = new Set(squashName(location).split(" ").filter((w) => w.length >= 2 && !NOISE.has(w)));
	const flat = ` ${squashName(location)} `;
	for (const [abbr, full] of STATES) if (words.has(abbr) || flat.includes(` ${full} `)) { words.add(abbr); words.add(full.replace(/ /g, "_")); }
	return words;
}

/** Do the two locations share a place? A page that states none cannot be confirmed against a lead that has one. */
export function locationCompatible(lead: string | null | undefined, original: string | null | undefined): boolean {
	const a = (lead ?? "").trim();
	const b = (original ?? "").trim();
	if (!a) return true; // the lead never said: nothing to contradict
	if (!b) return false;
	const flat = squashName(b);
	if (/\b(remote|anywhere in australia|australia wide|nationwide)\b/.test(flat)) return true;
	const mine = placeWords(a);
	return [...placeWords(b)].some((w) => mine.has(w));
}

/** Is the original's posting date within {@link POSTED_WINDOW_MS} of the lead's? A page with no date is not refuted by one. */
export function withinWindow(leadDate: string | null | undefined, originalPosted: string | null | undefined, fallbackDate?: string | null): boolean {
	const posted = Date.parse(originalPosted ?? "");
	if (!Number.isFinite(posted)) return true;
	const anchor = [leadDate, fallbackDate].map((d) => Date.parse(d ?? "")).find((t) => Number.isFinite(t));
	if (anchor === undefined) return true;
	return Math.abs(posted - anchor) <= POSTED_WINDOW_MS;
}

export type FinderAcceptance = { ok: true; url: string; host: string; description: string } | { ok: false; rejected: FinderRejection };

export function acceptFinderCandidate(candidate: FinderCandidate | null | undefined, lead: { title?: string | null; location?: string | null; postedDate?: string | null; verifiedAt?: string | null }): FinderAcceptance {
	const base = acceptOriginal(candidate, lead.title);
	if (!base) return { ok: false, rejected: "not_https" };
	if (base.original !== "external") return { ok: false, rejected: base.rejected ?? "not_https" };
	const title = normaliseTitle(cleanVerifiedName(candidate?.title) ?? "");
	if (!title || title !== normaliseTitle(lead.title)) return { ok: false, rejected: "title_mismatch" };
	if (!locationCompatible(lead.location, candidate?.location)) return { ok: false, rejected: "location_mismatch" };
	if (!withinWindow(lead.postedDate, candidate?.posted, lead.verifiedAt)) return { ok: false, rejected: "outside_window" };
	return { ok: true, url: base.url, host: base.host, description: base.description };
}

/** The outcomes the Finder records against a lead. */
export const NO_ORIGINAL_REASONS = ["not_found", "out_of_scope"] as const;
export type NoOriginalReason = (typeof NO_ORIGINAL_REASONS)[number];

export type OriginalFindingInput =
	| { found: FinderCandidate; searched?: string }
	| { none: NoOriginalReason; searched?: string };

export type OriginalFindingPlan =
	| { applied: true; outcome: "found" | "not_found" | "out_of_scope"; rejected?: FinderRejection; patch: Record<string, unknown> }
	| { applied: false; outcome: "superseded"; why: "lead_closed" | "has_original" };

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const clip = (s: string, n: number) => clipMarked(s, n, { within: true });

/**
 * What to write to a lead for one Finder result. Never touches `status` or `lifecycle_version` (the owner's triage
 * and every Apply event identity stay as they were) - `verification` only. A lead the owner moved on from, or that
 * already has an original, is left alone.
 */
export function planOriginalFinding(rec: CollectionRecord, input: OriginalFindingInput, deps: { now?: string } = {}): OriginalFindingPlan {
	const now = deps.now ?? new Date().toISOString();
	const status = jobLeadStatus(rec.data);
	if (status === "archived" || status === "skipped" || status === "unverifiable") return { applied: false, outcome: "superseded", why: "lead_closed" };
	const prior = record(rec.data.verification);
	if (prior.original === "external") return { applied: false, outcome: "superseded", why: "has_original" };
	const searched = "searched" in input && input.searched ? clip(input.searched.replace(/\s+/g, " ").trim(), 300) : "";
	const none = (reason: NoOriginalReason, rejected?: FinderRejection) => ({
		applied: true as const,
		outcome: reason,
		...(rejected ? { rejected } : {}),
		patch: { verification: { ...prior, no_original_reason: reason, ...(searched || rejected ? { original_searched: clip([searched, rejected ? `a candidate was refused: ${rejected}` : ""].filter(Boolean).join("; "), 400) } : {}), original_finder_at: now } },
	});
	if ("none" in input) return none(input.none);
	const accepted = acceptFinderCandidate(input.found, {
		title: text(rec.data.title) || null,
		location: text(rec.data.location) || null,
		postedDate: text(rec.data.posted_date) || null,
		verifiedAt: text(prior.checked_at) || null,
	});
	if (!accepted.ok) return none("not_found", accepted.rejected);
	const { no_original_reason: _r, original_searched: _s, original_rejected: _j, ...rest } = prior;
	return {
		applied: true,
		outcome: "found",
		patch: { verification: { ...rest, original: "external", original_url: accepted.url, original_host: accepted.host, original_description: accepted.description, original_source: "original_finder", original_finder_at: now } },
	};
}
