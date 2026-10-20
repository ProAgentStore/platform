/** Read-only Gmail alert ingestion. Mail text is parsed in-process; only metadata and short snippets are logged (#1247), never a body. */
import type { Env } from "../../types.js";
import type { GmailScoutScanResult } from "../../agent-types.js";
import { connectorClient } from "../connectors/client.js";
import { emailPermitted } from "../connectors/gmail.js";
import { getMessage, listMessages, type GmailMessage } from "../gmail.js";
import { canonicalJobUrl, jobIdentity, workKeyForLead } from "../job-lead-triage.js";
import { clipMarked } from "../clip-marked.js";
import { GMAIL_SCOUT_SCAN_INTERVAL_MS, getGmailScoutConfig, getGmailScoutScanState, resolveGmailScoutAccount } from "./config.js";
import { appliedWorkKeys, enqueueBrowserVerification } from "../job-lead-queue.js";
import { seekDigestListings } from "./seek-digest.js";
import { checkDigestPostings, DIGEST_POSTINGS_MAX, jobProviderOf, providerPostingUrl, resolveProviderJobAlert, type ServerCheckGap } from "./provider-redirect.js";

/** A lead stored `awaiting_browser_verification` (#1030), to be queued for the Scout's browser. */
export interface AwaitingBrowserLead {
	leadId: string;
	workKey: string;
	canonicalUrl: string;
	title: string | null;
	company: string | null;
	reason: ServerCheckGap;
}
import { completeGmailScoutReceipt, failGmailScoutReceipt, type GmailScoutRejection, type GmailScoutScanTrigger, listGmailScoutReceipts, openGmailScoutReceipt, pruneGmailScoutReceipts, recordGmailScoutSearch } from "./receipts.js";
import { messageFields, pruneScanLog, rejectionClassification, rejectionReason, type ScanLogEntry, type ScanLogRead, writeScanLog } from "./scan-log.js";

// A recent alert is an intake clue, not vacancy verification.  We deliberately keep the window
// short and require the Runner's browser preflight before a lead can be treated as live.
const JOB_ALERT_FILTER = "(subject:(job OR jobs OR role OR opportunity OR alert OR recommendation) OR from:(seek.com linkedin.com indeed.com))";
const JOB_ALERT_QUERY = `${JOB_ALERT_FILTER} newer_than:2d`;
/** How old a message an ordinary scan accepts: an alert is an intake clue, so it must be recent. */
const SCAN_MAX_AGE_MS = 2 * 24 * 60 * 60_000;
/** The furthest back an owner may reprocess (#1052), and how many messages one reprocess may read. */
export const REPROCESS_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
export const REPROCESS_MAX_MESSAGES = 25;
const URL_RE = /https?:\/\/[^\s"'<>]+/g;
export type GmailLeadProvenance = {
	provider: "gmail";
	message_id: string;
	subject: string;
	sender: string;
	received_at: string;
	source_domain: string;
};
export type ScoutCandidate = { url: string; title: string | null; company?: string; location?: string; source: string; source_domain?: string; posted_date?: string; gmail_message_id: string; gmail_subject: string; gmail_from: string; gmail_date: string; gmail_provenance: GmailLeadProvenance };

const SECURITY_ALERT_RE = /(?:security|verify|verification|password|sign[ -]?in|login|unusual activity|account alert)/i;
/**
 * A digest or summary describes MANY jobs (#1022): its subject is not a job title and its first link is
 * one listing among several. Live, a SEEK "X [Very strong applicant] + 11 new jobs" recommendation became
 * a lead titled with that subject and the CSS fragment `info {` as its employer, and the Tailor could only
 * ask the owner what the role and company were. A concrete posting is one job, named as one job.
 */
const DIGEST_SUBJECT_RE = /\+\s*\d+\s+(?:more\s+)?(?:new\s+)?jobs?\b|\b\d+\s+(?:more\s+)?new\s+jobs?\b|\bwe\s+found\s+\d+|\[\s*very strong applicant\s*\]|\bweekly\b.*\bupdate\b|\bsaved\s+search\b|\bjob\s+recommendations\b|\bnew\s+jobs\s+for\s+you\b/i;
/** The sender's display name says it is a recommendation/digest feed, e.g. `SEEK Recommendations <noreply@s.seek.com.au>`. */
const DIGEST_SENDER_RE = /^\s*"?[^"<]*\b(?:recommendations?|job\s+alerts?\s+digest|digest)\b[^"<]*"?\s*</i;
/** Markup, never a name: `info {` is what `.company-info {` leaves after the label is matched. */
const MARKUP_VALUE_RE = /[{}<>;=]/;
const ASSET_RE = /\.(?:avif|bmp|css|gif|ico|jpe?g|js|png|svg|webp|woff2?|pdf)(?:$|\?)/i;
const NAV_SEGMENT_RE = /^(?:account|accounts|auth|help|home|login|logout|preferences|privacy|profile|reset|security|settings|signin|subscribe|unsubscribe)$/i;
const GENERIC_SEGMENT_RE = /^(?:alert|alerts|career|careers|job|jobs|opportunities|opportunity|position|positions|recommendation|recommendations|role|roles|search)$/i;
const GENERIC_ROUTE_SEGMENT_RE = /^(?:alerts?|browse|categories?|home|recommendations?|search)$/i;

function isSpecificJobUrl(url: string): boolean {
	const parsed = new URL(url);
	const segments = parsed.pathname.split("/").filter(Boolean);
	if (ASSET_RE.test(parsed.pathname) || segments.some((segment) => NAV_SEGMENT_RE.test(segment) || GENERIC_ROUTE_SEGMENT_RE.test(segment))) return false;
	if (["q", "query", "search", "keywords"].some((key) => parsed.searchParams.has(key))) return false;
	// Root pages and one-segment listing/search/home pages cannot identify a posting.
	if (segments.length < 2 || segments.every((segment) => GENERIC_SEGMENT_RE.test(segment))) return false;
	const hasJobContext = segments.some((segment) => GENERIC_SEGMENT_RE.test(segment)) || /(?:job|jobs|career|role|position|apply|posting)/i.test(parsed.hostname);
	const leaf = segments.at(-1) ?? "";
	return hasJobContext && !GENERIC_SEGMENT_RE.test(leaf) && /[a-z0-9]/i.test(leaf);
}

function recentMessageDate(value: string, now = Date.now(), maxAgeMs = SCAN_MAX_AGE_MS): boolean {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && parsed <= now + 5 * 60_000 && parsed >= now - maxAgeMs;
}

/** Every distinct specific posting in the text, by host + path (tracking parameters do not make a second job). */
function specificJobUrls(text: string): Set<string> {
	const out = new Set<string>();
	for (const raw of text.match(URL_RE) ?? []) {
		const url = canonicalJobUrl(raw.replace(/[).,;\]]+$/, ""));
		if (url && isSpecificJobUrl(url)) {
			const u = new URL(url);
			// One provider posting is one job, whichever of its links or tracking forms the mail used (#1050).
			out.add(providerPostingUrl(url) ?? `${u.host}${u.pathname}`);
		}
	}
	return out;
}

/** Extract only a specific posting URL; generic mail/navigation/asset links never become leads. */
export function specificJobUrl(text: string): string | null {
	for (const raw of text.match(URL_RE) ?? []) {
		const url = canonicalJobUrl(raw.replace(/[).,;]+$/, ""));
		if (url && isSpecificJobUrl(url)) return url;
	}
	return null;
}

function metadataLine(value: string | undefined): string | undefined {
	const clean = value?.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
	return clean ? clipMarked(clean, 160, { within: true }) : undefined;
}

/** Pull only short labelled/display metadata from the transient mail body; never retain its prose. */
function extractVisibleMetadata(message: GmailMessage): Pick<ScoutCandidate, "company" | "location"> {
	const text = `${message.subject}\n${message.snippet}\n${message.text}`;
	const company =
		text.match(/(?:company|employer|organisation|organization)\s*[:-]\s*([^\n|•]{2,100})/i)?.[1] ??
		text.match(/\b(?:at|with|join)\s+([A-Z][\w&.,'’ -]{1,80}?)(?=\s+(?:in|—|\||,)|$)/m)?.[1];
	const location =
		text.match(/(?:location|based\s+in|work\s+location)\s*[:-]\s*([^\n|•]{2,100})/i)?.[1] ??
		text.match(/\b(?:in|located\s+in)\s+([A-Z][\w .,'’-]{1,80}?)(?=\s+(?:—|\|)|$)/m)?.[1];
	const clean = (v: string | undefined) => (v && !MARKUP_VALUE_RE.test(v) ? metadataLine(v) : undefined);
	return { company: clean(company), location: clean(location) };
}

/** Deliberately modest extraction: metadata is visible, body prose is neither stored nor logged. */
export function candidateFromMessage(message: GmailMessage, now = Date.now()): ScoutCandidate | null {
	const out = classifyGmailMessage(message, now);
	return "candidate" in out ? out.candidate : null;
}

/**
 * The same rule as {@link candidateFromMessage}, but saying WHY a message is not a lead (#1023), so a
 * scan's receipt can count its rejections by category. The reason is a category, never message content.
 */
export function classifyGmailMessage(message: GmailMessage, now = Date.now(), maxAgeMs = SCAN_MAX_AGE_MS): { candidate: ScoutCandidate } | { rejected: GmailScoutRejection } {
	if (!message.id || !message.subject?.trim() || !message.from?.trim()) return { rejected: "missing_fields" };
	// A reprocess (#1052) widens only this age bound; every rule below holds unchanged.
	if (!recentMessageDate(message.date, now, maxAgeMs)) return { rejected: "stale" };
	if (SECURITY_ALERT_RE.test(`${message.subject}\n${message.from}`)) return { rejected: "security_alert" };
	// Concrete-job-only (#1022): a digest, a summary or a recommendation feed never becomes ONE lead named
	// by its subject. Here it is only classified; the scan then takes each posting it names on its own,
	// titled from the job board (#1248), and rejects it outright only when it names none.
	if (DIGEST_SUBJECT_RE.test(message.subject) || DIGEST_SENDER_RE.test(message.from)) return { rejected: "digest" };
	if (specificJobUrls(`${message.text}\n${message.snippet}`).size > 1) return { rejected: "multiple_listings" };
	const url = specificJobUrl(message.text) ?? specificJobUrl(message.snippet);
	if (!url) return { rejected: "no_specific_job_url" };
	if (!workKeyForLead({ url })) return { rejected: "no_work_key" };
	// A provider posting link keeps only its id (#1050): SEEK's `tracking` and LinkedIn's `trackingId`,
	// `refId`, `midToken`, `otpToken` are the owner's personal parameters and never reach a lead.
	return { candidate: candidateFor(message, providerPostingUrl(url) ?? url) };
}

/**
 * Would today's intake rules reject this STORED lead? (#1022) Leads stored before the concrete-job
 * rules — digests, security mail, search and career-site pages — are still in the queue. Judged from
 * what the lead kept (subject, sender, URL); the mail itself is not read again.
 */
export function gmailLeadIntakeRejection(data: Record<string, unknown>): GmailScoutRejection | null {
	const subject = String(data.gmail_subject ?? data.title ?? "");
	const from = String(data.gmail_from ?? "");
	if (SECURITY_ALERT_RE.test(`${subject}\n${from}`)) return "security_alert";
	// A lead taken from inside a digest (#1248) carries the digest's subject by design; its posting was checked.
	if (data.from_digest !== true && (DIGEST_SUBJECT_RE.test(subject) || DIGEST_SENDER_RE.test(from))) return "digest";
	const url = typeof data.url === "string" ? canonicalJobUrl(data.url) : null;
	return url && isSpecificJobUrl(url) ? null : "no_specific_job_url";
}

/**
 * The evidence for a rejection (#1247): the subject words, sender name, link count or date that decided
 * it — what an owner needs to judge the call. Short, and never body prose.
 */
export function rejectionEvidence(message: GmailMessage, rejection: GmailScoutRejection, maxAgeMs = SCAN_MAX_AGE_MS): string | null {
	const quote = (v: string | undefined) => (v ? `"${clipMarked(v, 120, { within: true })}"` : "");
	switch (rejection) {
		case "missing_fields":
			return `missing: ${[!message.id && "id", !message.subject?.trim() && "subject", !message.from?.trim() && "sender"].filter(Boolean).join(", ")}`;
		case "stale":
			return `received ${message.date || "(no date)"}; this scan accepts mail from the last ${Math.round(maxAgeMs / 86_400_000)} day(s)`;
		case "security_alert":
			return `subject or sender contains ${quote(`${message.subject}\n${message.from}`.match(SECURITY_ALERT_RE)?.[0])}`;
		case "digest": {
			const bySubject = message.subject.match(DIGEST_SUBJECT_RE)?.[0];
			return bySubject ? `subject contains ${quote(bySubject)}` : `sender name marks a digest feed: ${quote(message.from.match(DIGEST_SENDER_RE)?.[0]?.replace(/\s*<$/, ""))}`;
		}
		case "multiple_listings":
			return `${Math.max(specificJobUrls(`${message.text}\n${message.snippet}`).size, 2)} distinct job links found`;
		case "no_specific_job_url":
			return `${(`${message.text}\n${message.snippet}`.match(URL_RE) ?? []).length} link(s) checked; none names one posting`;
		default:
			return null;
	}
}

/** What a scan read of a message (#1247): which parts, and the counts it found — never their text. */
export function readSummary(message: GmailMessage): ScanLogRead {
	const all = `${message.text}\n${message.snippet}`;
	return {
		parts: ["headers", "snippet", ...(message.text ? ["body"] : [])],
		bodyChars: message.text.length,
		linksFound: new Set(all.match(URL_RE) ?? []).size,
		jobPostingsDetected: specificJobUrls(all).size,
	};
}

/**
 * The jobs a digest lists (#1247), each by its canonical posting URL, with a title and employer only where
 * the email itself names them: a link's own anchor text, or SEEK's listing block (#1251, `seek-digest.ts`).
 * No title is better than a wrong one — the nearest plain-text line to a SEEK link was a location, a salary
 * or a bullet. Only links that name their posting are kept; a tracking redirect is counted, not followed.
 */
export function digestJobs(message: GmailMessage): { jobs: Array<{ title: string | null; company: string | null; url: string }>; unresolved: number } {
	const text = `${message.text}\n${message.snippet}`;
	const jobs = new Map<string, { title: string | null; url: string; anchored: boolean }>();
	const unresolvedLinks = new Set<string>();
	// Every occurrence, not every distinct link: one job's HTML anchor and its plain-text line carry
	// different tracking parameters, and only the anchor reliably holds the title (#1247 — live, the
	// plain-text line before a SEEK link was a lone "[").
	for (const m of text.matchAll(URL_RE)) {
		const raw = m[0];
		const clean = raw.replace(/&amp;/g, "&").replace(/[).,;\]]+$/, "");
		const canonical = canonicalJobUrl(clean);
		const url = providerPostingUrl(clean) ?? (canonical && isSpecificJobUrl(canonical) ? canonical : null);
		if (!url) {
			if (jobProviderOf(safeHost(clean)) !== null) unresolvedLinks.add(clean);
			continue;
		}
		const anchor = anchorText(text, (m.index ?? 0) + raw.length);
		const prior = jobs.get(url);
		if (prior?.anchored || (prior && !anchor)) continue;
		jobs.set(url, { url, title: anchor, anchored: anchor !== null });
	}
	const listed = seekDigestListings(text);
	return {
		jobs: [...jobs.values()].map(({ title, url }) => ({ title: title ?? listed.get(url)?.title ?? null, company: listed.get(url)?.company ?? null, url })),
		unresolved: unresolvedLinks.size,
	};
}
const safeHost = (raw: string) => {
	try {
		return new URL(raw).hostname;
	} catch {
		return "";
	}
};
/** Shown words only: no markup, no bare URL, and at least one letter or digit (a lone "[" is not a title). */
function titleText(v: string | undefined): string | null {
	const t = (v ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
	return t && /[\p{L}\p{N}]/u.test(t) && !MARKUP_VALUE_RE.test(t) && !/^https?:/i.test(t) ? clipMarked(t, 160, { within: true }) : null;
}
/** The text of the `<a>` whose href ends at `end`, if the link sits in one. */
function anchorText(text: string, end: number): string | null {
	return titleText(text.slice(end, end + 700).match(/^["']?[^>\n]{0,200}>([\s\S]{0,400}?)<\/a>/i)?.[1]);
}
/** The lead a message becomes once its posting URL is known — from the mail itself, or resolved (#1024). */
/** `title: null` = a digest posting nothing names yet (#1248): untitled, never named after the digest's subject. */
function candidateFor(message: GmailMessage, url: string, resolvedCompany?: string, title?: string | null): ScoutCandidate {
	const host = new URL(url).hostname.toLowerCase();
	const subject = clipMarked(message.subject, 300, { within: true });
	const sender = clipMarked(message.from, 300, { within: true });
	const receivedAt = clipMarked(message.date, 100, { within: true });
	const metadata = extractVisibleMetadata(message);
	return {
		url,
		title: title === null ? null : (title && clipMarked(title.trim(), 300, { within: true })) || clipMarked(message.subject.trim(), 300, { within: true }) || "Job suggestion",
		source: "Gmail",
		source_domain: host,
		posted_date: message.date || undefined,
		gmail_message_id: message.id,
		gmail_subject: subject,
		gmail_from: sender,
		gmail_date: receivedAt,
		gmail_provenance: { provider: "gmail", message_id: message.id, subject, sender, received_at: receivedAt, source_domain: host },
		// A digest posting's employer is the BOARD's (#1248): the email's "company:" line belongs to some other job in it.
		...(title !== undefined ? {} : metadata),
		company: title !== undefined ? resolvedCompany : (metadata.company ?? resolvedCompany),
	};
}
function stub(env: Env, id: string) { return env.AGENT.get(env.AGENT.idFromName(id)); }

/**
 * A brand-new Scout has no collection schema until its first lead is inserted (the Agent DO
 * creates it on that insert).  Probe the collection route first, where absence is an explicit
 * 404, rather than mistaking record-query's generic error for a Gmail failure.  Do not turn
 * any other storage failure into an empty inbox: that would hide an unavailable Scout store.
 */
export async function readGmailScoutLeadRecords(env: Env, instanceId: string, query?: URLSearchParams) {
	const agent = stub(env, instanceId);
	const collection = await agent.fetch(new Request("https://agent/collections/job_leads"));
	if (collection.status === 404) return [];
	if (!collection.ok) throw new Error("Could not inspect this Scout's job leads.");
	// Preserve caller query keys when this is reached from the status route: AgentDO's paging
	// contract is shared by every collection reader, and dropping one here is the #428 seam bug.
	const suffix = query?.toString() || "limit=500";
	const res = await agent.fetch(new Request(`https://agent/collections/job_leads/records?${suffix}`));
	if (!res.ok) throw new Error("Could not read this Scout's job leads.");
	const body = await res.json() as { records?: Array<{ id?: string; data?: Record<string, unknown> }> };
	return body.records ?? [];
}
async function insert(env: Env, instanceId: string, data: Record<string, unknown>): Promise<{ created: boolean; id?: string }> {
	const res = await stub(env, instanceId).fetch(new Request("https://agent/collections/job_leads/records", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data }) }));
	if (!res.ok) throw new Error("Could not save a Gmail job lead.");
	const body = (await res.json()) as { created?: unknown; id?: unknown };
	return { created: body.created !== false, ...(typeof body.id === "string" ? { id: body.id } : {}) };
}

/** The two durable duplicate keys: Gmail message identity and platform-wide job identity. */
export function duplicateGmailLead(candidate: Pick<ScoutCandidate, "url" | "gmail_message_id">, existing: readonly { data?: Record<string, unknown> }[]): boolean {
	return matchingGmailLead(candidate, existing) !== null;
}

/** The stored lead a candidate duplicates, and on which key (#1247: the log names the lead it was deduped against). */
export function matchingGmailLead<R extends { id?: string; data?: Record<string, unknown> }>(candidate: Partial<Pick<ScoutCandidate, "gmail_message_id">> & Pick<ScoutCandidate, "url">, existing: readonly R[], opts: { byMessage?: boolean } = {}): { record: R; on: "gmail_message" | "job" } | null {
	const identity = jobIdentity({ url: candidate.url });
	// A digest's postings share one Gmail message (#1248), so for them — and against a lead that came from
	// one — the message is not a duplicate key: the JOB is.
	const byMessage = opts.byMessage !== false;
	for (const record of existing) {
		if (byMessage && candidate.gmail_message_id && record.data?.from_digest !== true && record.data?.gmail_message_id === candidate.gmail_message_id) return { record, on: "gmail_message" };
		if (identity && jobIdentity(record.data ?? {}) === identity) return { record, on: "job" };
	}
	return null;
}
export type { GmailScoutScanResult } from "../../agent-types.js";

type ScanCursor = { after: string; messageId: string | null };

function scanCursor(value: string | null): ScanCursor | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as Partial<ScanCursor>;
		return typeof parsed.after === "string" && !Number.isNaN(Date.parse(parsed.after)) ? { after: parsed.after, messageId: typeof parsed.messageId === "string" ? parsed.messageId : null } : null;
	} catch {
		return null;
	}
}

/** Gmail's search grammar accepts a date floor; retain the message id for observability/dedupe. */
export function gmailScoutQuery(cursor: string | null): string {
	const prior = scanCursor(cursor);
	if (!prior) return JOB_ALERT_QUERY;
	const date = new Date(prior.after);
	return `${JOB_ALERT_QUERY} after:${date.getUTCFullYear()}/${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

/**
 * Ingest one Gmail search result set into the caller-supplied Scout collection. Keeping the
 * collection writer explicit makes the private-collection boundary testable without a live DO.
 */
export async function ingestGmailCandidates(input: {
	hits: readonly { id: string }[];
	readMessage: (id: string) => Promise<GmailMessage>;
	existing: { id?: string; data?: Record<string, unknown> }[];
	/** The mailbox's address, so each logged email's link opens in THAT account (#1247). */
	mailbox?: string | null;
	/** `false` means the owning Scout returned an existing unchanged lead (a concurrent duplicate). The record id, when known, queues a browser verification (#1030). */
	insertLead: (data: Record<string, unknown>) => Promise<boolean | undefined | { created: boolean; id?: string }>;
	/** How a provider redirect is resolved (#1024); the global `fetch` in production. */
	fetchImpl?: typeof fetch;
	/** Oldest message accepted; an ordinary scan keeps the 2-day bound, a reprocess widens it (#1052). */
	maxAgeMs?: number;
	/** Work keys that already have an application (#1052): never materialized again, whatever its state. */
	appliedWorkKeys?: ReadonlySet<string>;
	/** Extra fields stamped on every lead this call creates, e.g. how it was materialized. */
	leadExtras?: Record<string, unknown>;
}): Promise<{ candidates: number; added: number; deduped: number; rejected: Partial<Record<GmailScoutRejection, number>>; awaiting: AwaitingBrowserLead[]; log: ScanLogEntry[] }> {
	let added = 0, deduped = 0, candidates = 0;
	const awaiting: AwaitingBrowserLead[] = [];
	const rejected: Partial<Record<GmailScoutRejection, number>> = {};
	const log: ScanLogEntry[] = [];
	for (const [seq, hit] of input.hits.entries()) {
		const message = await input.readMessage(hit.id);
		const fields = messageFields(message, input.mailbox ?? null, readSummary(message));
		const entry = (e: Pick<ScanLogEntry, "classification" | "evidence" | "decision" | "rejection" | "reason" | "leadId" | "job">) => log.push({ seq, subIndex: null, ...fields, ...e });
		const reject = (r: GmailScoutRejection, evidence: string | null, job: ScanLogEntry["job"] = null) => {
			rejected[r] = (rejected[r] ?? 0) + 1;
			entry({ classification: rejectionClassification(r), evidence, decision: "rejected", rejection: r, reason: rejectionReason(r), leadId: null, job });
		};
		let classified: ReturnType<typeof classifyGmailMessage> = classifyGmailMessage(message, Date.now(), input.maxAgeMs);
		/** How the posting was found, for the log: in the mail, or behind the provider's link. */
		let via = "posting link found in the email";
		/** Set when the posting resolved but the server could not check its page (#1030). */
		let serverGap: ServerCheckGap | null = null;
		// #1024: a one-item provider alert carries only a redirect. Resolve it — after the digest,
		// multi-listing and security checks above have already passed — or say exactly why not.
		// #1050: a SEEK or LinkedIn posting link is checked the same way, rather than accepted unchecked.
		const providerPosting = "candidate" in classified && providerPostingUrl(classified.candidate.url) !== null;
		if (providerPosting || ("rejected" in classified && classified.rejected === "no_specific_job_url")) {
			const resolved = await resolveProviderJobAlert(message, input.fetchImpl);
			if (resolved && "awaitingBrowser" in resolved) {
				// Resolved to ONE canonical posting, but the page could not be checked here: a browser
				// checks it instead of the lead being thrown away (#1030). Only the canonical URL is kept.
				classified = { candidate: candidateFor(message, resolved.awaitingBrowser.url) };
				serverGap = resolved.awaitingBrowser.reason;
				via = `provider link resolved to ${resolved.awaitingBrowser.url}; the server could not check the page (${serverGap})`;
			} else if (resolved) {
				classified = "rejected" in resolved ? resolved : { candidate: candidateFor(message, resolved.url, resolved.company) };
				via = "rejected" in resolved ? `provider link checked server-side: ${resolved.rejected.replace(/_/g, " ")}` : `provider link resolved to ${resolved.url}, a live posting matching the email`;
			}
		}
		// #1248: a digest is a CONTAINER, not a verdict. Each posting it names is checked and taken or not on
		// its own; the digest is rejected outright only when nothing in it can be extracted.
		if ("rejected" in classified && (classified.rejected === "digest" || classified.rejected === "multiple_listings")) {
			const taken = await ingestDigest(message, seq, fields, classified.rejected, input.maxAgeMs);
			if (taken) continue;
		}
		if ("rejected" in classified) {
			reject(classified.rejected, rejectionEvidence(message, classified.rejected, input.maxAgeMs) ?? via);
			continue;
		}
		const candidate = classified.candidate;
		const job = { title: candidate.title, company: candidate.company ?? null, url: candidate.url };
		const out = await store(candidate, serverGap);
		if (out.kind === "rejected") reject(out.rejection, out.evidence, job);
		else entry({ ...outcomeEntry(out, candidate, serverGap, via), job });
	}
	return { candidates, added, deduped, rejected, awaiting, log };

	/**
	 * Store ONE candidate as a lead — the same rules for a one-job alert and for each posting inside a
	 * digest (#1248): dedupe, a work key, no replay of a job that has an application, then insert, and
	 * queue it for browser verification when the server could not check its page (#1030).
	 */
	async function store(candidate: ScoutCandidate, serverGap: ServerCheckGap | null, opts: { fromDigest?: boolean } = {}): Promise<StoreOutcome> {
		candidates++;
		const dup = matchingGmailLead(candidate, input.existing, { byMessage: !opts.fromDigest });
		if (dup) {
			deduped++;
			return { kind: "deduped", leadId: dup.record.id ?? null, on: dup.on };
		}
		const workKey = workKeyForLead(candidate);
		if (!workKey) return { kind: "rejected", rejection: "no_work_key", evidence: candidate.url };
		// An application already exists for this job — attempted, uncertain or otherwise. Its lead may be
		// gone, but a fresh one must never let the same posting be applied for again (#1052, #1013).
		if (input.appliedWorkKeys?.has(workKey)) return { kind: "rejected", rejection: "prior_application", evidence: `job ${workKey}` };
		const data = {
			...input.leadExtras,
			...candidate,
			...(opts.fromDigest ? { from_digest: true } : {}),
			work_key: workKey,
			status: serverGap ? "awaiting_browser_verification" : "unverified",
			lifecycle_version: 0,
			verification: serverGap
				? { state: "awaiting_browser_verification", source: "gmail_alert", checked_at: null, canonical_job_url: candidate.url, active_apply_url: null, reason: serverGap, evidence: null, attempts: 0 }
				: { state: "unverified", source: "gmail_alert", checked_at: null, canonical_job_url: candidate.url, active_apply_url: null, reason: "email_alert_requires_live_validation", evidence: null },
		};
		const inserted = await input.insertLead(data);
		const created = typeof inserted === "object" ? inserted.created : inserted;
		const leadId = typeof inserted === "object" ? (inserted.id ?? null) : null;
		if (created === false) {
			deduped++;
			return { kind: "concurrent", leadId };
		}
		input.existing.push({ ...(leadId ? { id: leadId } : {}), data });
		added++;
		if (serverGap && leadId) awaiting.push({ leadId, workKey, canonicalUrl: candidate.url, title: data.title ?? null, company: data.company ?? null, reason: serverGap });
		return { kind: "added", leadId };
	}

	/**
	 * A digest's postings, each checked against its job board and stored or not with its own logged reason
	 * (#1248). The title and employer come from the BOARD's structured posting, not the email's layout —
	 * which proved unreliable (#1251). A posting the board would not show is taken (awaiting a browser) only
	 * when the email's own link text names it; otherwise it is reported unidentified. Returns false when
	 * nothing in the digest names a posting, so the caller rejects it outright with that reason.
	 */
	async function ingestDigest(message: GmailMessage, seq: number, fields: ReturnType<typeof messageFields>, kind: GmailScoutRejection, maxAgeMs?: number): Promise<boolean> {
		const { jobs: all, unresolved } = digestJobs(message);
		if (!all.length) return false;
		const jobs = all.filter((_, i) => i < DIGEST_POSTINGS_MAX);
		const known = jobs.map((j) => matchingGmailLead({ url: j.url }, input.existing, { byMessage: false }));
		const toCheck = jobs.filter((_, i) => !known[i]);
		const checked = await checkDigestPostings(message, toCheck.map((j) => j.url), input.fetchImpl);
		const result = new Map(toCheck.map((j, i) => [j.url, checked[i]]));
		const counts = { added: 0, awaiting: 0, deduped: 0, notTaken: 0 };
		const subs: ScanLogEntry[] = [];
		const sub = (i: number, e: Pick<ScanLogEntry, "evidence" | "decision" | "rejection" | "reason" | "leadId" | "job">) =>
			subs.push({ seq, subIndex: i + 1, messageId: message.id || null, threadId: message.threadId || null, gmailLink: null, sender: null, subject: null, receivedAt: null, snippet: null, read: null, ...e, classification: "digest_item" });
		for (const [i, job] of jobs.entries()) {
			const dup = known[i];
			if (dup) {
				deduped++;
				counts.deduped++;
				const id = dup.record.id ?? null;
				sub(i, { evidence: `the same job (${job.url}) is already a lead`, decision: "deduped", rejection: null, reason: `Already a lead${id ? ` (${id})` : ""}, so it was not added twice.`, leadId: id, job: { title: job.title, company: job.company, url: job.url } });
				continue;
			}
			const r = result.get(job.url);
			const notTaken = (rejection: GmailScoutRejection, reason: string, evidence: string | null, title: string | null = job.title, company: string | null = job.company) => {
				rejected[rejection] = (rejected[rejection] ?? 0) + 1;
				counts.notTaken++;
				sub(i, { evidence, decision: "rejected", rejection, reason, leadId: null, job: { title, company, url: job.url } });
			};
			let candidate: ScoutCandidate | null = null;
			let gap: ServerCheckGap | null = null;
			let evidence = "";
			if (r && "title" in r) {
				candidate = candidateFor(message, r.url, r.company, r.title);
				evidence = `the job board's own posting: "${r.title}" at ${r.company}, live, and named in the email`;
			} else if (r && "rejected" in r) {
				notTaken(r.rejected, rejectionReason(r.rejected), `checked on the job board: ${r.rejected.replace(/_/g, " ")}`);
				continue;
			} else if (job.title) {
				// The board would not show the page (or it is not a job board): the email's own link text names it.
				candidate = candidateFor(message, job.url, job.company ?? undefined, job.title);
				gap = r && "awaitingBrowser" in r ? r.awaitingBrowser.reason : null;
				evidence = gap ? `title${job.company ? " and employer" : ""} as the email lists them; the job board's page could not be read here (${gap.replace(/_/g, " ")})` : `title${job.company ? " and employer" : ""} as the email lists them (not a job board the server can check)`;
			} else if (r && "awaitingBrowser" in r) {
				// A known job board's posting, identified by its id, whose page the server cannot read and whose
				// link the email leaves unnamed — live, every SEEK digest posting (#1248). Like a URL the owner
				// pastes (manual intake), it waits for the browser check untitled rather than being dropped.
				candidate = candidateFor(message, job.url, undefined, null);
				gap = r.awaitingBrowser.reason;
				evidence = `a ${safeHost(job.url)} posting identified by its id; the job board's page could not be read here (${gap.replace(/_/g, " ")}), and the email's link text does not name it`;
			} else {
				const why = "it is not on a job board the server can check";
				notTaken("posting_unverifiable", `Could not identify this job: ${why}, and the email's link text does not name it. Open the posting and add it with job_lead_intake_url if you want it.`, why);
				continue;
			}
			const out = await store(candidate, gap, { fromDigest: true });
			if (out.kind === "rejected") {
				notTaken(out.rejection, rejectionReason(out.rejection), out.evidence, candidate.title, candidate.company ?? null);
				continue;
			}
			const e = outcomeEntry(out, candidate, gap, evidence, true);
			if (e.decision === "added") counts.added++;
			else if (e.decision === "awaiting_browser_verification") counts.awaiting++;
			else counts.deduped++;
			sub(i, { ...e, job: { title: candidate.title, company: candidate.company ?? null, url: candidate.url } });
		}
		const more = all.length - jobs.length;
		const decision: ScanLogEntry["decision"] = counts.added ? "added" : counts.awaiting ? "awaiting_browser_verification" : counts.deduped && !counts.notTaken ? "deduped" : "rejected";
		const summary = [`${counts.added} added`, counts.awaiting ? `${counts.awaiting} awaiting browser verification` : "", `${counts.deduped} already leads`, `${counts.notTaken} not taken`].filter(Boolean).join(", ");
		log.push({
			seq,
			subIndex: null,
			...fields,
			classification: "digest",
			evidence: [rejectionEvidence(message, kind, maxAgeMs), `${all.length} job${all.length === 1 ? "" : "s"} named in it`, more ? `${more} beyond the first ${DIGEST_POSTINGS_MAX} not checked` : "", unresolved ? `${unresolved} provider tracking link(s) not followed (a digest's redirects are never resolved)` : ""].filter(Boolean).join("; "),
			decision,
			rejection: null,
			reason: `A digest listing ${jobs.length} job${jobs.length === 1 ? "" : "s"}: each was checked on its own (${summary}) — see each job below.`,
			leadId: null,
			job: null,
		});
		log.push(...subs);
		return true;
	}
}

type StoreOutcome = { kind: "added"; leadId: string | null } | { kind: "deduped"; leadId: string | null; on: "gmail_message" | "job" } | { kind: "concurrent"; leadId: string | null } | { kind: "rejected"; rejection: GmailScoutRejection; evidence: string };

/** The log row for a stored candidate's outcome (everything but its job). */
function outcomeEntry(out: Exclude<StoreOutcome, { kind: "rejected" }>, candidate: ScoutCandidate, serverGap: ServerCheckGap | null, via: string, fromDigest = false): Pick<ScanLogEntry, "classification" | "evidence" | "decision" | "rejection" | "reason" | "leadId"> {
	if (out.kind === "deduped") {
		const id = out.leadId;
		return { classification: "duplicate", evidence: out.on === "gmail_message" ? "the same Gmail message is already a lead" : `the same job (${candidate.url}) is already a lead`, decision: "deduped", rejection: null, reason: `Already a lead${id ? ` (${id})` : ""} — ${out.on === "gmail_message" ? "this email was taken before" : "another email named the same job"}, so it was not added twice.`, leadId: id };
	}
	if (out.kind === "concurrent") {
		return { classification: "duplicate", evidence: "the Scout already held this lead when it was saved (a concurrent scan)", decision: "deduped", rejection: null, reason: `Already a lead${out.leadId ? ` (${out.leadId})` : ""}, so it was not added twice.`, leadId: out.leadId };
	}
	return {
		classification: "single_posting",
		evidence: via,
		decision: serverGap ? "awaiting_browser_verification" : "added",
		rejection: null,
		reason: serverGap
			? `Added as a lead waiting for browser verification: the posting was found but the server could not check it (${serverGap.replace(/_/g, " ")}).`
			: `Added as an unverified lead: ${fromDigest ? "one job from this digest" : "one specific job posting"}. It still needs checking live before any application.`,
		leadId: out.leadId,
	};
}



/**
 * The mailbox a scan reads: one search and one read per hit, read-scope only. Injectable so the ONE scan
 * path is tested end to end against a fake mailbox; production uses the owner's connected Gmail.
 */
export interface GmailScoutMailbox {
	list(query: string, max: number): Promise<readonly { id: string }[]>;
	read(id: string): Promise<GmailMessage>;
}
export type GmailScoutMailboxFactory = (env: Env, ctx: { userId: string; instanceId: string }) => Promise<GmailScoutMailbox>;

const gmailMailbox: GmailScoutMailboxFactory = async (env, ctx) => {
	const token = await connectorClient(env, "gmail", ctx).token({ scope: "read" });
	return { list: (query, max) => listMessages(token, query, max), read: (id) => getMessage(token, id, 20_000) };
};
let mailboxForTest: GmailScoutMailboxFactory | null = null;
/** Test seam: route-level tests drive the real scan path with a fake mailbox. Never set in production. */
export function setGmailScoutMailboxForTest(factory: GmailScoutMailboxFactory | null): void {
	mailboxForTest = factory;
}

export interface ScanGmailScoutOptions {
	trigger: GmailScoutScanTrigger;
	/** The owner who asked, for an on-demand scan; null for the schedule. */
	triggeredBy?: string | null;
	mailbox?: GmailScoutMailboxFactory;
}

/**
 * ONE scan, whoever starts it (#1023): the scheduler and an owner's "Scan now" (Console or MCP) both
 * come here, so they cannot drift. It opens a receipt first (single flight: a scan already running for
 * this Scout is returned instead of reading the mailbox twice), then reads, classifies, dedups and
 * stores leads as `unverified` — and hands NOTHING downstream: a lead reaches the Tailor only when the
 * owner explicitly applies it. Every outcome closes the receipt, including a refusal before any read.
 */
/** The guards every mailbox read passes first: email permission, then the one pinned account. */
async function openScoutMailbox(env: Env, instanceId: string, userId: string, pinnedEmail: string | null, factory?: GmailScoutMailboxFactory) {
	if (!(await emailPermitted(env, instanceId))) throw new Error("Email access is not enabled for this Scout.");
	const account = await resolveGmailScoutAccount(env, instanceId, userId, pinnedEmail);
	const mailbox = await (factory ?? mailboxForTest ?? gmailMailbox)(env, { userId, instanceId });
	return { account, mailbox };
}

export async function scanGmailScout(env: Env, instanceId: string, userId: string, options: ScanGmailScoutOptions = { trigger: "on_demand", triggeredBy: userId }): Promise<GmailScoutScanResult> {
	const opened = await openGmailScoutReceipt(env, { instanceId, trigger: options.trigger, triggeredBy: options.trigger === "on_demand" ? (options.triggeredBy ?? userId) : null });
	if (opened.reused) return { mailbox: null, candidates: 0, added: 0, deduped: 0, lastMessageId: null, rejected: {}, receipt: opened.receipt, reused: true, handoff: "none" };
	const receiptId = opened.receipt.id;
	const config = await getGmailScoutConfig(env, instanceId);
	if (!config?.enabled) {
		// A refusal before any read: recorded on the receipt, but not a failing SOURCE in scan state.
		await failGmailScoutReceipt(env, receiptId, "Gmail Scout is not configured or is disabled.");
		throw new Error("Gmail Scout is not configured or is disabled.");
	}
	try {
		// Inside the try (#1022): a mailbox that lost its permission or its connected account is a
		// FAILING source, and must say so — before, it threw unrecorded and read as `failureCount: 0`.
		const { account, mailbox } = await openScoutMailbox(env, instanceId, userId, config.pinnedEmail, options.mailbox);
		const state = await getGmailScoutScanState(env, instanceId);
		const query = gmailScoutQuery(state.lastMessageIdCursor);
		const prior = scanCursor(state.lastMessageIdCursor);
		await recordGmailScoutSearch(env, receiptId, query, { newerThanDays: SCAN_MAX_AGE_MS / 86_400_000, after: prior?.after ?? null, cursorMessageId: prior?.messageId ?? null, maxResults: 25 });
		const hits = await mailbox.list(query, 25);
		const existing = await readGmailScoutLeadRecords(env, instanceId);
		const { candidates, added, deduped, rejected, awaiting, log } = await ingestGmailCandidates({
			hits,
			readMessage: (id) => mailbox.read(id),
			existing,
			mailbox: config.pinnedEmail ?? account.label ?? null,
			insertLead: (data) => insert(env, instanceId, data),
		});
		await writeScanLog(env, receiptId, instanceId, log);
		await queueAwaitingLeads(env, instanceId, userId, awaiting);
		const cursor = JSON.stringify({ after: new Date().toISOString(), messageId: hits[0]?.id ?? null } satisfies ScanCursor);
		await env.DB.prepare(`INSERT INTO gmail_scout_scan_state (instance_id,last_scan_at,last_message_id_cursor,candidate_count,dedupe_count,failure_count,last_failure_at,last_failure_message)
			VALUES (?1,datetime('now'),?2,?3,?4,0,NULL,NULL)
			ON CONFLICT(instance_id) DO UPDATE SET last_scan_at=excluded.last_scan_at,last_message_id_cursor=excluded.last_message_id_cursor,candidate_count=excluded.candidate_count,dedupe_count=excluded.dedupe_count,failure_count=0,last_failure_at=NULL,last_failure_message=NULL`).bind(instanceId, cursor, candidates, deduped).run();
		const receipt = await completeGmailScoutReceipt(env, receiptId, { hits: hits.length, candidates, added, deduped, rejected, lastMessageId: hits[0]?.id ?? null, awaitingBrowserVerification: awaiting.length });
		await pruneGmailScoutReceipts(env, instanceId);
		await pruneScanLog(env, instanceId);
		return { mailbox: account.label ?? account.accountId, candidates, added, deduped, lastMessageId: hits[0]?.id ?? null, rejected, receipt, reused: false, handoff: "none" };
	} catch (error) {
		const message = error instanceof Error ? clipMarked(error.message, 500, { within: true }) : "Gmail scan failed";
		await env.DB.prepare(`INSERT INTO gmail_scout_scan_state (instance_id,failure_count,last_failure_at,last_failure_message)
			VALUES (?1,1,datetime('now'),?2) ON CONFLICT(instance_id) DO UPDATE SET failure_count=failure_count+1,last_failure_at=datetime('now'),last_failure_message=excluded.last_failure_message`).bind(instanceId, message).run();
		await failGmailScoutReceipt(env, receiptId, message);
		await pruneGmailScoutReceipts(env, instanceId);
		throw error;
	}
}

/** #1030: each lead the server could not check is queued for the Scout's browser (and its #1049 consent gate). */
async function queueAwaitingLeads(env: Env, instanceId: string, userId: string, awaiting: readonly AwaitingBrowserLead[]): Promise<void> {
	for (const a of awaiting) {
		await enqueueBrowserVerification(env, { instanceId, userId, leadId: a.leadId, workKey: a.workKey, canonicalUrl: a.canonicalUrl, expectedTitle: a.title, expectedCompany: a.company, reason: a.reason });
	}
}

/** What to reprocess (#1052): messages the owner picked, OR a bounded date window — never both. */
export type GmailScoutReprocessInput = { messageIds: string[] } | { after: string; before?: string };

const GMAIL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Validate a reprocess request against its bounds; the error is the owner-facing reason. */
export function parseReprocessInput(body: { messageIds?: unknown; after?: unknown; before?: unknown }, now = Date.now()): { ok: true; input: GmailScoutReprocessInput } | { ok: false; error: string } {
	const hasIds = body.messageIds !== undefined, hasWindow = body.after !== undefined || body.before !== undefined;
	if (hasIds === hasWindow) return { ok: false, error: "Give either messageIds or an after/before window, not both and not neither." };
	if (hasIds) {
		const ids = body.messageIds;
		if (!Array.isArray(ids) || ids.length === 0 || ids.length > REPROCESS_MAX_MESSAGES || !ids.every((id) => typeof id === "string" && GMAIL_ID_RE.test(id))) {
			return { ok: false, error: `messageIds must be 1-${REPROCESS_MAX_MESSAGES} Gmail message ids.` };
		}
		return { ok: true, input: { messageIds: [...new Set(ids as string[])] } };
	}
	const after = typeof body.after === "string" ? Date.parse(body.after) : Number.NaN;
	const before = body.before === undefined ? now : typeof body.before === "string" ? Date.parse(body.before) : Number.NaN;
	if (!Number.isFinite(after) || !Number.isFinite(before)) return { ok: false, error: "after and before must be ISO dates." };
	if (after >= before) return { ok: false, error: "after must be earlier than before." };
	if (after < now - REPROCESS_MAX_AGE_MS) return { ok: false, error: `A reprocess window reaches back at most ${REPROCESS_MAX_AGE_MS / 86_400_000} days.` };
	return { ok: true, input: { after: new Date(after).toISOString(), before: new Date(Math.min(before, now)).toISOString() } };
}

/** The Gmail search for a reprocess window: the scan's own alert filter, bounded by epoch seconds. */
export function gmailScoutReprocessQuery(window: { after: string; before?: string }): string {
	const secs = (iso: string) => Math.floor(Date.parse(iso) / 1000);
	return `${JOB_ALERT_FILTER} after:${secs(window.after)}${window.before ? ` before:${secs(window.before)}` : ""}`;
}


/**
 * Reprocess historical job mail (#1052). Once the scan cursor has moved past a message, nothing reads
 * it again; this reads the messages the owner names, or a window of at most 30 days and 25 messages,
 * through the SAME intake as a scan — digest, multi-listing, canonical-direct-link and provider (#1050)
 * rules, message + job dedupe, and the #1030/#1049 browser-verification queue — with only the age bound
 * widened. It differs from a scan in three ways: it never moves the scan cursor or scan state; it
 * refuses any job that already has an application (so an attempted or uncertain submission is never
 * replayed); and each lead records that it was reprocessed, beside its original Gmail provenance.
 * Leads are stored unverified or awaiting browser verification exactly as a scan stores them, so only
 * a verified-active lead can reach the Tailor. Shares the scan's single-flight receipt.
 */
export async function reprocessGmailScout(env: Env, instanceId: string, userId: string, input: GmailScoutReprocessInput, options: { mailbox?: GmailScoutMailboxFactory } = {}): Promise<GmailScoutScanResult> {
	const opened = await openGmailScoutReceipt(env, { instanceId, trigger: "reprocess", triggeredBy: userId });
	if (opened.reused) return { mailbox: null, candidates: 0, added: 0, deduped: 0, lastMessageId: null, rejected: {}, receipt: opened.receipt, reused: true, handoff: "none" };
	const receiptId = opened.receipt.id;
	try {
		const config = await getGmailScoutConfig(env, instanceId);
		if (!config?.enabled) throw new Error("Gmail Scout is not configured or is disabled.");
		const { account, mailbox } = await openScoutMailbox(env, instanceId, userId, config.pinnedEmail, options.mailbox);
		const query = "messageIds" in input ? null : gmailScoutReprocessQuery(input);
		await recordGmailScoutSearch(env, receiptId, query, "messageIds" in input ? { messageIds: input.messageIds } : { after: input.after, before: input.before ?? null, maxResults: REPROCESS_MAX_MESSAGES });
		const hits = query === null ? (input as { messageIds: string[] }).messageIds.map((id) => ({ id })) : await mailbox.list(query, REPROCESS_MAX_MESSAGES);
		const [existing, applied] = await Promise.all([readGmailScoutLeadRecords(env, instanceId), appliedWorkKeys(env, userId)]);
		const { candidates, added, deduped, rejected, awaiting, log } = await ingestGmailCandidates({
			hits,
			readMessage: (id) => mailbox.read(id),
			existing,
			mailbox: config.pinnedEmail ?? account.label ?? null,
			insertLead: (data) => insert(env, instanceId, data),
			maxAgeMs: REPROCESS_MAX_AGE_MS,
			appliedWorkKeys: applied,
			leadExtras: { materialized_via: { mode: "reprocess", receipt_id: receiptId } },
		});
		await writeScanLog(env, receiptId, instanceId, log);
		await queueAwaitingLeads(env, instanceId, userId, awaiting);
		const lastMessageId = hits[0]?.id ?? null;
		const receipt = await completeGmailScoutReceipt(env, receiptId, { hits: hits.length, candidates, added, deduped, rejected, lastMessageId, awaitingBrowserVerification: awaiting.length });
		await pruneGmailScoutReceipts(env, instanceId);
		await pruneScanLog(env, instanceId);
		return { mailbox: account.label ?? account.accountId, candidates, added, deduped, lastMessageId, rejected, receipt, reused: false, handoff: "none" };
	} catch (error) {
		// Recorded on the receipt only: a reprocess is not the source's health, so scan state is untouched.
		await failGmailScoutReceipt(env, receiptId, error instanceof Error ? clipMarked(error.message, 500, { within: true }) : "Gmail reprocess failed");
		await pruneGmailScoutReceipts(env, instanceId);
		throw error;
	}
}

/**
 * Scan every enabled Gmail Scout that is due (#1022). Before this a Scout scanned only when its owner
 * asked, so one silently stopped finding leads for days. Due = no scan, and no failure, within
 * {@link GMAIL_SCOUT_SCAN_INTERVAL_MS} — a failing source is retried on the same cadence, never every
 * minute. Bounded per tick; each scan records its own success or failure, so this swallows nothing.
 */
export async function runDueGmailScoutScans(env: Env, now = Date.now(), limit = 5, mailbox?: GmailScoutMailboxFactory): Promise<{ scanned: number; failed: number }> {
	await pruneScanLog(env); // #1247: 30-day retention for every Scout, including ones no longer scanning
	const cutoff = Math.floor((now - GMAIL_SCOUT_SCAN_INTERVAL_MS) / 1000);
	const { results } = await env.DB.prepare(
		`SELECT c.instance_id AS instanceId, i.user_id AS userId FROM gmail_scout_configs c
		   JOIN agent_instances i ON i.id = c.instance_id
		   LEFT JOIN gmail_scout_scan_state s ON s.instance_id = c.instance_id
		  WHERE c.enabled = 1 AND i.status = 'active'
		    AND (s.last_scan_at IS NULL OR s.last_scan_at < datetime(?1, 'unixepoch'))
		    AND (s.last_failure_at IS NULL OR s.last_failure_at < datetime(?1, 'unixepoch'))
		  ORDER BY COALESCE(s.last_scan_at, '') LIMIT ?2`,
	)
		.bind(cutoff, limit)
		.all<{ instanceId: string; userId: string }>();
	let scanned = 0, failed = 0;
	for (const due of results ?? []) {
		try {
			await scanGmailScout(env, due.instanceId, due.userId, { trigger: "schedule", mailbox });
			scanned++;
		} catch {
			failed++; // recorded on the Scout's own scan state by scanGmailScout
		}
	}
	return { scanned, failed };
}

export async function gmailScoutStatus(env: Env, instanceId: string, query?: URLSearchParams) {
	const [config, state, leads, receipts] = await Promise.all([getGmailScoutConfig(env, instanceId), getGmailScoutScanState(env, instanceId), readGmailScoutLeadRecords(env, instanceId, query), listGmailScoutReceipts(env, instanceId, 10)]);
	// #1247: each receipt names where its per-message log is read — the same rows by route and by MCP tool.
	const withLog = receipts.map((r) => ({ ...r, scanLog: { path: `/v1/instances/${instanceId}/gmail-scout/scan-log?scan_id=${r.id}`, tool: "gmail_scout_scan_log", scan_id: r.id } }));
	return { config, state, leadCount: leads.length, newLeadCount: leads.filter((r) => (r.data?.status ?? "new") === "new").length, receipts: withLog };
}
