/**
 * Rules that keep the same job, and non-jobs, from becoming leads (#1606): search-result pages,
 * reposts of a job already held, and the employer of a careers-site lead. Pure — the scan applies
 * them as leads arrive and the repair route applies them to leads already stored.
 */
import { jobProviderOf } from "./provider-redirect.js";

/** A repost is the same company + title + country as a lead seen in this window (the Jobs app's rule). */
export const REPOST_WINDOW_MS = 60 * 24 * 60 * 60_000;

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * Is this a page of search results rather than one posting? SEEK `/jobs…` and `<category>-jobs-in-<place>`
 * pages, Indeed `/jobs?…` and `/q-…-jobs.html` pages. Such a page lists many jobs; it is never a lead.
 */
export function isSearchResultsUrl(rawUrl: string): boolean {
	try {
		const url = new URL(rawUrl);
		const host = url.hostname.toLowerCase();
		const segments = url.pathname.split("/").filter(Boolean);
		const provider = jobProviderOf(host);
		if (provider === "seek") return segments[0] === "jobs" || segments.some((s) => /(^|-)jobs(-in-|$)/i.test(s));
		if (provider === "indeed") return segments[0] === "jobs" || (segments[0] === "m" && segments[1] === "jobs") || segments.some((s) => /^[ql]-.*jobs?\.html$/i.test(s));
		return false;
	} catch {
		return false;
	}
}

const LEGAL_SUFFIX = /\s+(?:pty\.?\s+ltd\.?|pty|ltd\.?|limited|inc\.?|incorporated|llc|group)$/i;
const squash = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

/** "Acme Pty Ltd" and "ACME" are one employer. */
export const normaliseCompany = (v: unknown) => squash(text(v).replace(LEGAL_SUFFIX, ""));
/** "Project Manager - Melbourne, VIC, AU" and "Project Manager" are one title. */
export const normaliseTitle = (v: unknown) => squash(text(v).replace(/\s+-\s+[^-,]+,\s*[A-Z]{2,3},\s*AU$/, ""));

/** company|title|country, or null when the lead lacks a company or title to compare. */
export function repostKey(data: Record<string, unknown>): string | null {
	const company = normaliseCompany(data.company);
	const title = normaliseTitle(data.title);
	return company && title ? `${company}|${title}|AU` : null;
}

const leadTime = (data: Record<string, unknown>) => Date.parse(text(data.gmail_date) || text(data.posted_date));

/**
 * The earliest held lead that this one reposts: same company, title and country, within
 * {@link REPOST_WINDOW_MS}. A lead that is itself a repost is never the original. Null if none, or
 * if either lead has no date to compare.
 */
export function findRepostOf<R extends { id?: string; data?: Record<string, unknown> }>(data: Record<string, unknown>, existing: readonly R[]): R | null {
	const key = repostKey(data);
	const at = leadTime(data);
	if (!key || !Number.isFinite(at)) return null;
	let first: R | null = null;
	let firstAt = Infinity;
	for (const r of existing) {
		const other = r.data;
		if (!r.id || !other || other.duplicate_of || repostKey(other) !== key) continue;
		const t = leadTime(other);
		if (Number.isFinite(t) && Math.abs(at - t) <= REPOST_WINDOW_MS && t < firstAt) {
			first = r;
			firstAt = t;
		}
	}
	return first;
}

const SENDER_NOISE = /\b(?:careers?|jobs?|recruitment|recruiting|talent(?:\s+acquisition)?|hr|human\s+resources|people(?:\s+and\s+culture)?|team|alerts?|notifications?|no[- ]?reply|do\s+not\s+reply|mailer|updates?)\b/gi;

/** The employer in an alert's sender display name: `"Acme Careers" <jobs@acme.example>` -> `Acme`. */
export function companyFromSender(from: unknown): string | null {
	const display = text(from).match(/^\s*"?([^"<]*?)"?\s*</)?.[1] ?? "";
	const name = display.replace(SENDER_NOISE, " ").replace(/[^\p{L}\p{N}&.' -]+/gu, " ").replace(/\s+/g, " ").trim();
	return name.length >= 2 && name.length <= 80 && /\p{L}/u.test(name) ? name : null;
}

/** host -> employer, from leads that already have one: only where every such lead on the host agrees. */
export function employerByHost(leads: readonly { data?: Record<string, unknown> }[]): Map<string, string> {
	const seen = new Map<string, Set<string>>();
	const names = new Map<string, string>();
	for (const { data } of leads) {
		const host = text(data?.source_domain).toLowerCase();
		const company = text(data?.company);
		if (!host || !company) continue;
		const key = normaliseCompany(company);
		(seen.get(host) ?? seen.set(host, new Set()).get(host))?.add(key);
		if (!names.has(host)) names.set(host, company);
	}
	return new Map([...names].filter(([host]) => seen.get(host)?.size === 1));
}

/**
 * The employer of a careers-site lead that names none (#1606): what every other lead from its host
 * says, else the alert sender's display name. A job board (SEEK, Indeed, LinkedIn) is never guessed at —
 * its employer comes from the posting.
 */
export function inferCompany(data: Record<string, unknown>, byHost: ReadonlyMap<string, string>): { company: string; source: "host" | "sender" } | null {
	const host = text(data.source_domain).toLowerCase();
	if (text(data.company) || !host || jobProviderOf(host)) return null;
	const fromHost = byHost.get(host);
	if (fromHost) return { company: fromHost, source: "host" };
	const fromSender = companyFromSender(data.gmail_from);
	return fromSender ? { company: fromSender, source: "sender" } : null;
}
