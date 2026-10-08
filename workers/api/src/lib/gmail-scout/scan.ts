/** Read-only Gmail alert ingestion.  Mail text is parsed in-process and never persisted or logged. */
import type { Env } from "../../types.js";
import { connectorClient } from "../connectors/client.js";
import { emailPermitted } from "../connectors/gmail.js";
import { getMessage, listMessages, type GmailMessage } from "../gmail.js";
import { jobIdentity } from "../job-lead-triage.js";
import { getGmailScoutConfig, getGmailScoutScanState, resolveGmailScoutAccount } from "./config.js";

const JOB_ALERT_QUERY = "(subject:(job OR jobs OR role OR opportunity OR alert OR recommendation) OR from:(seek.com linkedin.com indeed.com)) newer_than:30d";
const URL_RE = /https?:\/\/[^\s"'<>]+/g;
const TRACKING = /^(utm_|mc_|ref$|source$|trk$|campaign$|token$)/i;
export type ScoutCandidate = { url: string; title: string; company?: string; location?: string; source: string; posted_date?: string; gmail_message_id: string; gmail_subject: string; gmail_from: string; gmail_date: string };

export function canonicalJobUrl(raw: string): string | null {
	try { const u = new URL(raw); if (!/^https?:$/.test(u.protocol)) return null; u.hash = ""; for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k); u.pathname = u.pathname.replace(/\/+$/, "") || "/"; return u.toString(); } catch { return null; }
}
function firstJobUrl(text: string): string | null {
	for (const raw of text.match(URL_RE) ?? []) { const url = canonicalJobUrl(raw.replace(/[).,;]+$/, "")); if (url && /(job|jobs|career|position|apply|posting|role)/i.test(url)) return url; }
	return null;
}
/** Deliberately modest extraction: metadata is visible, body prose is neither stored nor logged. */
export function candidateFromMessage(message: GmailMessage): ScoutCandidate | null {
	const url = firstJobUrl(message.text) ?? firstJobUrl(message.snippet);
	if (!url) return null;
	const host = new URL(url).hostname.toLowerCase();
	return { url, title: message.subject.trim() || "Job suggestion", source: `Gmail (${host})`, posted_date: message.date || undefined, gmail_message_id: message.id, gmail_subject: message.subject.slice(0, 300), gmail_from: message.from.slice(0, 300), gmail_date: message.date.slice(0, 100) };
}
function stub(env: Env, id: string) { return env.AGENT.get(env.AGENT.idFromName(id)); }
async function records(env: Env, instanceId: string, query?: URLSearchParams) {
	// Preserve caller query keys when this is reached from the status route: AgentDO's paging
	// contract is shared by every collection reader, and dropping one here is the #428 seam bug.
	const suffix = query?.toString() || "limit=500";
	const res = await stub(env, instanceId).fetch(new Request(`https://agent/collections/job_leads/records?${suffix}`));
	if (!res.ok) throw new Error("Could not read this Scout's job leads.");
	const body = await res.json() as { records?: Array<{ data?: Record<string, unknown> }> };
	return body.records ?? [];
}
async function insert(env: Env, instanceId: string, data: Record<string, unknown>) {
	const res = await stub(env, instanceId).fetch(new Request("https://agent/collections/job_leads/records", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data }) }));
	if (!res.ok) throw new Error("Could not save a Gmail job lead.");
}
export type GmailScoutScanResult = { mailbox: string; candidates: number; added: number; deduped: number; lastMessageId: string | null };

export async function scanGmailScout(env: Env, instanceId: string, userId: string): Promise<GmailScoutScanResult> {
	const config = await getGmailScoutConfig(env, instanceId);
	if (!config?.enabled) throw new Error("Gmail Scout is not configured or is disabled.");
	if (!(await emailPermitted(env, instanceId))) throw new Error("Email access is not enabled for this Scout.");
	const account = await resolveGmailScoutAccount(env, instanceId, userId, config.pinnedEmail);
	try {
		const token = await connectorClient(env, "gmail", { userId, instanceId }).token({ scope: "read" });
		const hits = await listMessages(token, JOB_ALERT_QUERY, 25);
		const existing = await records(env, instanceId);
		const seen = new Set(existing.map((r) => jobIdentity(r.data ?? {})).filter(Boolean));
		const messageIds = new Set(existing.map((r) => typeof r.data?.gmail_message_id === "string" ? r.data.gmail_message_id : "").filter(Boolean));
		let added = 0, deduped = 0, candidates = 0;
		for (const hit of hits) {
			if (messageIds.has(hit.id)) { deduped++; continue; }
			const candidate = candidateFromMessage(await getMessage(token, hit.id, 20_000));
			if (!candidate) continue;
			candidates++;
			const identity = jobIdentity({ url: candidate.url });
			if (identity && seen.has(identity)) { deduped++; continue; }
			await insert(env, instanceId, { ...candidate, status: "new", lifecycle_version: 0, source: candidate.source });
			if (identity) seen.add(identity); messageIds.add(hit.id); added++;
		}
		const cursor = hits[0]?.id ?? null;
		await env.DB.prepare(`INSERT INTO gmail_scout_scan_state (instance_id,last_scan_at,last_message_id_cursor,candidate_count,dedupe_count,failure_count,last_failure_at,last_failure_message)
			VALUES (?1,datetime('now'),?2,?3,?4,0,NULL,NULL)
			ON CONFLICT(instance_id) DO UPDATE SET last_scan_at=excluded.last_scan_at,last_message_id_cursor=excluded.last_message_id_cursor,candidate_count=excluded.candidate_count,dedupe_count=excluded.dedupe_count,failure_count=0,last_failure_at=NULL,last_failure_message=NULL`).bind(instanceId, cursor, candidates, deduped).run();
		return { mailbox: account.label ?? account.accountId, candidates, added, deduped, lastMessageId: cursor };
	} catch (error) {
		const message = error instanceof Error ? error.message.slice(0, 500) : "Gmail scan failed";
		await env.DB.prepare(`INSERT INTO gmail_scout_scan_state (instance_id,failure_count,last_failure_at,last_failure_message)
			VALUES (?1,1,datetime('now'),?2) ON CONFLICT(instance_id) DO UPDATE SET failure_count=failure_count+1,last_failure_at=datetime('now'),last_failure_message=excluded.last_failure_message`).bind(instanceId, message).run();
		throw error;
	}
}

export async function gmailScoutStatus(env: Env, instanceId: string, query?: URLSearchParams) {
	const [config, state, leads] = await Promise.all([getGmailScoutConfig(env, instanceId), getGmailScoutScanState(env, instanceId), records(env, instanceId, query)]);
	return { config, state, leadCount: leads.length, newLeadCount: leads.filter((r) => (r.data?.status ?? "new") === "new").length };
}
