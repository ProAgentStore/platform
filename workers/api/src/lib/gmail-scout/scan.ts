/** Read-only Gmail alert ingestion.  Mail text is parsed in-process and never persisted or logged. */
import type { Env } from "../../types.js";
import type { GmailScoutScanResult } from "../../agent-types.js";
import { connectorClient } from "../connectors/client.js";
import { emailPermitted } from "../connectors/gmail.js";
import { getMessage, listMessages, type GmailMessage } from "../gmail.js";
import { canonicalJobUrl, jobIdentity, workKeyForLead } from "../job-lead-triage.js";
import { clipMarked } from "../clip-marked.js";
import { GMAIL_SCOUT_SCAN_INTERVAL_MS, getGmailScoutConfig, getGmailScoutScanState, resolveGmailScoutAccount } from "./config.js";
import { appliedWorkKeys, enqueueBrowserVerification } from "../job-lead-queue.js";
import { providerPostingUrl, resolveProviderJobAlert, type ServerCheckGap } from "./provider-redirect.js";

/** A lead stored `awaiting_browser_verification` (#1030), to be queued for the Scout's browser. */
export interface AwaitingBrowserLead {
	leadId: string;
	workKey: string;
	canonicalUrl: string;
	title: string | null;
	company: string | null;
	reason: ServerCheckGap;
}
import { completeGmailScoutReceipt, failGmailScoutReceipt, type GmailScoutRejection, type GmailScoutScanTrigger, listGmailScoutReceipts, openGmailScoutReceipt, pruneGmailScoutReceipts } from "./receipts.js";

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
export type ScoutCandidate = { url: string; title: string; company?: string; location?: string; source: string; source_domain?: string; posted_date?: string; gmail_message_id: string; gmail_subject: string; gmail_from: string; gmail_date: string; gmail_provenance: GmailLeadProvenance };

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
	// Concrete-job-only (#1022): a digest, a summary or a recommendation feed is rejected here, before it
	// can become a lead — never triaged, never handed to the Tailor with a role nobody can verify.
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
	if (DIGEST_SUBJECT_RE.test(subject) || DIGEST_SENDER_RE.test(from)) return "digest";
	const url = typeof data.url === "string" ? canonicalJobUrl(data.url) : null;
	return url && isSpecificJobUrl(url) ? null : "no_specific_job_url";
}

/** The lead a message becomes once its posting URL is known — from the mail itself, or resolved (#1024). */
function candidateFor(message: GmailMessage, url: string, resolvedCompany?: string): ScoutCandidate {
	const host = new URL(url).hostname.toLowerCase();
	const subject = clipMarked(message.subject, 300, { within: true });
	const sender = clipMarked(message.from, 300, { within: true });
	const receivedAt = clipMarked(message.date, 100, { within: true });
	const metadata = extractVisibleMetadata(message);
	return {
		url,
		title: clipMarked(message.subject.trim(), 300, { within: true }) || "Job suggestion",
		source: "Gmail",
		source_domain: host,
		posted_date: message.date || undefined,
		gmail_message_id: message.id,
		gmail_subject: subject,
		gmail_from: sender,
		gmail_date: receivedAt,
		gmail_provenance: { provider: "gmail", message_id: message.id, subject, sender, received_at: receivedAt, source_domain: host },
		...metadata,
		company: metadata.company ?? resolvedCompany,
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
	const body = await res.json() as { records?: Array<{ data?: Record<string, unknown> }> };
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
	const identity = jobIdentity({ url: candidate.url });
	return existing.some((record) =>
		record.data?.gmail_message_id === candidate.gmail_message_id ||
		(Boolean(identity) && jobIdentity(record.data ?? {}) === identity),
	);
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
	existing: { data?: Record<string, unknown> }[];
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
}): Promise<{ candidates: number; added: number; deduped: number; rejected: Partial<Record<GmailScoutRejection, number>>; awaiting: AwaitingBrowserLead[] }> {
	let added = 0, deduped = 0, candidates = 0;
	const awaiting: AwaitingBrowserLead[] = [];
	const rejected: Partial<Record<GmailScoutRejection, number>> = {};
	for (const hit of input.hits) {
		const message = await input.readMessage(hit.id);
		let classified: ReturnType<typeof classifyGmailMessage> = classifyGmailMessage(message, Date.now(), input.maxAgeMs);
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
			} else if (resolved) classified = "rejected" in resolved ? resolved : { candidate: candidateFor(message, resolved.url, resolved.company) };
		}
		if ("rejected" in classified) {
			rejected[classified.rejected] = (rejected[classified.rejected] ?? 0) + 1;
			continue;
		}
		const candidate = classified.candidate;
		candidates++;
		if (duplicateGmailLead(candidate, input.existing)) { deduped++; continue; }
		const workKey = workKeyForLead(candidate);
		if (!workKey) {
			rejected.no_work_key = (rejected.no_work_key ?? 0) + 1;
			continue;
		}
		// An application already exists for this job — attempted, uncertain or otherwise. Its lead may be
		// gone, but a fresh one must never let the same posting be applied for again (#1052, #1013).
		if (input.appliedWorkKeys?.has(workKey)) {
			rejected.prior_application = (rejected.prior_application ?? 0) + 1;
			continue;
		}
		const data = {
			...input.leadExtras,
			...candidate,
			work_key: workKey,
			status: serverGap ? "awaiting_browser_verification" : "unverified",
			lifecycle_version: 0,
			verification: serverGap
				? { state: "awaiting_browser_verification", source: "gmail_alert", checked_at: null, canonical_job_url: candidate.url, active_apply_url: null, reason: serverGap, evidence: null, attempts: 0 }
				: { state: "unverified", source: "gmail_alert", checked_at: null, canonical_job_url: candidate.url, active_apply_url: null, reason: "email_alert_requires_live_validation", evidence: null },
		};
		const inserted = await input.insertLead(data);
		const created = typeof inserted === "object" ? inserted.created : inserted;
		if (created === false) { deduped++; continue; }
		input.existing.push({ data });
		added++;
		if (serverGap && typeof inserted === "object" && inserted.id) {
			awaiting.push({ leadId: inserted.id, workKey, canonicalUrl: candidate.url, title: data.title ?? null, company: data.company ?? null, reason: serverGap });
		}
	}
	return { candidates, added, deduped, rejected, awaiting };
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
		const hits = await mailbox.list(gmailScoutQuery(state.lastMessageIdCursor), 25);
		const existing = await readGmailScoutLeadRecords(env, instanceId);
		const { candidates, added, deduped, rejected, awaiting } = await ingestGmailCandidates({
			hits,
			readMessage: (id) => mailbox.read(id),
			existing,
			insertLead: (data) => insert(env, instanceId, data),
		});
		await queueAwaitingLeads(env, instanceId, userId, awaiting);
		const cursor = JSON.stringify({ after: new Date().toISOString(), messageId: hits[0]?.id ?? null } satisfies ScanCursor);
		await env.DB.prepare(`INSERT INTO gmail_scout_scan_state (instance_id,last_scan_at,last_message_id_cursor,candidate_count,dedupe_count,failure_count,last_failure_at,last_failure_message)
			VALUES (?1,datetime('now'),?2,?3,?4,0,NULL,NULL)
			ON CONFLICT(instance_id) DO UPDATE SET last_scan_at=excluded.last_scan_at,last_message_id_cursor=excluded.last_message_id_cursor,candidate_count=excluded.candidate_count,dedupe_count=excluded.dedupe_count,failure_count=0,last_failure_at=NULL,last_failure_message=NULL`).bind(instanceId, cursor, candidates, deduped).run();
		const receipt = await completeGmailScoutReceipt(env, receiptId, { hits: hits.length, candidates, added, deduped, rejected, lastMessageId: hits[0]?.id ?? null, awaitingBrowserVerification: awaiting.length });
		await pruneGmailScoutReceipts(env, instanceId);
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
		const hits = "messageIds" in input ? input.messageIds.map((id) => ({ id })) : await mailbox.list(gmailScoutReprocessQuery(input), REPROCESS_MAX_MESSAGES);
		const [existing, applied] = await Promise.all([readGmailScoutLeadRecords(env, instanceId), appliedWorkKeys(env, userId)]);
		const { candidates, added, deduped, rejected, awaiting } = await ingestGmailCandidates({
			hits,
			readMessage: (id) => mailbox.read(id),
			existing,
			insertLead: (data) => insert(env, instanceId, data),
			maxAgeMs: REPROCESS_MAX_AGE_MS,
			appliedWorkKeys: applied,
			leadExtras: { materialized_via: { mode: "reprocess", receipt_id: receiptId } },
		});
		await queueAwaitingLeads(env, instanceId, userId, awaiting);
		const lastMessageId = hits[0]?.id ?? null;
		const receipt = await completeGmailScoutReceipt(env, receiptId, { hits: hits.length, candidates, added, deduped, rejected, lastMessageId, awaitingBrowserVerification: awaiting.length });
		await pruneGmailScoutReceipts(env, instanceId);
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
	return { config, state, leadCount: leads.length, newLeadCount: leads.filter((r) => (r.data?.status ?? "new") === "new").length, receipts };
}
