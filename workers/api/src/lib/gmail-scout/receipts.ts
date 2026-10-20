/**
 * Durable, non-secret receipts for Gmail Scout scans (#1023), scheduled or on demand.
 *
 * Imports nothing from `scan.ts`, so pipeline health can read the latest receipt without a cycle.
 * A receipt carries counts, rejection reasons by category, and the exact Gmail query and window the scan
 * searched (#1247) — never mail content or tokens. What it decided per message is the scan log
 * (`scan-log.ts`): metadata and short snippets only, no message bodies.
 */
import type { Env } from "../../types.js";

export type GmailScoutScanTrigger = "schedule" | "on_demand" | "reprocess";
export type GmailScoutReceiptStatus = "running" | "completed" | "failed";

/** Why a message examined by a scan did not become a lead. Categories only — never the message. */
export type GmailScoutRejection = "missing_fields" | "stale" | "security_alert" | "digest" | "multiple_listings" | "no_specific_job_url" | "no_work_key" | "redirect_unresolved" | "posting_not_live" | "posting_unverifiable" | "posting_mismatch" | "prior_application";

export interface GmailScoutScanReceipt {
	id: string;
	instanceId: string;
	trigger: GmailScoutScanTrigger;
	triggeredBy: string | null;
	status: GmailScoutReceiptStatus;
	startedAt: string;
	completedAt: string | null;
	hits: number | null;
	candidates: number | null;
	added: number | null;
	deduped: number | null;
	rejected: Partial<Record<GmailScoutRejection, number>>;
	/** Leads added that the server could not check and that wait for browser verification (#1030). */
	awaitingBrowserVerification: number | null;
	errorMessage: string | null;
	lastMessageId: string | null;
	/** The exact Gmail search this scan ran (#1247); null for a reprocess of named messages, or before it searched. */
	query: string | null;
	/** The window it covered (#1247): the cursor date and age bound, a reprocess window, or the named message ids. */
	window: Record<string, unknown> | null;
	/** A scan never hands anything to the Tailor or Runner; leads wait for an explicit apply. */
	handoff: "none";
}

/** A running receipt older than this is treated as abandoned (the Worker died mid-scan), not as in flight. */
export const RUNNING_RECEIPT_TTL_MS = 5 * 60_000;
/** Receipts kept per instance however old; older ones are pruned when a scan finishes — but never one
 *  younger than {@link RECEIPTS_KEPT_DAYS} days, which is as long as its scan log is kept (#1247). */
export const RECEIPTS_KEPT = 50;
export const RECEIPTS_KEPT_DAYS = 30;

const utcIso = (v: unknown): string | null => (typeof v === "string" && v ? new Date(v.includes("T") ? v : `${v.replace(" ", "T")}Z`).toISOString() : null);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function parseWindow(v: unknown): Record<string, unknown> | null {
	try {
		const parsed = v ? JSON.parse(String(v)) : null;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function asReceipt(r: Record<string, unknown>): GmailScoutScanReceipt {
	let rejected: GmailScoutScanReceipt["rejected"] = {};
	try {
		const parsed = r.rejected ? JSON.parse(String(r.rejected)) : {};
		if (parsed && typeof parsed === "object") rejected = parsed;
	} catch {
		rejected = {};
	}
	return {
		id: String(r.id), instanceId: String(r.instance_id), trigger: r.scan_trigger as GmailScoutScanTrigger, triggeredBy: r.triggered_by ? String(r.triggered_by) : null,
		status: r.status as GmailScoutReceiptStatus, startedAt: utcIso(r.started_at) ?? "", completedAt: utcIso(r.completed_at),
		hits: num(r.hits), candidates: num(r.candidates), added: num(r.added), deduped: num(r.deduped), rejected, awaitingBrowserVerification: num(r.awaiting_browser_verification),
		errorMessage: r.error_message ? String(r.error_message) : null, lastMessageId: r.last_message_id ? String(r.last_message_id) : null,
		query: r.search_query ? String(r.search_query) : null, window: parseWindow(r.search_window), handoff: "none",
	};
}

export async function getGmailScoutReceipt(env: Pick<Env, "DB">, id: string): Promise<GmailScoutScanReceipt | null> {
	const r = await env.DB.prepare("SELECT * FROM gmail_scout_scan_receipts WHERE id = ?1").bind(id).first<Record<string, unknown>>();
	return r ? asReceipt(r) : null;
}

export async function listGmailScoutReceipts(env: Pick<Env, "DB">, instanceId: string, limit = 10): Promise<GmailScoutScanReceipt[]> {
	const { results } = await env.DB.prepare("SELECT * FROM gmail_scout_scan_receipts WHERE instance_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2").bind(instanceId, limit).all<Record<string, unknown>>();
	return (results ?? []).map(asReceipt);
}

/**
 * Open a receipt for a new scan — unless one for this instance is already running (single flight,
 * #1023): a double click or a retried MCP call returns THAT receipt instead of reading the mailbox twice.
 * The insert is conditional, so two requests racing cannot both open one.
 */
export async function openGmailScoutReceipt(env: Pick<Env, "DB">, input: { instanceId: string; trigger: GmailScoutScanTrigger; triggeredBy: string | null; now?: number }): Promise<{ receipt: GmailScoutScanReceipt; reused: boolean }> {
	const now = input.now ?? Date.now();
	const fresh = Math.floor((now - RUNNING_RECEIPT_TTL_MS) / 1000);
	const id = crypto.randomUUID();
	const res = await env.DB.prepare(
		`INSERT INTO gmail_scout_scan_receipts (id, instance_id, scan_trigger, triggered_by, status)
		 SELECT ?1, ?2, ?3, ?4, 'running'
		  WHERE NOT EXISTS (SELECT 1 FROM gmail_scout_scan_receipts WHERE instance_id = ?2 AND status = 'running' AND started_at >= datetime(?5, 'unixepoch'))`,
	)
		.bind(id, input.instanceId, input.trigger, input.triggeredBy, fresh)
		.run();
	if ((res.meta?.changes ?? 0) > 0) return { receipt: (await getGmailScoutReceipt(env, id)) as GmailScoutScanReceipt, reused: false };
	const running = await env.DB.prepare("SELECT * FROM gmail_scout_scan_receipts WHERE instance_id = ?1 AND status = 'running' AND started_at >= datetime(?2, 'unixepoch') ORDER BY started_at DESC LIMIT 1")
		.bind(input.instanceId, fresh)
		.first<Record<string, unknown>>();
	return { receipt: asReceipt(running as Record<string, unknown>), reused: true };
}

export async function completeGmailScoutReceipt(env: Pick<Env, "DB">, id: string, r: { hits: number; candidates: number; added: number; deduped: number; rejected: GmailScoutScanReceipt["rejected"]; lastMessageId: string | null; awaitingBrowserVerification?: number }): Promise<GmailScoutScanReceipt> {
	await env.DB.prepare(
		`UPDATE gmail_scout_scan_receipts SET status = 'completed', completed_at = datetime('now'), hits = ?2, candidates = ?3, added = ?4, deduped = ?5, rejected = ?6, last_message_id = ?7, awaiting_browser_verification = ?8
		  WHERE id = ?1 AND status = 'running'`,
	)
		.bind(id, r.hits, r.candidates, r.added, r.deduped, JSON.stringify(r.rejected), r.lastMessageId, r.awaitingBrowserVerification ?? 0)
		.run();
	return (await getGmailScoutReceipt(env, id)) as GmailScoutScanReceipt;
}

export async function failGmailScoutReceipt(env: Pick<Env, "DB">, id: string, errorMessage: string): Promise<GmailScoutScanReceipt> {
	await env.DB.prepare("UPDATE gmail_scout_scan_receipts SET status = 'failed', completed_at = datetime('now'), error_message = ?2 WHERE id = ?1 AND status = 'running'").bind(id, errorMessage).run();
	return (await getGmailScoutReceipt(env, id)) as GmailScoutScanReceipt;
}

/** Record the exact search a scan is about to run (#1247), before it reads — so a scan that fails still says what it asked. */
export async function recordGmailScoutSearch(env: Pick<Env, "DB">, id: string, query: string | null, window: Record<string, unknown>): Promise<void> {
	await env.DB.prepare("UPDATE gmail_scout_scan_receipts SET search_query = ?2, search_window = ?3 WHERE id = ?1").bind(id, query, JSON.stringify(window)).run();
}

/** Keep the newest {@link RECEIPTS_KEPT} per instance, and every one from the last {@link RECEIPTS_KEPT_DAYS} days. Best-effort. */
export async function pruneGmailScoutReceipts(env: Pick<Env, "DB">, instanceId: string): Promise<void> {
	await env.DB.prepare(
		`DELETE FROM gmail_scout_scan_receipts WHERE instance_id = ?1 AND created_at < datetime('now', ?3) AND id NOT IN
		   (SELECT id FROM gmail_scout_scan_receipts WHERE instance_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2)`,
	)
		.bind(instanceId, RECEIPTS_KEPT, `-${RECEIPTS_KEPT_DAYS} days`)
		.run()
		.catch(() => undefined);
}
