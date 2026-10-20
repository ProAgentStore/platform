/**
 * One-item provider job alerts (#1024). Live, an Indeed alert naming ONE role, employer and location
 * was rejected as `no_specific_job_url`: its only links were Indeed click redirects
 * (`/rc/clk/dl?jk=…&tk=…`), and even Indeed's own posting URL (`/viewjob?jk=…`) has one path
 * segment, so `isSpecificJobUrl` can never accept it.
 *
 * This resolves such a link server-side and accepts it only when it proves exactly ONE live
 * canonical posting whose title and company both appear in the email. Anything less fails closed
 * with a named reason. It never makes the lead more than `unverified`; that is still the Runner's
 * browser preflight. When the posting is resolved but the server cannot check its page, the answer is
 * `awaitingBrowser` (#1030): the lead waits for browser verification instead of being rejected.
 *
 * Personalized parameters (`tk`, `alid`, `qd`, `rd`, …) never leave this module. The posting is
 * fetched by its canonical URL, which carries only the posting id. A tracking link is followed only
 * when no posting id is visible in it, and only hop by hop within the provider's own hosts, so the
 * owner's alert tokens are never sent anywhere the provider did not issue them. Errors become
 * categories, never messages, because a fetch error can quote the URL it failed on.
 *
 * SEEK and LinkedIn (#1050) put the posting id in the link itself (`/job/<id>`, `/jobs/view/<id>`),
 * wrapped in personal tracking parameters (`tracking`, `trackingId`, `refId`, `midToken`, `otpToken`).
 * Those links already looked like postings to the classifier, so the tokens rode into the stored lead
 * and the posting was never checked. Now such a link is reduced to its canonical posting here, is
 * checked like an Indeed one, and — when the server cannot check it (LinkedIn's sign-in wall, a page
 * with no structured posting) — waits for the Scout's browser behind the owner's per-site consent (#1049).
 */
import type { GmailMessage } from "../gmail.js";
import { clipMarked } from "../clip-marked.js";
import { checkPublicHttpsUrl } from "../ssrf.js";
import type { GmailScoutRejection } from "./receipts.js";

interface Provider {
	name: string;
	host: RegExp;
	/** One posting, or a click redirect to one. Footer, settings, search and opaque wrapper links are not. */
	jobLink(url: URL): boolean;
	postingId(url: URL): string | null;
	/** The posting's public URL: the id and nothing personal. */
	canonical(host: string, id: string): string;
	/** A redirect from the canonical posting to the provider's sign-in wall: unchecked by the server, not gone. */
	signInWall?(location: URL): boolean;
}

const INDEED: Provider = {
	name: "indeed",
	host: /(^|\.)indeed\.(?:com|co\.[a-z]{2}|com\.[a-z]{2}|[a-z]{2})$/i,
	jobLink: (url) => /^\/(?:rc\/clk|pagead\/clk|viewjob|m\/viewjob|m\/basecamp\/viewjob)(?:\/|$)/i.test(url.pathname),
	postingId(url) {
		const jk = url.searchParams.get("jk") ?? url.searchParams.get("vjk");
		return jk && /^[0-9a-f]{16}$/i.test(jk) ? jk.toLowerCase() : null;
	},
	canonical: (host, id) => `https://${host}/viewjob?jk=${id}`,
};

/** SEEK's own web hosts; any other SEEK host (a mail or click subdomain) is canonicalised to its country site. */
const SEEK_WEB_HOST = /^(?:www\.seek\.com\.au|www\.seek\.co\.nz|au\.seek\.com|nz\.seek\.com)$/i;
const SEEK_JOB_PATH = /^\/job\/(\d{5,12})\/?$/;
const SEEK: Provider = {
	name: "seek",
	host: /(^|\.)seek\.(?:com\.au|co\.nz|com)$/i,
	jobLink: (url) => SEEK_JOB_PATH.test(url.pathname) || /^\d{5,12}$/.test(url.searchParams.get("jobId") ?? ""),
	postingId(url) {
		const id = url.pathname.match(SEEK_JOB_PATH)?.[1] ?? url.searchParams.get("jobId");
		return id && /^\d{5,12}$/.test(id) ? id : null;
	},
	canonical: (host, id) => `https://${SEEK_WEB_HOST.test(host) ? host : /(?:\.co\.nz|^nz\.seek\.com)$/i.test(host) ? "www.seek.co.nz" : "www.seek.com.au"}/job/${id}`,
};

/** `/jobs/view/<id>` and `/comm/jobs/view/<id>` (the alert form), with or without a title slug before the id. */
const LINKEDIN_JOB_PATH = /^\/(?:comm\/)?jobs\/view\/(?:[^/]*-)?(\d{6,12})\/?$/i;
const LINKEDIN: Provider = {
	name: "linkedin",
	host: /(^|\.)linkedin\.com$/i,
	jobLink: (url) => LINKEDIN_JOB_PATH.test(url.pathname) || (/^\/(?:comm\/)?jobs\//i.test(url.pathname) && /^\d{6,12}$/.test(url.searchParams.get("currentJobId") ?? "")),
	postingId(url) {
		const id = url.pathname.match(LINKEDIN_JOB_PATH)?.[1] ?? url.searchParams.get("currentJobId");
		return id && /^\d{6,12}$/.test(id) ? id : null;
	},
	canonical: (_host, id) => `https://www.linkedin.com/jobs/view/${id}`,
	signInWall: (location) => /(^|\.)linkedin\.com$/i.test(location.hostname) && /^\/(?:authwall|login|uas\/login|checkpoint|signup)(?:\/|$)/i.test(location.pathname),
};
const PROVIDERS: readonly Provider[] = [INDEED, SEEK, LINKEDIN];

/** More distinct links than one alert carries for one job (title, button, logo): treat as several jobs. */
const MAX_LINKS = 4;
const MAX_HOPS = 5;
const RESOLVE_BUDGET_MS = 15_000;
const MAX_PAGE_CHARS = 1_000_000;
const URL_RE = /https?:\/\/[^\s"'<>]+/g;

export type ProviderAlertRejection = Extract<GmailScoutRejection, "multiple_listings" | "redirect_unresolved" | "posting_not_live" | "posting_unverifiable" | "posting_mismatch">;
/**
 * Why the SERVER could not check a safely resolved posting (#1030). The canonical URL is known and
 * personal parameters are already gone — only the page check failed — so a browser checks it instead
 * of the lead being thrown away as `posting_unverifiable`.
 */
export type ServerCheckGap = "server_fetch_failed" | "server_fetch_refused" | "page_too_large" | "no_structured_posting";
export type ProviderAlertResult = { url: string; company: string } | { rejected: ProviderAlertRejection } | { awaitingBrowser: { url: string; reason: ServerCheckGap } };
type Fetch = typeof fetch;

const providerFor = (host: string) => PROVIDERS.find((p) => p.host.test(host)) ?? null;

/** The job provider a host belongs to (`indeed`, `seek`, `linkedin`), or null — the allowlist owner-pasted URLs are held to (#1056). */
export const jobProviderOf = (host: string): string | null => providerFor(host)?.name ?? null;

/** A provider job link in `raw`, or null. `&amp;` is decoded, since the body is raw HTML. */
function providerJobLink(raw: string): { url: URL; provider: Provider } | null {
	try {
		const url = new URL(raw.replace(/&amp;/g, "&").replace(/[).,;\]]+$/, ""));
		const provider = providerFor(url.hostname);
		// http is read for its id only: every hop actually requested must still be public https (`allowedHop`).
		return (url.protocol === "https:" || url.protocol === "http:") && provider?.jobLink(url) ? { url, provider } : null;
	} catch {
		return null;
	}
}

/**
 * Every distinct provider job link in the mail. Links whose posting id is visible count once per
 * posting (#1050): one LinkedIn job arrives as its title, logo and "Apply" links, each with its own
 * tracking parameters, and that is one job, not several.
 */
function providerJobLinks(text: string): URL[] {
	const out = new Map<string, URL>();
	for (const raw of text.match(URL_RE) ?? []) {
		const link = providerJobLink(raw);
		if (!link) continue;
		const id = link.provider.postingId(link.url);
		out.set(id ? `${link.provider.name}:${id}` : link.url.toString(), link.url);
	}
	return [...out.values()];
}

/**
 * The canonical public posting a SEEK or LinkedIn (or Indeed) link names in itself, or null (#1050).
 * Synchronous and request-free: the classifier uses it so a posting link's personal parameters never
 * reach a lead, and so one job's several links are counted as one.
 */
export function providerPostingUrl(raw: string): string | null {
	const link = providerJobLink(raw);
	const id = link?.provider.postingId(link.url);
	return link && id ? link.provider.canonical(link.url.hostname.toLowerCase(), id) : null;
}

/** One request, never following redirects itself, never carrying a cookie or credential. */
async function get(fetchImpl: Fetch, url: string, signal: AbortSignal): Promise<Response> {
	return fetchImpl(url, { redirect: "manual", signal, headers: { accept: "text/html" } });
}

/** A hop is followed only inside the provider's own hosts, over public https. */
const allowedHop = (url: URL, provider: Provider) => provider.host.test(url.hostname) && checkPublicHttpsUrl(url.toString()).ok;

/** Follow a tracking link until a hop names the posting id, without ever requesting that hop. */
async function postingIdBehind(fetchImpl: Fetch, link: URL, provider: Provider, signal: AbortSignal): Promise<{ host: string; id: string } | null> {
	let current = link;
	for (let hop = 0; hop <= MAX_HOPS; hop++) {
		if (!allowedHop(current, provider)) return null;
		const id = provider.postingId(current);
		if (id) return { host: current.hostname.toLowerCase(), id };
		const res = await get(fetchImpl, current.toString(), signal);
		const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
		if (!location) return null;
		current = new URL(location, current);
	}
	return null;
}

interface PostingData {
	title: string;
	company: string;
	validThrough: string | null;
}

/** Schema.org `JobPosting` objects in the page's JSON-LD: the structured posting job boards publish. */
function jobPostings(html: string): PostingData[] {
	const out: PostingData[] = [];
	const visit = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const n of node) visit(n);
			return;
		}
		if (!node || typeof node !== "object") return;
		const o = node as Record<string, unknown>;
		if (o["@graph"]) visit(o["@graph"]);
		const type = o["@type"];
		if (!(type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting")))) return;
		const org = o.hiringOrganization;
		const company = typeof org === "string" ? org : org && typeof org === "object" ? (org as Record<string, unknown>).name : undefined;
		out.push({ title: typeof o.title === "string" ? o.title : "", company: typeof company === "string" ? company : "", validThrough: typeof o.validThrough === "string" ? o.validThrough : null });
	};
	for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
		try {
			visit(JSON.parse(m[1]));
		} catch {
			// a malformed block proves nothing
		}
	}
	return out;
}

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const words = (v: string) =>
	v
		.replace(/&(#\d+|[a-z]+);/gi, (_, e: string) => (e.startsWith("#") ? String.fromCharCode(Number(e.slice(1))) : (ENTITY[e.toLowerCase()] ?? " ")))
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
const COMPANY_SUFFIX = /\b(?:pty|ltd|limited|inc|llc|plc|corp|corporation|gmbh)\b/g;

/** Every title word, and the employer's name as a phrase, appear in what the email visibly says. */
function agrees(message: GmailMessage, posting: PostingData): boolean {
	const visible = ` ${words(`${message.subject}\n${message.snippet}\n${message.text.replace(/<[^>]*>/g, " ").replace(URL_RE, " ")}`)} `;
	const emailWords = new Set(visible.split(" "));
	const titleWords = words(posting.title).split(" ").filter(Boolean);
	const company = words(posting.company).replace(COMPANY_SUFFIX, " ").replace(/\s+/g, " ").trim() || words(posting.company);
	return titleWords.length > 0 && titleWords.every((w) => emailWords.has(w)) && !!company && visible.includes(` ${company} `);
}

/**
 * Null when the mail has no provider job link — it stays `no_specific_job_url`. Otherwise either
 * the canonical posting (no personal parameters) and its employer, or why it was refused.
 */
export async function resolveProviderJobAlert(message: GmailMessage, fetchImpl: Fetch = fetch, now = Date.now()): Promise<ProviderAlertResult | null> {
	const links = providerJobLinks(`${message.text}\n${message.snippet}`);
	if (!links.length) return null;
	if (links.length > MAX_LINKS) return { rejected: "multiple_listings" };
	const signal = AbortSignal.timeout(RESOLVE_BUDGET_MS);
	const postings = new Map<string, { host: string; id: string; provider: Provider }>();
	for (const link of links) {
		const provider = providerFor(link.hostname) as Provider;
		const found = await postingIdBehind(fetchImpl, link, provider, signal).catch(() => null);
		// "Exactly one" needs every link accounted for: an unresolved one could be a second job.
		if (!found) return { rejected: "redirect_unresolved" };
		postings.set(`${provider.name}:${found.id}`, { ...found, provider });
	}
	if (postings.size > 1) return { rejected: "multiple_listings" };
	const only = [...postings.values()][0];
	const checked = await checkCanonicalPosting(fetchImpl, only.provider.canonical(only.host, only.id), only.provider, message, signal, now);
	return "title" in checked ? { url: checked.url, company: checked.company } : checked;
}

/** A posting the job board itself confirmed: its canonical URL, title and employer, as the board publishes them. */
export type CheckedPosting = { url: string; title: string; company: string };

/**
 * Check ONE canonical posting against the job board and the email that named it (#1024, #1050, #1248):
 * still live, exactly one structured posting, and the email visibly names its title and employer. Shared
 * by a one-job alert and by every posting inside a digest, so both are held to the same rule.
 */
async function checkCanonicalPosting(fetchImpl: Fetch, canonical: string, provider: Provider, message: GmailMessage, signal: AbortSignal, now: number): Promise<CheckedPosting | { rejected: ProviderAlertRejection } | { awaitingBrowser: { url: string; reason: ServerCheckGap } }> {
	let res: Response;
	try {
		res = await get(fetchImpl, canonical, signal);
	} catch {
		return { awaitingBrowser: { url: canonical, reason: "server_fetch_failed" } };
	}
	if (res.status === 404 || res.status === 410) return { rejected: "posting_not_live" };
	if (res.status >= 300 && res.status < 400) {
		// LinkedIn answers a server it does not know with its sign-in wall (#1050): the posting is not
		// gone, the server just cannot see it — so a browser checks it. Nothing on that wall is followed.
		const location = res.headers.get("location");
		let to: URL | null = null;
		try {
			to = location ? new URL(location, canonical) : null;
		} catch {
			// an unreadable location proves nothing about a wall
		}
		if (to && provider.signInWall?.(to)) return { awaitingBrowser: { url: canonical, reason: "server_fetch_refused" } };
		// The canonical posting moving elsewhere (Indeed sends an expired job to search) is not the job.
		return { rejected: "posting_not_live" };
	}
	if (res.status !== 200) return { awaitingBrowser: { url: canonical, reason: "server_fetch_refused" } };
	const html = await res.text().catch(() => "");
	// Refused rather than cut: a truncated page could hide a second posting.
	if (html.length > MAX_PAGE_CHARS) return { awaitingBrowser: { url: canonical, reason: "page_too_large" } };
	const found = jobPostings(html);
	// No single structured posting: a browser reads the page as a person does. (Several postings on the
	// canonical page are still refused below by the browser's `mismatch`, never assumed to be this job.)
	if (found.length !== 1 || !found[0].title || !found[0].company) return { awaitingBrowser: { url: canonical, reason: "no_structured_posting" } };
	const posting = found[0];
	if (posting.validThrough && Date.parse(posting.validThrough) < now) return { rejected: "posting_not_live" };
	if (!agrees(message, posting)) return { rejected: "posting_mismatch" };
	return { url: canonical, title: clipMarked(posting.title.trim(), 300, { within: true }), company: clipMarked(posting.company.trim(), 160, { within: true }) };
}

/** Postings checked per digest, at most, and how many at once; one budget covers them all (#1248). */
export const DIGEST_POSTINGS_MAX = 25;
const DIGEST_CHECK_CONCURRENCY = 5;
const DIGEST_BUDGET_MS = 25_000;

/**
 * Check every posting a digest names (#1248). Only links that NAME their posting are checked — a digest's
 * tracking redirects are never followed (one email carried 20-29 of them). Results come back in order,
 * one per URL; a non-provider URL (a company's careers page) has nothing the server can read, and says so.
 */
export async function checkDigestPostings(message: GmailMessage, urls: readonly string[], fetchImpl: Fetch = fetch, now = Date.now()): Promise<Array<CheckedPosting | { rejected: ProviderAlertRejection } | { awaitingBrowser: { url: string; reason: ServerCheckGap } } | { unchecked: { url: string } }>> {
	const signal = AbortSignal.timeout(DIGEST_BUDGET_MS);
	const out: Array<CheckedPosting | { rejected: ProviderAlertRejection } | { awaitingBrowser: { url: string; reason: ServerCheckGap } } | { unchecked: { url: string } }> = new Array(urls.length);
	let next = 0;
	const worker = async () => {
		for (let i = next++; i < urls.length; i = next++) {
			const url = urls[i];
			let host = "";
			try {
				host = new URL(url).hostname.toLowerCase();
			} catch {
				host = "";
			}
			const provider = providerFor(host);
			out[i] = provider ? await checkCanonicalPosting(fetchImpl, url, provider, message, signal, now) : { unchecked: { url } };
		}
	};
	await Promise.all(Array.from({ length: Math.min(DIGEST_CHECK_CONCURRENCY, urls.length) }, worker));
	return out;
}
