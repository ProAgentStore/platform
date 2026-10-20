/**
 * The per-item decision log of a Gmail Scout scan (#1247).
 *
 * A receipt (#1023) counts rejections by category, so a Scout could add no leads for days while its
 * receipts said `rejected: {digest: N}` and nothing an owner could check. This records, for every
 * message a scan matched, which email it was (ids and a link that opens it), what was read, what the
 * Scout took it for and on what evidence, what it decided and why — and, for a digest, one row per job
 * listed inside it.
 *
 * Metadata and short snippets only: sender, subject, date, Gmail's own snippet (≤500 chars), counts of
 * what was read, and canonical posting URLs. Never the body, never a personal tracking link. Owner-only
 * through the gmail-scout routes; rows older than {@link SCAN_LOG_RETENTION_DAYS} days are pruned.
 */
import type { Env } from "../../types.js";
import { clipMarked } from "../clip-marked.js";
import { instanceDataLink } from "../console-links.js";
import { CONSOLE_ORIGIN } from "../console-deep-link.js";
import { gmailMessageUrl, type GmailMessage } from "../gmail.js";
import { getGmailScoutReceipt, type GmailScoutRejection, type GmailScoutScanReceipt, listGmailScoutReceipts } from "./receipts.js";

/** What the Scout took a message (or a digest's job) for. */
export type ScanLogClassification = "single_posting" | "digest" | "non_job" | "duplicate" | "too_old" | "digest_item";
export type ScanLogDecision = "added" | "awaiting_browser_verification" | "deduped" | "rejected";

/** What the scan read of one message: which parts, and what it found in them. Counts, never content. */
export interface ScanLogRead {
	parts: string[];
	bodyChars: number;
	linksFound: number;
	jobPostingsDetected: number;
}

/** One row as the scan produces it: a message (`subIndex` null) or one job inside a digest (1..n). */
export interface ScanLogEntry {
	seq: number;
	subIndex: number | null;
	messageId: string | null;
	threadId: string | null;
	gmailLink: string | null;
	sender: string | null;
	subject: string | null;
	receivedAt: string | null;
	snippet: string | null;
	read: ScanLogRead | null;
	classification: ScanLogClassification;
	evidence: string | null;
	decision: ScanLogDecision;
	rejection: GmailScoutRejection | null;
	reason: string;
	leadId: string | null;
	job: { title: string | null; company: string | null; url: string | null } | null;
}

/** One logged row as read back, with the console link to its lead. */
export type ScanLogItem = Omit<ScanLogEntry, "seq" | "subIndex"> & { seq: number; leadUrl: string | null; subItems?: ScanLogItem[] };

export const SCAN_LOG_RETENTION_DAYS = 30;
export const SCAN_LOG_SNIPPET_MAX = 500;
/** Jobs logged from one digest, at most; the message row says how many more were listed. */
export const DIGEST_ITEMS_MAX = 25;
const PAGE_DEFAULT = 25, PAGE_MAX = 100;

/** What each rejection means about the message, and in the owner's words, why it is not a lead. */
const REJECTION: Record<GmailScoutRejection, { classification: ScanLogClassification; reason: string }> = {
	missing_fields: { classification: "non_job", reason: "The email has no subject, sender or id to identify it, so it cannot be a lead." },
	stale: { classification: "too_old", reason: "The email is older than this scan accepts; an old alert is not a reliable sign the job is still open." },
	security_alert: { classification: "non_job", reason: "This is account or security mail (sign-in, verification, password), not a job alert." },
	digest: { classification: "digest", reason: "This is a digest or recommendation email listing several jobs. The Scout takes only single-posting alerts (#1022); each listed job is logged below with its own decision." },
	multiple_listings: { classification: "digest", reason: "The email links to more than one distinct job, so no single posting could be taken from it. Each job found is logged below." },
	no_specific_job_url: { classification: "non_job", reason: "No link in the email points at one specific job posting (only search, listing, account or navigation links)." },
	no_work_key: { classification: "single_posting", reason: "The posting link could not be reduced to a stable job identity, so it could not be deduplicated or tracked." },
	redirect_unresolved: { classification: "single_posting", reason: "The job link only works through the provider's tracking redirect, and following it did not reach one posting." },
	posting_not_live: { classification: "single_posting", reason: "The posting the email points at is no longer live (removed, expired, or redirected away)." },
	posting_unverifiable: { classification: "single_posting", reason: "The posting page could not be checked." },
	posting_mismatch: { classification: "single_posting", reason: "The live posting's title or company does not match what the email says, so it may be a different job." },
	prior_application: { classification: "single_posting", reason: "You already have an application for this job, so it is not added again." },
};

export const rejectionClassification = (r: GmailScoutRejection): ScanLogClassification => REJECTION[r].classification;
export const rejectionReason = (r: GmailScoutRejection): string => REJECTION[r].reason;

const clip = (v: string | null | undefined, n: number) => (v ? clipMarked(v.replace(/\s+/g, " ").trim(), n, { within: true }) : null);

/** The identifying metadata of a message, bounded — the part of every message row that says WHICH email. */
export function messageFields(message: GmailMessage, mailbox: string | null, read: ScanLogRead): Pick<ScanLogEntry, "messageId" | "threadId" | "gmailLink" | "sender" | "subject" | "receivedAt" | "snippet" | "read"> {
	return {
		messageId: message.id || null,
		threadId: message.threadId || null,
		gmailLink: message.id ? gmailMessageUrl(message.id, mailbox) : null,
		sender: clip(message.from, 300),
		subject: clip(message.subject, 300),
		receivedAt: clip(message.date, 100),
		snippet: clip(message.snippet, SCAN_LOG_SNIPPET_MAX),
		read,
	};
}

/** Write one scan's rows. Best-effort like the receipt prune: a lost log row must never fail the scan. */
export async function writeScanLog(env: Pick<Env, "DB">, receiptId: string, instanceId: string, entries: readonly ScanLogEntry[]): Promise<void> {
	const stmts = entries.map((e) =>
		env.DB.prepare(
			`INSERT INTO gmail_scout_scan_log_items (id, receipt_id, instance_id, seq, sub_index, message_id, thread_id, gmail_link, sender, subject, received_at, snippet, read_summary, classification, evidence, decision, rejection, reason, lead_id, job_title, job_company, job_url)
			 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)`,
		).bind(
			crypto.randomUUID(), receiptId, instanceId, e.seq, e.subIndex, e.messageId, e.threadId, e.gmailLink, e.sender, e.subject, e.receivedAt, e.snippet,
			e.read ? JSON.stringify(e.read) : null, e.classification, clip(e.evidence, 500), e.decision, e.rejection, clip(e.reason, 500) ?? "", e.leadId,
			clip(e.job?.title, 200), clip(e.job?.company, 160), e.job?.url ?? null,
		),
	);
	for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50)).catch(() => undefined);
}

/** Delete rows past retention — one instance's after its scan, or every instance's from the scheduler. */
export async function pruneScanLog(env: Pick<Env, "DB">, instanceId?: string): Promise<void> {
	const cutoff = `-${SCAN_LOG_RETENTION_DAYS} days`;
	const stmt = instanceId
		? env.DB.prepare("DELETE FROM gmail_scout_scan_log_items WHERE instance_id = ?1 AND created_at < datetime('now', ?2)").bind(instanceId, cutoff)
		: env.DB.prepare("DELETE FROM gmail_scout_scan_log_items WHERE created_at < datetime('now', ?1)").bind(cutoff);
	await stmt.run().catch(() => undefined);
}

function asItem(r: Record<string, unknown>, instanceId: string): ScanLogItem {
	const s = (v: unknown) => (typeof v === "string" && v ? v : null);
	let read: ScanLogRead | null = null;
	try {
		read = r.read_summary ? (JSON.parse(String(r.read_summary)) as ScanLogRead) : null;
	} catch {
		read = null;
	}
	const leadId = s(r.lead_id);
	const job = s(r.job_title) || s(r.job_company) || s(r.job_url) ? { title: s(r.job_title), company: s(r.job_company), url: s(r.job_url) } : null;
	return {
		seq: Number(r.seq), messageId: s(r.message_id), threadId: s(r.thread_id), gmailLink: s(r.gmail_link), sender: s(r.sender), subject: s(r.subject), receivedAt: s(r.received_at),
		snippet: s(r.snippet), read, classification: r.classification as ScanLogClassification, evidence: s(r.evidence), decision: r.decision as ScanLogDecision,
		rejection: s(r.rejection) as GmailScoutRejection | null, reason: String(r.reason ?? ""), leadId, leadUrl: leadId ? `${CONSOLE_ORIGIN}${instanceDataLink(instanceId)}` : null, job,
	};
}

export interface ScanLogPage {
	scan: GmailScoutScanReceipt | null;
	/** One entry per matched message, in the order the scan read them; a digest's jobs ride as `subItems`. */
	items: ScanLogItem[];
	/** Messages logged for this scan in all. */
	total: number;
	/** Pass back as `cursor` for the next page; null on the last. */
	nextCursor: string | null;
}

/**
 * One page of a scan's log — the scan named, or this instance's newest when `scanId` is omitted. A scan
 * id from another instance reads as no scan: the caller is already proven the owner of `instanceId`.
 */
export async function readScanLog(env: Pick<Env, "DB">, instanceId: string, opts: { scanId?: string | null; cursor?: string | null; limit?: number } = {}): Promise<ScanLogPage> {
	const scan = opts.scanId ? await getGmailScoutReceipt(env, opts.scanId) : ((await listGmailScoutReceipts(env, instanceId, 1))[0] ?? null);
	if (!scan || scan.instanceId !== instanceId) return { scan: null, items: [], total: 0, nextCursor: null };
	const limit = Math.min(Math.max(Math.trunc(opts.limit ?? PAGE_DEFAULT) || PAGE_DEFAULT, 1), PAGE_MAX);
	const after = Number.parseInt(opts.cursor ?? "", 10);
	const from = Number.isFinite(after) ? after : -1;
	const [rows, count] = await Promise.all([
		env.DB.prepare("SELECT * FROM gmail_scout_scan_log_items WHERE receipt_id = ?1 AND sub_index IS NULL AND seq > ?2 ORDER BY seq LIMIT ?3").bind(scan.id, from, limit + 1).all<Record<string, unknown>>(),
		env.DB.prepare("SELECT COUNT(*) AS n FROM gmail_scout_scan_log_items WHERE receipt_id = ?1 AND sub_index IS NULL").bind(scan.id).first<{ n: number }>(),
	]);
	const page = (rows.results ?? []).filter((_, i) => i < limit).map((r) => asItem(r, instanceId));
	const more = (rows.results ?? []).length > limit;
	if (page.length) {
		const subs = await env.DB.prepare("SELECT * FROM gmail_scout_scan_log_items WHERE receipt_id = ?1 AND sub_index IS NOT NULL AND seq BETWEEN ?2 AND ?3 ORDER BY seq, sub_index")
			.bind(scan.id, page[0].seq, page[page.length - 1].seq)
			.all<Record<string, unknown>>();
		for (const r of subs.results ?? []) {
			const parent = page.find((p) => p.seq === Number(r.seq));
			if (!parent) continue;
			parent.subItems = [...(parent.subItems ?? []), asItem(r, instanceId)];
		}
	}
	return { scan, items: page, total: Number(count?.n ?? 0), nextCursor: more ? String(page[page.length - 1].seq) : null };
}
