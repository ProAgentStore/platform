/**
 * One-item provider job alerts (#1024). Live, an Indeed alert naming ONE role, employer and location
 * was rejected as `no_specific_job_url`: its only links were Indeed click redirects
 * (`/rc/clk/dl?jk=…&tk=…`), and even Indeed's own posting URL (`/viewjob?jk=…`) has one path
 * segment, so `isSpecificJobUrl` can never accept it.
 *
 * This resolves such a link server-side and accepts it only when it proves exactly ONE live
 * canonical posting whose title and company both appear in the email. Anything less fails closed
 * with a named reason. It never makes the lead more than `unverified`; that is still the Runner's
 * browser preflight.
 *
 * Personalized parameters (`tk`, `alid`, `qd`, `rd`, …) never leave this module. The posting is
 * fetched by its canonical URL, which carries only the posting id. A tracking link is followed only
 * when no posting id is visible in it, and only hop by hop within the provider's own hosts, so the
 * owner's alert tokens are never sent anywhere the provider did not issue them. Errors become
 * categories, never messages, because a fetch error can quote the URL it failed on.
 */
import type { GmailMessage } from "../gmail.js";
import { clipMarked } from "../clip-marked.js";
import { checkPublicHttpsUrl } from "../ssrf.js";
import type { GmailScoutRejection } from "./receipts.js";

interface Provider {
	host: RegExp;
	/** A path that is one posting, or a click redirect to one. Footer, settings and search links are not. */
	jobLink: RegExp;
	postingId(url: URL): string | null;
	canonical(host: string, id: string): string;
}

const INDEED: Provider = {
	host: /(^|\.)indeed\.(?:com|co\.[a-z]{2}|com\.[a-z]{2}|[a-z]{2})$/i,
	jobLink: /^\/(?:rc\/clk|pagead\/clk|viewjob|m\/viewjob|m\/basecamp\/viewjob)(?:\/|$)/i,
	postingId(url) {
		const jk = url.searchParams.get("jk") ?? url.searchParams.get("vjk");
		return jk && /^[0-9a-f]{16}$/i.test(jk) ? jk.toLowerCase() : null;
	},
	canonical: (host, id) => `https://${host}/viewjob?jk=${id}`,
};
const PROVIDERS: readonly Provider[] = [INDEED];

/** More distinct links than one alert carries for one job (title, button, logo): treat as several jobs. */
const MAX_LINKS = 4;
const MAX_HOPS = 5;
const RESOLVE_BUDGET_MS = 15_000;
const MAX_PAGE_CHARS = 1_000_000;
const URL_RE = /https?:\/\/[^\s"'<>]+/g;

export type ProviderAlertRejection = Extract<GmailScoutRejection, "multiple_listings" | "redirect_unresolved" | "posting_not_live" | "posting_unverifiable" | "posting_mismatch">;
export type ProviderAlertResult = { url: string; company: string } | { rejected: ProviderAlertRejection };
type Fetch = typeof fetch;

const providerFor = (host: string) => PROVIDERS.find((p) => p.host.test(host)) ?? null;

/** Every distinct provider job link in the mail. `&amp;` is decoded, since the body is raw HTML. */
function providerJobLinks(text: string): URL[] {
	const out = new Map<string, URL>();
	for (const raw of text.match(URL_RE) ?? []) {
		try {
			const url = new URL(raw.replace(/&amp;/g, "&").replace(/[).,;\]]+$/, ""));
			const provider = providerFor(url.hostname);
			if (url.protocol === "https:" && provider?.jobLink.test(url.pathname)) out.set(url.toString(), url);
		} catch {
			// not a URL
		}
	}
	return [...out.values()];
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
		postings.set(found.id, { ...found, provider });
	}
	if (postings.size > 1) return { rejected: "multiple_listings" };
	const only = [...postings.values()][0];
	const canonical = only.provider.canonical(only.host, only.id);
	let res: Response;
	try {
		res = await get(fetchImpl, canonical, signal);
	} catch {
		return { rejected: "posting_unverifiable" };
	}
	if (res.status === 404 || res.status === 410) return { rejected: "posting_not_live" };
	// The canonical posting moving elsewhere (Indeed sends an expired job to search) is not the job.
	if (res.status >= 300 && res.status < 400) return { rejected: "posting_not_live" };
	if (res.status !== 200) return { rejected: "posting_unverifiable" };
	const html = await res.text().catch(() => "");
	// Refused rather than cut: a truncated page could hide a second posting.
	if (html.length > MAX_PAGE_CHARS) return { rejected: "posting_unverifiable" };
	const found = jobPostings(html);
	if (found.length !== 1 || !found[0].title || !found[0].company) return { rejected: "posting_unverifiable" };
	const posting = found[0];
	if (posting.validThrough && Date.parse(posting.validThrough) < now) return { rejected: "posting_not_live" };
	if (!agrees(message, posting)) return { rejected: "posting_mismatch" };
	return { url: canonical, company: clipMarked(posting.company.trim(), 160, { within: true }) };
}
