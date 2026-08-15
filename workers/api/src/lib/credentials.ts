import { decryptKey, encryptKey } from "./crypto.js";
import { HttpError } from "./auth.js";
import { logError } from "./error-log.js";
import { logEvent } from "./events.js";
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
 * How well a stored credential's domain fits the host being signed in to (#650).
 * Lower is better; `null` means it does not match at all.
 *
 * There was no ranking here, and no `ORDER BY` on the query that fed it — the caller took the
 * first row the index yielded, which is insertion order. So a user holding both
 * `dayforcehcm.com` and `jobs.dayforcehcm.com` signed in with whichever they happened to store
 * FIRST. That is the function's own motivating example, and it is what supplies the email
 * address put on the application and the password the brain types into the form.
 *
 * A bare `ORDER BY created_at` would have made that deterministic without making it correct,
 * and a deterministic wrong answer is harder to notice than a random one. So the order is
 * derived from what actually makes a credential the right one:
 *
 *   0. EXACT — the stored domain IS the host. Nothing beats it.
 *   1. PARENT — the stored domain contains the host (`dayforcehcm.com` for
 *      `jobs.dayforcehcm.com`). The documented case: one ATS account covering its subdomains.
 *   2. CHILD — the stored domain is BELOW the host (`careers.bigco.com` offered for
 *      `bigco.com`). A speculative widening, so it loses to any parent match.
 *
 * Within a tier, fewer intervening labels wins — the closer of two ancestors is the more
 * specific account.
 */
export function credentialMatchRank(host: string, domain: string): number | null {
	const h = host.toLowerCase();
	const d = domain.toLowerCase();
	if (!h || !d) return null;
	const labels = (s: string) => s.split(".").length;
	if (h === d) return 0;
	if (h.endsWith(`.${d}`)) return 100 + (labels(h) - labels(d));
	if (d.endsWith(`.${h}`)) return 200 + (labels(d) - labels(h));
	return null;
}

/**
 * Find the stored credential that best matches a job/login host — most specific first, see
 * {@link credentialMatchRank}. Decrypts the secrets and bumps last_used_at. Used by the apply agent.
 *
 * Ties (two credentials on the SAME domain — two accounts on one ATS) are broken by the
 * `ORDER BY` below, newest first, and the rank sort is stable so that survives. Newest rather
 * than most-recently-used on purpose: `last_used_at` is written by THIS function, so ordering
 * by it would make the first arbitrary pick self-reinforcing, and it gets the common case
 * backwards — when a password expires and the owner stores a replacement, the stale row is the
 * one with the recent use and the new one has none.
 *
 * What this still cannot express is which of two accounts on one host belongs to which job.
 * Nothing in the data model says so; the owner is told which was used (below) rather than
 * guessed at silently.
 */
export async function findCredentialForHost(env: Env, instanceId: string, userId: string, host: string): Promise<{ id: string; username?: string; loginUrl?: string; password?: string; pin?: string } | null> {
	const h = credDomain(host);
	if (!h) return null;
	const res = await env.DB.prepare("SELECT * FROM agent_credentials WHERE instance_id = ?1 AND user_id = ?2 ORDER BY created_at DESC, id")
		.bind(instanceId, userId)
		.all<CredRow>();
	const ranked = (res.results ?? [])
		.map((r) => ({ row: r, rank: credentialMatchRank(h, String(r.domain)) }))
		.filter((m): m is { row: CredRow; rank: number } => m.rank !== null)
		.sort((a, b) => a.rank - b.rank);
	const match = ranked[0]?.row;
	if (!match) return null;
	// More than one credential fit this host, so a choice was made that the owner did not make.
	// Recorded only when it was genuinely ambiguous — the ordinary one-credential case stays
	// silent — because the failure this replaces was invisible either way: a wrong account is a
	// real application submitted under the wrong identity, or a sign-in that fails and burns the
	// run into a stuck handoff, and neither said which credential had been used (#650).
	if (ranked.length > 1) {
		await logEvent(env, {
			source: "credentials",
			event: "credential.selected",
			message: `Signing in to ${h} as ${match.username ?? "the stored account"} (${match.domain})`,
			userId,
			instanceId,
			context: { host: h, chosen: { id: match.id, domain: match.domain, rank: ranked[0].rank }, passedOver: ranked.slice(1, 5).map((m) => ({ id: m.row.id, domain: m.row.domain, rank: m.rank })) },
		});
	}
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
