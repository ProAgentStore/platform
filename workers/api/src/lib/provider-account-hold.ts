/** #1314: admission holds are credential-specific facts, not a verdict inferred forever from an
 * old run or error-log row. Transport observations name the ACTUAL credential used; an in-flight
 * old-key failure cannot poison its replacement. No credential or upstream error text is stored.
 */
import { capabilitiesForInstance } from "./agent-capabilities.js";
import { isWorkersAiModel } from "./brain-models.js";
import { decryptKey } from "./crypto.js";
import { logError } from "./error-log.js";
import { readInstanceBrain } from "./instance-brain.js";
import { deepLinkFor } from "./console-links.js";
import { notifyUser } from "../routes/push.js";
import { readPilotModel, DEFAULT_PILOT_MODEL } from "./pilot-model.js";
import type { Env } from "../types.js";

export type HeldProvider = "anthropic" | "cloudflare";
export type ProviderAccountFailure = "provider_credit" | "provider_credentials";
export interface ProviderAccountIdentity { provider: HeldProvider; credentialId: string }
interface HoldRow { failure_class: ProviderAccountFailure; failed_at: number }
export interface ProviderHold extends ProviderAccountIdentity { reason: string }
const UNREADABLE = "Automatic runs are waiting because the provider-account hold or selected credential could not be checked. Retry after account storage is available, or explicitly continue the original run.";

/** Opaque, one-way equality token. Cloudflare binds BOTH the account and token, independently of JSON order. */
export async function providerCredentialId(provider: HeldProvider, credential: string | { accountId: string; token: string }): Promise<string> {
	let value: string;
	if (provider === "cloudflare") {
		let c: { accountId: string; token: string };
		if (typeof credential === "string") {
			const raw = credential.trim();
			if (raw.startsWith("{")) c = JSON.parse(raw) as typeof c;
			else { const colon = raw.indexOf(":"); c = { accountId: raw.slice(0, colon), token: raw.slice(colon + 1) }; }
		} else c = credential;
		if (!c.accountId?.trim() || !c.token?.trim()) throw new Error("Provider credential identity could not be checked");
		value = JSON.stringify([c.accountId.trim(), c.token.trim()]);
	} else value = String(credential);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${provider}\0${value}`));
	return Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join("");
}

/** Observation writes must never replace the provider's actual error, or fail a successful call. */
export async function observeProviderAccount(env: Env, userId: string | undefined, provider: HeldProvider, credential: string | { accountId: string; token: string }, failure: ProviderAccountFailure | null, now = Date.now()): Promise<void> {
	if (!userId) return;
	try {
		const id = await providerCredentialId(provider, credential);
		if (failure) {
			await env.DB.prepare(
				`INSERT INTO provider_account_holds (user_id, provider, credential_id, failure_class, failed_at)
				 VALUES (?1, ?2, ?3, ?4, ?5)
				 ON CONFLICT(user_id, provider, credential_id) DO UPDATE SET
				 notice_at = CASE WHEN provider_account_holds.cleared_at IS NOT NULL
				   OR provider_account_holds.failure_class <> excluded.failure_class THEN NULL ELSE provider_account_holds.notice_at END,
				 failure_class = excluded.failure_class, failed_at = excluded.failed_at, cleared_at = NULL`,
			).bind(userId, provider, id, failure, now).run();
		} else {
			await env.DB.prepare("UPDATE provider_account_holds SET cleared_at = ?4 WHERE user_id = ?1 AND provider = ?2 AND credential_id = ?3 AND cleared_at IS NULL AND failed_at <= ?4")
				.bind(userId, provider, id, now).run();
		}
	} catch {
		await logError(env, { source: "provider:hold", userId, message: "The provider-account observation could not be persisted", context: { provider, observation: failure ?? "success" } }).catch(() => undefined);
	}
}

interface KeyRow { key_ciphertext: ArrayBuffer; dek_wrapped: ArrayBuffer; iv: ArrayBuffer }
/** The provider an automatic run will actually use. A selected Haiku Pilot is explicitly Anthropic.
 * The legacy Sonnet Pilot keeps BYOK priority, independently of its advisory Brain. Chat loops honour a picked Brain. */
export async function selectedProviderAccount(env: Env, instanceId: string, userId: string): Promise<ProviderAccountIdentity | null> {
	const { results } = await env.DB.prepare("SELECT provider FROM user_api_keys WHERE user_id = ?1 AND provider IN ('anthropic', 'cloudflare')")
		.bind(userId).all<{ provider: HeldProvider }>();
	const keys = results ?? [];
	if (!keys.length) return null;
	const caps = await capabilitiesForInstance(env, instanceId, userId);
	const brain = caps?.workflow === "CODING_SESSION" ? null : await readInstanceBrain(env, instanceId);
	const explicitPilot = caps?.workflow === "CODING_SESSION" && await readPilotModel(env, instanceId, userId) !== DEFAULT_PILOT_MODEL;
	const provider: HeldProvider = explicitPilot ? "anthropic"
		: brain?.modelChosen && isWorkersAiModel(brain.model) ? "cloudflare"
		: keys.some((k) => k.provider === "anthropic") ? "anthropic" : "cloudflare";
	// Match the inference layer's provider-row lookup, including legacy named slots. Do not
	// prefer another account here: that would check a credential the request will not use.
	const row = await env.DB.prepare("SELECT key_ciphertext, dek_wrapped, iv FROM user_api_keys WHERE user_id = ?1 AND provider = ?2")
		.bind(userId, provider).first<KeyRow>();
	if (!row) return null;
	if (!env.KEY_ENCRYPTION_KEY) throw new Error(UNREADABLE);
	const credential = await decryptKey(new Uint8Array(row.key_ciphertext), new Uint8Array(row.dek_wrapped), new Uint8Array(row.iv), env.KEY_ENCRYPTION_KEY);
	return { provider, credentialId: await providerCredentialId(provider, credential) };
}

/** One account-wide notice per hold episode, claimed in SQL before delivery, even for concurrent
 * cron/terminal wakes on different instances. The underlying objective and all permission choices stay intact. */
export async function automaticProviderHold(env: Env, instanceId: string, userId: string, notify?: (reason: string) => Promise<void>): Promise<ProviderHold | null> {
	try {
		const account = await selectedProviderAccount(env, instanceId, userId);
		if (!account) return null;
		const h = await env.DB.prepare("SELECT failure_class, failed_at FROM provider_account_holds WHERE user_id = ?1 AND provider = ?2 AND credential_id = ?3 AND cleared_at IS NULL")
			.bind(userId, account.provider, account.credentialId).first<HoldRow>();
		if (!h) return null;
		const name = account.provider === "anthropic" ? "Anthropic" : "Cloudflare Workers AI";
		const remedy = h.failure_class === "provider_credit" ? `Top up this ${name} account` : `Replace or repair this ${name} credential in Profile → API Keys`;
		const reason = `Automatic runs are paused because this ${name} credential ${h.failure_class === "provider_credit" ? "has insufficient balance" : "was rejected"}. ${remedy}, then verify it in Profile → API Keys. Replacing the credential or a successful call/verification lifts this hold. You can explicitly Continue the original run; automatic wakes will not consume its objective.`;
		const claim = await env.DB.prepare("UPDATE provider_account_holds SET notice_at = ?4 WHERE user_id = ?1 AND provider = ?2 AND credential_id = ?3 AND cleared_at IS NULL AND notice_at IS NULL")
			.bind(userId, account.provider, account.credentialId, Date.now()).run();
		if ((claim.meta?.changes ?? 0) > 0) await (notify ? notify(reason) : notifyUser(env, userId, "coding", "Automatic runs are paused", reason, deepLinkFor({ kind: "profile" }), { kind: "update", instanceId, key: `provider-hold:${account.provider}:${h.failed_at}` })).catch(() => undefined);
		return { ...account, reason };
	} catch {
		// Admission fails closed. No secrets or raw database errors enter the notice/queue result.
		return { provider: "anthropic", credentialId: "", reason: UNREADABLE };
	}
}
