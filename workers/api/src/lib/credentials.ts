import { decryptKey, encryptKey } from "./crypto.js";
import type { Env } from "../types.js";

export interface CredentialSecrets {
	password?: string;
	pin?: string;
	recoveryCodes?: string;
}

export interface CredentialInput {
	domain: string;
	loginUrl?: string;
	username?: string;
	password?: string;
	pin?: string;
	recoveryCodes?: string;
	comments?: string;
	recoveryHistory?: string;
}

/** What the client list view sees — never the secret values, only whether they're set. */
export interface CredentialSummary {
	id: string;
	domain: string;
	loginUrl?: string;
	username?: string;
	comments?: string;
	recoveryHistory?: string;
	hasPassword: boolean;
	hasPin: boolean;
	hasRecoveryCodes: boolean;
	createdAt: string;
	updatedAt: string;
	lastUsedAt?: string;
}

interface CredRow {
	id: string;
	domain: string;
	login_url: string | null;
	username: string | null;
	secrets_ciphertext: ArrayBuffer | null;
	secrets_dek: ArrayBuffer | null;
	secrets_iv: ArrayBuffer | null;
	comments: string | null;
	recovery_history: string | null;
	created_at: string;
	updated_at: string;
	last_used_at: string | null;
}

/** Normalize any URL/host string to a bare host key, e.g. "https://jobs.dayforcehcm.com/x" → "dayforcehcm.com" is NOT done here (we keep the full host); only protocol/path/www are stripped. */
export function credDomain(value: string): string {
	const v = String(value || "").trim();
	try {
		const u = v.includes("://") ? new URL(v) : new URL(`https://${v}`);
		return u.host.replace(/^www\./, "").toLowerCase();
	} catch {
		return v.toLowerCase().replace(/^www\./, "").replace(/\/.*$/, "");
	}
}

async function decryptSecrets(env: Env, row: Pick<CredRow, "secrets_ciphertext" | "secrets_dek" | "secrets_iv">): Promise<CredentialSecrets> {
	if (!row.secrets_ciphertext || !row.secrets_dek || !row.secrets_iv || !env.KEY_ENCRYPTION_KEY) return {};
	try {
		const json = await decryptKey(
			new Uint8Array(row.secrets_ciphertext),
			new Uint8Array(row.secrets_dek),
			new Uint8Array(row.secrets_iv),
			env.KEY_ENCRYPTION_KEY,
		);
		return JSON.parse(json) as CredentialSecrets;
	} catch {
		return {};
	}
}

function rowToSummary(env: Env, row: CredRow): CredentialSummary {
	// hasX flags come from re-decrypting? No — keep it cheap: infer from presence of
	// the ciphertext, refined per-field on reveal. We store a tiny plaintext "has"
	// map by re-encrypting only set fields, so flags are derived at reveal time.
	return {
		id: row.id,
		domain: row.domain,
		loginUrl: row.login_url ?? undefined,
		username: row.username ?? undefined,
		comments: row.comments ?? undefined,
		recoveryHistory: row.recovery_history ?? undefined,
		hasPassword: false, // filled by listCredentials after a lightweight decrypt
		hasPin: false,
		hasRecoveryCodes: false,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastUsedAt: row.last_used_at ?? undefined,
	};
}

export async function listCredentials(env: Env, instanceId: string, userId: string): Promise<CredentialSummary[]> {
	const res = await env.DB.prepare("SELECT * FROM agent_credentials WHERE instance_id = ?1 AND user_id = ?2 ORDER BY domain")
		.bind(instanceId, userId)
		.all<CredRow>();
	const out: CredentialSummary[] = [];
	for (const row of res.results ?? []) {
		const summary = rowToSummary(env, row);
		const secrets = await decryptSecrets(env, row);
		summary.hasPassword = !!secrets.password;
		summary.hasPin = !!secrets.pin;
		summary.hasRecoveryCodes = !!secrets.recoveryCodes;
		out.push(summary);
	}
	return out;
}

/** Decrypt the secrets for one credential (owner-only reveal / agent use). */
export async function revealCredential(env: Env, instanceId: string, userId: string, id: string): Promise<(CredentialSummary & CredentialSecrets) | null> {
	const row = await env.DB.prepare("SELECT * FROM agent_credentials WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3")
		.bind(id, instanceId, userId)
		.first<CredRow>();
	if (!row) return null;
	const secrets = await decryptSecrets(env, row);
	const summary = rowToSummary(env, row);
	return { ...summary, hasPassword: !!secrets.password, hasPin: !!secrets.pin, hasRecoveryCodes: !!secrets.recoveryCodes, ...secrets };
}

/**
 * Find the stored credential whose domain matches a job/login host (suffix match
 * either way, so "jobs.dayforcehcm.com" matches a stored "dayforcehcm.com").
 * Decrypts the secrets and bumps last_used_at. Used by the apply agent.
 */
export async function findCredentialForHost(env: Env, instanceId: string, userId: string, host: string): Promise<{ id: string; username?: string; loginUrl?: string; password?: string; pin?: string } | null> {
	const h = credDomain(host);
	if (!h) return null;
	const res = await env.DB.prepare("SELECT * FROM agent_credentials WHERE instance_id = ?1 AND user_id = ?2")
		.bind(instanceId, userId)
		.all<CredRow>();
	const match = (res.results ?? []).find((r) => {
		const d = String(r.domain).toLowerCase();
		return h === d || h.endsWith(`.${d}`) || d.endsWith(`.${h}`);
	});
	if (!match) return null;
	const secrets = await decryptSecrets(env, match);
	await env.DB.prepare("UPDATE agent_credentials SET last_used_at = datetime('now') WHERE id = ?1").bind(match.id).run();
	return { id: match.id, username: match.username ?? undefined, loginUrl: match.login_url ?? undefined, password: secrets.password, pin: secrets.pin };
}

export async function createCredential(env: Env, instanceId: string, userId: string, input: CredentialInput): Promise<string> {
	const id = crypto.randomUUID();
	const enc = await encryptSecretsFor(env, input);
	await env.DB.prepare(
		`INSERT INTO agent_credentials (id, instance_id, user_id, domain, login_url, username, secrets_ciphertext, secrets_dek, secrets_iv, comments, recovery_history, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'), datetime('now'))`,
	)
		.bind(id, instanceId, userId, credDomain(input.domain), input.loginUrl ?? null, input.username ?? null, enc?.c ?? null, enc?.d ?? null, enc?.i ?? null, input.comments ?? null, input.recoveryHistory ?? null)
		.run();
	return id;
}

export async function updateCredential(env: Env, instanceId: string, userId: string, id: string, input: CredentialInput): Promise<boolean> {
	const existing = await env.DB.prepare("SELECT * FROM agent_credentials WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3").bind(id, instanceId, userId).first<CredRow>();
	if (!existing) return false;
	// Merge: keep existing secrets unless new ones are supplied.
	const current = await decryptSecrets(env, existing);
	const merged: CredentialInput = {
		domain: input.domain || existing.domain,
		password: input.password !== undefined ? input.password : current.password,
		pin: input.pin !== undefined ? input.pin : current.pin,
		recoveryCodes: input.recoveryCodes !== undefined ? input.recoveryCodes : current.recoveryCodes,
	};
	const enc = await encryptSecretsFor(env, merged);
	await env.DB.prepare(
		`UPDATE agent_credentials SET domain = ?1, login_url = ?2, username = ?3, secrets_ciphertext = ?4, secrets_dek = ?5, secrets_iv = ?6, comments = ?7, recovery_history = ?8, updated_at = datetime('now')
		 WHERE id = ?9 AND instance_id = ?10 AND user_id = ?11`,
	)
		.bind(
			credDomain(merged.domain),
			input.loginUrl !== undefined ? input.loginUrl : existing.login_url,
			input.username !== undefined ? input.username : existing.username,
			enc?.c ?? null,
			enc?.d ?? null,
			enc?.i ?? null,
			input.comments !== undefined ? input.comments : existing.comments,
			input.recoveryHistory !== undefined ? input.recoveryHistory : existing.recovery_history,
			id,
			instanceId,
			userId,
		)
		.run();
	return true;
}

export async function deleteCredential(env: Env, instanceId: string, userId: string, id: string): Promise<boolean> {
	const res = await env.DB.prepare("DELETE FROM agent_credentials WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3").bind(id, instanceId, userId).run();
	return (res.meta?.changes ?? 0) > 0;
}

async function encryptSecretsFor(env: Env, input: CredentialInput): Promise<{ c: Uint8Array; d: Uint8Array; i: Uint8Array } | null> {
	const secrets: CredentialSecrets = {};
	if (input.password) secrets.password = input.password;
	if (input.pin) secrets.pin = input.pin;
	if (input.recoveryCodes) secrets.recoveryCodes = input.recoveryCodes;
	if (Object.keys(secrets).length === 0 || !env.KEY_ENCRYPTION_KEY) return null;
	const { ciphertext, dekWrapped, iv } = await encryptKey(JSON.stringify(secrets), env.KEY_ENCRYPTION_KEY);
	return { c: ciphertext, d: dekWrapped, i: iv };
}
