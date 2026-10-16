/**
 * Is an owner-pasted job URL one the pipeline may take in (#1056, #1098)? Pure — no request is made.
 *
 * Any public https URL that names ONE posting. The providers `provider-redirect.ts` knows (Indeed, SEEK,
 * LinkedIn) are reduced to their canonical posting URL — the id and nothing else. Any other site — a company
 * career page, a Workday, Greenhouse or Lever portal — is accepted too (#1098): the Application Runner reads
 * and fills whatever form is in front of it, so a three-site allowlist only kept good postings out. Its URL
 * keeps the parameters that identify the posting (Greenhouse's `gh_jid`, a portal's `jobId`) and loses the
 * fragment, attribution and anything personal, so a tracking id, a referral code or a signed-in user's token
 * in the pasted query never reaches a lead, a receipt or a log. A rejection is a category; it never echoes
 * the URL.
 */
import { canonicalJobUrl } from "./job-lead-triage.js";
import { jobProviderOf, providerPostingUrl } from "./gmail-scout/provider-redirect.js";
import { checkPublicHttpsUrl } from "./ssrf.js";

/** `provider_not_allowed` is gone (#1098): a site is never refused for not being one of three. */
export type ManualUrlRejectionReason = "not_https" | "private_target" | "no_posting_id";

/** `provider` is `indeed`, `seek` or `linkedin` for the sites with a known posting format, else `other`. */
export type ManualUrlCheck = { ok: true; canonicalUrl: string; provider: string } | { ok: false; reason: ManualUrlRejectionReason; host: string | null };

/** Longer than any posting URL a provider prints; anything bigger is not a pasted link. */
const MAX_URL_CHARS = 2048;

/** Query keys about the person, the session or the referral (`gh_src`), not the job — never kept on another site's URL. */
const PERSONAL_KEY = /^(?:src|.*_src|sid|session.*|.*token.*|auth.*|key|api_?key|sig|signature|code|otp|email|e|user.*|uid|member.*|mid|tracking.*|refid|ref_?id|referrer|clickid|gclid|fbclid|msclkid|_hs.*|mkt_tok|vero_.*|s_kwcid)$/i;

/**
 * The last path segment of a page that LISTS jobs rather than being one: a career site's home, its search,
 * its category pages. Such a URL with no posting-id-looking parameter is not one posting.
 */
const LISTING_SEGMENT = /^(?:jobs?|careers?|search|job-search|vacancies|openings|positions|opportunities|join-us|work-with-us|en|en-us|en-au)$/i;
/** A query value that looks like a posting id: digits, or an id-ish token such as `R12345` or a UUID. */
const POSTING_ID_VALUE = /^(?:\d{3,}|[A-Za-z]{1,4}[-_]?\d{3,}[A-Za-z0-9_-]*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** One posting on a site with no known format: kept to what identifies it, or null when it is a listing. */
export function genericPostingUrl(raw: string): string | null {
	const canonical = canonicalJobUrl(raw);
	if (!canonical) return null;
	const url = new URL(canonical);
	for (const key of [...url.searchParams.keys()]) if (PERSONAL_KEY.test(key)) url.searchParams.delete(key);
	const segments = url.pathname.split("/").filter(Boolean);
	const hasIdParam = [...url.searchParams.values()].some((v) => POSTING_ID_VALUE.test(v));
	if (!hasIdParam && (segments.length === 0 || LISTING_SEGMENT.test(segments[segments.length - 1]))) return null;
	return `https://${url.host}${url.pathname}${url.search}`;
}

export function validateManualJobUrl(raw: string): ManualUrlCheck {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return { ok: false, reason: "not_https", host: null };
	}
	const host = url.hostname.toLowerCase() || null;
	if (raw.length > MAX_URL_CHARS || url.protocol !== "https:" || url.username || url.password) return { ok: false, reason: "not_https", host };
	if (!checkPublicHttpsUrl(url.toString()).ok) return { ok: false, reason: "private_target", host };
	const provider = jobProviderOf(url.hostname);
	// A known provider: its canonical posting, or — a search, a saved search, a tracking wrapper — not ONE posting.
	const canonicalUrl = provider ? providerPostingUrl(url.toString()) : genericPostingUrl(url.toString());
	if (!canonicalUrl) return { ok: false, reason: "no_posting_id", host };
	return { ok: true, canonicalUrl, provider: provider ?? "other" };
}
