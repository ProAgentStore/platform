/** #1314: admission holds are credential-specific facts, not a verdict inferred forever from an
 * old run or error-log row. Transport observations name the ACTUAL credential used; an in-flight
 * old-key failure cannot poison its replacement. No credential or upstream error text is stored.
 */
import { capabilitiesForInstance } from "./agent-capabilities.js";
import { isWorkersAiModel } from "./brain-models.js";
import { decryptKey } from "./crypto.js";
import { readInstanceBrain } from "./instance-brain.js";
import { deepLinkFor } from "./console-links.js";
import { notifyUser } from "../routes/push.js";
import { readPilotModel, DEFAULT_PILOT_MODEL } from "./pilot-model.js";
import type { Env } from "../types.js";

import { providerCredentialId, type HeldProvider, type ProviderAccountFailure } from "./provider-account-observation.js";
export { observeProviderAccount, providerCredentialId, type HeldProvider, type ProviderAccountFailure } from "./provider-account-observation.js";
export interface ProviderAccountIdentity { provider: HeldProvider; credentialId: string }
interface HoldRow { failure_class: ProviderAccountFailure; failed_at: number }
export interface ProviderHold extends ProviderAccountIdentity { reason: string }
class MissingProviderCredential extends Error {
	constructor(public readonly provider: HeldProvider) {
		super("Automatic runs are paused because the selected Haiku Pilot requires an Anthropic API key. Add an Anthropic key in Profile → API Keys. No queued objective or automatic-start allowance has been consumed.");
	}
}
const UNREADABLE = "Automatic runs are waiting because the provider-account hold or selected credential could not be checked. Retry after account storage is available, or explicitly continue the original run.";

interface KeyRow { key_ciphertext: ArrayBuffer; dek_wrapped: ArrayBuffer; iv: ArrayBuffer }
/** The provider an automatic run will actually use. A selected Haiku Pilot is explicitly Anthropic.
 * The legacy Sonnet Pilot keeps BYOK priority, independently of its advisory Brain. Chat loops honour a picked Brain. */
export async function selectedProviderAccount(env: Env, instanceId: string, userId: string): Promise<ProviderAccountIdentity | null> {
	const { results } = await env.DB.prepare("SELECT provider FROM user_api_keys WHERE user_id = ?1 AND provider IN ('anthropic', 'cloudflare')")
		.bind(userId).all<{ provider: HeldProvider }>();
	const keys = results ?? [];
	const caps = await capabilitiesForInstance(env, instanceId, userId);
	const brain = caps?.workflow === "CODING_SESSION" ? null : await readInstanceBrain(env, instanceId);
	const explicitPilot = caps?.workflow === "CODING_SESSION" && await readPilotModel(env, instanceId, userId) !== DEFAULT_PILOT_MODEL;
	if (explicitPilot && !keys.some((k) => k.provider === "anthropic")) throw new MissingProviderCredential("anthropic");
	if (!keys.length) return null;
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
		// #1326: says what the platform is doing about it. The hold is re-checked on a backoff (`credit-auto-resume.ts`),
		// so a refusal that clears by itself — measured on 403 "Request not allowed" — lifts without the owner.
		const reason = h.failure_class === "provider_credit"
			? `Automatic runs are paused because this ${name} credential has insufficient balance. Top up this ${name} account; PAGS re-checks it automatically and resumes once it works, or press Verify in Profile → API Keys. You can explicitly Continue the original run; automatic wakes will not consume its objective.`
			: `Automatic runs are paused because ${name} refused this credential. PAGS re-checks it automatically (after 5 min, 15 min, 1 h, then every 6 h) and resumes on its own once it works. If it stays refused, check the key at the provider or replace it in Profile → API Keys, then press Verify. You can explicitly Continue the original run; automatic wakes will not consume its objective.`;
		const claim = await env.DB.prepare("UPDATE provider_account_holds SET notice_at = ?4 WHERE user_id = ?1 AND provider = ?2 AND credential_id = ?3 AND cleared_at IS NULL AND notice_at IS NULL")
			.bind(userId, account.provider, account.credentialId, Date.now()).run();
		if ((claim.meta?.changes ?? 0) > 0) await (notify ? notify(reason) : notifyUser(env, userId, "coding", "Automatic runs are paused", reason, deepLinkFor({ kind: "profile" }), { kind: "update", instanceId, key: `provider-hold:${account.provider}:${h.failed_at}` })).catch(() => undefined);
		return { ...account, reason };
	} catch (error) {
		if (error instanceof MissingProviderCredential) return { provider: error.provider, credentialId: "", reason: error.message };
		// Admission fails closed. No secrets or raw database errors enter the notice/queue result.
		return { provider: "anthropic", credentialId: "", reason: UNREADABLE };
	}
}
