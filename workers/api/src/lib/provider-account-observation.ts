/** Credential-specific transport observations, independent of instance model selection (#1314). */
import type { Env } from "../types.js";
import { parseCloudflareAiCredentials } from "./cloudflare-credentials.js";
import { logError } from "./error-log.js";

export type HeldProvider = "anthropic" | "cloudflare";
export type ProviderAccountFailure = "provider_credit" | "provider_credentials";

/** Opaque, one-way equality token. Cloudflare binds BOTH the account and token, independently of JSON order. */
export async function providerCredentialId(provider: HeldProvider, credential: string | { accountId: string; token: string }): Promise<string> {
	let value: string;
	if (provider === "cloudflare") {
		// The ONE reader of the stored credential (#1356). This used to carry its own copy of the colon form, which built an account id
		// from a value with no colon at all; the shared parser refuses it, and so does the identity check below.
		const c = typeof credential === "string" ? parseCloudflareAiCredentials(credential) : credential;
		if (!c?.accountId?.trim() || !c.token?.trim()) throw new Error("Provider credential identity could not be checked");
		value = JSON.stringify([c.accountId.trim(), c.token.trim()]);
	} else value = String(credential);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${provider}\0${value}`));
	return Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join("");
}

/** Observation writes must never replace the provider's actual error, or fail a successful call. */
export async function observeProviderAccount(env: Env, userId: string | undefined, provider: HeldProvider, credential: string | { accountId: string; token: string }, failure: ProviderAccountFailure | null, now = Date.now(), model?: string): Promise<void> {
	if (!userId) return;
	try {
		const id = await providerCredentialId(provider, credential);
		if (failure) {
			// `first_failed_at` opens with the episode and is kept while it stays open (#1344): every failure — the hold's own
			// failed probes included — rewrites `failed_at`, so a give-up measured from it never arrived. `model` is the model
			// the refused request named, so the probe re-checks that one.
			await env.DB.prepare(
				`INSERT INTO provider_account_holds (user_id, provider, credential_id, failure_class, failed_at, first_failed_at, model)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)
				 ON CONFLICT(user_id, provider, credential_id) DO UPDATE SET
				 notice_at = CASE WHEN provider_account_holds.cleared_at IS NOT NULL
				   OR provider_account_holds.failure_class <> excluded.failure_class THEN NULL ELSE provider_account_holds.notice_at END,
				 first_failed_at = CASE WHEN provider_account_holds.cleared_at IS NOT NULL THEN excluded.first_failed_at
				   ELSE COALESCE(provider_account_holds.first_failed_at, excluded.first_failed_at) END,
				 model = COALESCE(excluded.model, provider_account_holds.model),
				 failure_class = excluded.failure_class, failed_at = excluded.failed_at, cleared_at = NULL`,
			).bind(userId, provider, id, failure, now, model ?? null).run();
		} else {
			await env.DB.prepare("UPDATE provider_account_holds SET cleared_at = ?4 WHERE user_id = ?1 AND provider = ?2 AND credential_id = ?3 AND cleared_at IS NULL AND failed_at <= ?4")
				.bind(userId, provider, id, now).run();
		}
	} catch {
		await logError(env, { source: "provider:hold", userId, message: "The provider-account observation could not be persisted", context: { provider, observation: failure ?? "success" } }).catch(() => undefined);
	}
}
