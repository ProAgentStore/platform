/** Read-only Gmail alert ingestion.  Mail text is parsed in-process and never persisted or logged. */
import type { Env } from "../../types.js";
import type { GmailScoutScanResult } from "../../agent-types.js";
import { connectorClient } from "../connectors/client.js";
import { emailPermitted } from "../connectors/gmail.js";
import { getMessage, listMessages, type GmailMessage } from "../gmail.js";
import { canonicalJobUrl, jobIdentity, workKeyForLead } from "../job-lead-triage.js";
import { clipMarked } from "../clip-marked.js";
import { getGmailScoutConfig, getGmailScoutScanState, resolveGmailScoutAccount } from "./config.js";

// A recent alert is an intake clue, not vacancy verification.  We deliberately keep the window
// short and require the Runner's browser preflight before a lead can be treated as live.
const JOB_ALERT_QUERY = "(subject:(job OR jobs OR role OR opportunity OR alert OR recommendation) OR from:(seek.com linkedin.com indeed.com)) newer_than:2d";
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

function recentMessageDate(value: string, now = Date.now()): boolean {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && parsed <= now + 5 * 60_000 && parsed >= now - 2 * 24 * 60 * 60_000;
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
	return { company: metadataLine(company), location: metadataLine(location) };
}

/** Deliberately modest extraction: metadata is visible, body prose is neither stored nor logged. */
export function candidateFromMessage(message: GmailMessage, now = Date.now()): ScoutCandidate | null {
	if (!message.id || !message.subject?.trim() || !message.from?.trim() || !recentMessageDate(message.date, now)) return null;
	if (SECURITY_ALERT_RE.test(`${message.subject}\n${message.from}`)) return null;
	const url = specificJobUrl(message.text) ?? specificJobUrl(message.snippet);
	if (!url || !workKeyForLead({ url })) return null;
	const host = new URL(url).hostname.toLowerCase();
	const subject = clipMarked(message.subject, 300, { within: true });
	const sender = clipMarked(message.from, 300, { within: true });
	const receivedAt = clipMarked(message.date, 100, { within: true });
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
		...extractVisibleMetadata(message),
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
async function insert(env: Env, instanceId: string, data: Record<string, unknown>): Promise<boolean> {
	const res = await stub(env, instanceId).fetch(new Request("https://agent/collections/job_leads/records", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data }) }));
	if (!res.ok) throw new Error("Could not save a Gmail job lead.");
	return (await res.json() as { created?: unknown }).created !== false;
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
	/** `false` means the owning Scout returned an existing unchanged lead (a concurrent duplicate). */
	insertLead: (data: Record<string, unknown>) => Promise<boolean | void>;
}): Promise<{ candidates: number; added: number; deduped: number }> {
	let added = 0, deduped = 0, candidates = 0;
	for (const hit of input.hits) {
		const candidate = candidateFromMessage(await input.readMessage(hit.id));
		if (!candidate) continue;
		candidates++;
		if (duplicateGmailLead(candidate, input.existing)) { deduped++; continue; }
		const workKey = workKeyForLead(candidate);
		if (!workKey) continue;
		const data = {
			...candidate,
			work_key: workKey,
			status: "unverified",
			lifecycle_version: 0,
			verification: { state: "unverified", source: "gmail_alert", checked_at: null, canonical_job_url: candidate.url, active_apply_url: null, reason: "email_alert_requires_live_validation", evidence: null },
		};
		const created = await input.insertLead(data);
		if (created === false) { deduped++; continue; }
		input.existing.push({ data });
		added++;
	}
	return { candidates, added, deduped };
}

export async function scanGmailScout(env: Env, instanceId: string, userId: string): Promise<GmailScoutScanResult> {
	const config = await getGmailScoutConfig(env, instanceId);
	if (!config?.enabled) throw new Error("Gmail Scout is not configured or is disabled.");
	if (!(await emailPermitted(env, instanceId))) throw new Error("Email access is not enabled for this Scout.");
	const account = await resolveGmailScoutAccount(env, instanceId, userId, config.pinnedEmail);
	try {
		const token = await connectorClient(env, "gmail", { userId, instanceId }).token({ scope: "read" });
		const state = await getGmailScoutScanState(env, instanceId);
		const hits = await listMessages(token, gmailScoutQuery(state.lastMessageIdCursor), 25);
		const existing = await readGmailScoutLeadRecords(env, instanceId);
		const { candidates, added, deduped } = await ingestGmailCandidates({
			hits,
			readMessage: (id) => getMessage(token, id, 20_000),
			existing,
			insertLead: (data) => insert(env, instanceId, data),
		});
		const cursor = JSON.stringify({ after: new Date().toISOString(), messageId: hits[0]?.id ?? null } satisfies ScanCursor);
		await env.DB.prepare(`INSERT INTO gmail_scout_scan_state (instance_id,last_scan_at,last_message_id_cursor,candidate_count,dedupe_count,failure_count,last_failure_at,last_failure_message)
			VALUES (?1,datetime('now'),?2,?3,?4,0,NULL,NULL)
			ON CONFLICT(instance_id) DO UPDATE SET last_scan_at=excluded.last_scan_at,last_message_id_cursor=excluded.last_message_id_cursor,candidate_count=excluded.candidate_count,dedupe_count=excluded.dedupe_count,failure_count=0,last_failure_at=NULL,last_failure_message=NULL`).bind(instanceId, cursor, candidates, deduped).run();
		return { mailbox: account.label ?? account.accountId, candidates, added, deduped, lastMessageId: hits[0]?.id ?? null };
	} catch (error) {
		const message = error instanceof Error ? clipMarked(error.message, 500, { within: true }) : "Gmail scan failed";
		await env.DB.prepare(`INSERT INTO gmail_scout_scan_state (instance_id,failure_count,last_failure_at,last_failure_message)
			VALUES (?1,1,datetime('now'),?2) ON CONFLICT(instance_id) DO UPDATE SET failure_count=failure_count+1,last_failure_at=datetime('now'),last_failure_message=excluded.last_failure_message`).bind(instanceId, message).run();
		throw error;
	}
}

export async function gmailScoutStatus(env: Env, instanceId: string, query?: URLSearchParams) {
	const [config, state, leads] = await Promise.all([getGmailScoutConfig(env, instanceId), getGmailScoutScanState(env, instanceId), readGmailScoutLeadRecords(env, instanceId, query)]);
	return { config, state, leadCount: leads.length, newLeadCount: leads.filter((r) => (r.data?.status ?? "new") === "new").length };
}
