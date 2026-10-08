/** Configuration and account binding for the strictly read-only Gmail Scout (#995). */
import type { Env } from "../../types.js";
import { listConnectorAccounts, resolveConnectorAccount } from "../connector-accounts.js";
import { patchInstanceConfig } from "../instance-config.js";

export const GMAIL_SCOUT_TOOLS = ["gmail_search", "gmail_read_message"] as const;
export const GMAIL_SCOUT_CAPABILITY = { connector: "gmail", readOnly: true, tools: GMAIL_SCOUT_TOOLS } as const;

export type GmailScoutConfig = { id: string; instanceId: string; pinnedEmail: string | null; enabled: boolean; createdAt: string; updatedAt: string };
export type GmailScoutScanState = { instanceId: string; lastScanAt: string | null; lastMessageIdCursor: string | null; candidateCount: number; dedupeCount: number; failureCount: number; lastFailureAt: string | null; lastFailureMessage: string | null };

const configRow = (r: Record<string, unknown>): GmailScoutConfig => ({
	id: String(r.id), instanceId: String(r.instance_id), pinnedEmail: typeof r.pinned_email === "string" ? r.pinned_email : null,
	enabled: Number(r.enabled) === 1, createdAt: String(r.created_at), updatedAt: String(r.updated_at),
});

export async function getGmailScoutConfig(env: Env, instanceId: string): Promise<GmailScoutConfig | null> {
	const r = await env.DB.prepare("SELECT id, instance_id, pinned_email, enabled, created_at, updated_at FROM gmail_scout_configs WHERE instance_id = ?1").bind(instanceId).first<Record<string, unknown>>();
	return r ? configRow(r) : null;
}

/** Save config and mirror an explicit mailbox pin into the connector resolver's canonical location. */
export async function putGmailScoutConfig(env: Env, instanceId: string, userId: string, input: { pinnedEmail?: string | null; enabled?: boolean }): Promise<GmailScoutConfig> {
	const current = await getGmailScoutConfig(env, instanceId);
	const pinnedEmail = input.pinnedEmail === undefined ? current?.pinnedEmail ?? null : input.pinnedEmail?.trim() || null;
	const enabled = input.enabled === undefined ? current?.enabled ?? true : input.enabled;
	if (pinnedEmail) {
		const accounts = await listConnectorAccounts(env, userId, "gmail");
		const found = accounts.find((a) => a.accountId === pinnedEmail || a.label === pinnedEmail);
		if (!found) throw new Error(`Gmail account "${pinnedEmail}" is not connected.`);
		await patchInstanceConfig(env, instanceId, userId, "connectorAccounts", { gmail: found.accountId });
	}
	const id = current?.id ?? crypto.randomUUID();
	await env.DB.prepare(`INSERT INTO gmail_scout_configs (id, instance_id, pinned_email, enabled, created_at, updated_at)
		VALUES (?1, ?2, ?3, ?4, datetime('now'), datetime('now'))
		ON CONFLICT(instance_id) DO UPDATE SET pinned_email = excluded.pinned_email, enabled = excluded.enabled, updated_at = datetime('now')`)
		.bind(id, instanceId, pinnedEmail, enabled ? 1 : 0).run();
	return (await getGmailScoutConfig(env, instanceId)) as GmailScoutConfig;
}

/** Resolves exactly one account; ambiguity is intentionally a hard refusal before a mailbox is read. */
export async function resolveGmailScoutAccount(env: Env, instanceId: string, userId: string, pinnedEmail?: string | null) {
	const accounts = await listConnectorAccounts(env, userId, "gmail");
	const resolved = resolveConnectorAccount(accounts, pinnedEmail ?? undefined, "Gmail");
	if (!resolved.ok) throw new Error(resolved.message);
	return resolved.account;
}

export async function getGmailScoutScanState(env: Env, instanceId: string): Promise<GmailScoutScanState> {
	const r = await env.DB.prepare("SELECT instance_id, last_scan_at, last_message_id_cursor, candidate_count, dedupe_count, failure_count, last_failure_at, last_failure_message FROM gmail_scout_scan_state WHERE instance_id = ?1").bind(instanceId).first<Record<string, unknown>>();
	return {
		instanceId, lastScanAt: typeof r?.last_scan_at === "string" ? r.last_scan_at : null, lastMessageIdCursor: typeof r?.last_message_id_cursor === "string" ? r.last_message_id_cursor : null,
		candidateCount: Number(r?.candidate_count ?? 0), dedupeCount: Number(r?.dedupe_count ?? 0), failureCount: Number(r?.failure_count ?? 0),
		lastFailureAt: typeof r?.last_failure_at === "string" ? r.last_failure_at : null, lastFailureMessage: typeof r?.last_failure_message === "string" ? r.last_failure_message : null,
	};
}
