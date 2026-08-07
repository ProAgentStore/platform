import { decryptKey, encryptKey } from "./crypto.js";
import { HttpError } from "./auth.js";
import { logError } from "./error-log.js";
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

/**
 * `{}` = this row stores no secrets. `null` = it stores secrets we could NOT read.
 *
 * The distinction is the whole point (#325). Collapsing both to `{}` — which this did — is what
 * let a rotated KEK, a corrupt DEK/IV or an unparseable plaintext reach `updateCredential`'s merge
 * as "there was nothing here", and the merge then writes NULL over intact ciphertext. The comment
 * on that merge already forbids exactly this; its guard only covered a MISSING key, because a
 * failed decrypt was indistinguishable from an empty one by the time it got there.
 */
async function decryptSecrets(env: Env, row: Pick<CredRow, "secrets_ciphertext" | "secrets_dek" | "secrets_iv">): Promise<CredentialSecrets | null> {
	if (!row.secrets_ciphertext || !row.secrets_dek || !row.secrets_iv) return {};
	if (!env.KEY_ENCRYPTION_KEY) return null;
	try {
		const json = await decryptKey(
			new Uint8Array(row.secrets_ciphertext),
			new Uint8Array(row.secrets_dek),
			new Uint8Array(row.secrets_iv),
			env.KEY_ENCRYPTION_KEY,
		);
		return JSON.parse(json) as CredentialSecrets;
	} catch (e) {
		// Undecryptable ciphertext is a durable, operator-visible fact (`list_errors`), not a
		// per-request nuisance: every read of this row is about to under-report, and the reason
		// is knowable exactly here. No secret material is included.
		await logError(env, {
			source: "credentials",
			message: `Stored credential secrets could not be decrypted: ${e instanceof Error ? e.message : String(e)}`,
		}).catch(() => undefined);
		return null;
	}
}

function rowToSummary(row: CredRow): CredentialSummary {
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
		const summary = rowToSummary(row);
		// Undecryptable → the row DOES hold a secret, we just can't read it. Reporting the flags as
		// false tells the owner "no password stored" about a row that has one, and invites them to
		// "fix" it with exactly the metadata edit that used to delete it.
		const secrets = await decryptSecrets(env, row);
		summary.hasPassword = secrets ? !!secrets.password : true;
		summary.hasPin = !!secrets?.pin;
		summary.hasRecoveryCodes = !!secrets?.recoveryCodes;
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
	if (!secrets) throw new HttpError(503, "This credential's stored secrets could not be decrypted. Nothing was changed — the ciphertext is intact.");
	const summary = rowToSummary(row);
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
	// A credential we cannot decrypt is not a credential the agent can sign in with. Handing back
	// `{password: undefined}` is what produced "hasStoredLogin: true but the login doesn't work" —
	// the brain tries the stored login, fails, and burns the run on a stuck handoff. And stamping
	// last_used_at would record a use that never happened, on the one column an owner reads to
	// decide whether the credential is still in play.
	if (!secrets) return null;
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
	//
	// An EMPTY STRING means "unchanged", not "the new value". `readInput` passes `""` through
	// (only non-strings become undefined), so a form rendering a blank password box — the normal
	// way to edit a credential without retyping the secret — sent `password: ""`. That was treated
	// as the new value; `encryptSecretsFor` skips falsy secrets, so with pin/recoveryCodes also
	// empty it returned null and the UPDATE wrote `secrets_ciphertext = NULL`, irreversibly
	// destroying the stored ATS password. The next apply still saw `hasStoredLogin: true`, fell
	// back to the derived password, and told the brain to use a login that no longer works —
	// burning the run to a stuck handoff. Clearing a secret needs an explicit act, not a blank box.
	const kept = (next: string | undefined, prev: string | undefined) => (next?.trim() ? next : prev);
	// Refuse to rewrite the secret columns at all when we cannot READ what is already there
	// (#220). decryptSecrets returns {} both for "no secrets stored" and for "could not
	// decrypt", so on a KEK problem the merge below would see no existing secrets, produce
	// nothing to encrypt, and write NULL over intact ciphertext — losing the credential to fix
	// a metadata edit. Storing ciphertext we cannot decrypt is a strictly better state than
	// deleting it: the key can come back.
	const hasStoredSecrets = !!(existing.secrets_ciphertext && existing.secrets_dek && existing.secrets_iv);
	if (hasStoredSecrets && !env.KEY_ENCRYPTION_KEY) {
		throw new HttpError(503, "Credential storage is unavailable: this deployment has no encryption key configured. Nothing was changed.");
	}
	// The guard above only ever covered a MISSING key. A rotated KEK, a damaged DEK/IV or an
	// unparseable plaintext failed the same way and used to arrive here as "no secrets stored",
	// which is the exact input the merge below turns into `secrets_ciphertext = NULL` — while
	// returning true, so the API answered 200 "saved" to a request that destroyed the password.
	const current = await decryptSecrets(env, existing);
	if (!current) {
		throw new HttpError(503, "This credential's stored secrets could not be decrypted. Nothing was changed — the ciphertext is intact, so it can still be recovered.");
	}
	const merged: CredentialInput = {
		domain: input.domain || existing.domain,
		password: kept(input.password, current.password),
		pin: kept(input.pin, current.pin),
		recoveryCodes: kept(input.recoveryCodes, current.recoveryCodes),
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

/**
 * Encrypt whatever secrets this input carries, or null when it carries none.
 *
 * The two "nothing to write" cases used to collapse into one null (#220): "this credential is
 * metadata only" and "encryption is unavailable". Callers wrote `enc?.c ?? null` either way, so
 * a missing KEY_ENCRYPTION_KEY meant a user could save an ATS password, get a 200, and have the
 * secret silently not stored — and on UPDATE it wrote NULL over ciphertext that was already
 * there, destroying a working credential because of a deployment misconfiguration.
 *
 * Now only the first case returns null. The second throws, so a secret write fails closed and
 * loudly, matching how runtime token storage already behaves. 503 rather than 500: the request
 * was valid, the environment is not, and it may well succeed after the operator sets the key.
 */
async function encryptSecretsFor(env: Env, input: CredentialInput): Promise<{ c: Uint8Array; d: Uint8Array; i: Uint8Array } | null> {
	const secrets: CredentialSecrets = {};
	if (input.password) secrets.password = input.password;
	if (input.pin) secrets.pin = input.pin;
	if (input.recoveryCodes) secrets.recoveryCodes = input.recoveryCodes;
	if (Object.keys(secrets).length === 0) return null; // metadata-only credential — legitimate
	if (!env.KEY_ENCRYPTION_KEY) {
		throw new HttpError(503, "Credential storage is unavailable: this deployment has no encryption key configured. Your secret was NOT saved.");
	}
	const { ciphertext, dekWrapped, iv } = await encryptKey(JSON.stringify(secrets), env.KEY_ENCRYPTION_KEY);
	return { c: ciphertext, d: dekWrapped, i: iv };
}
