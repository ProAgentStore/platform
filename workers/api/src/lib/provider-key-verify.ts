/**
 * Verify an owner's stored provider key with one minimal request (#1356, #773, #1326) — the ONE implementation.
 *
 * Two code paths used to do this: `POST /v1/keys/:provider/verify` (the console's Verify button and the MCP tool) and the hold's
 * re-check, `probeProviderKey`. Both spent four tokens on the owner's key and read the answer, and both had to be kept in step by hand:
 * which provider the request is pinned to (#892), which model it names (#1344), what "no key stored" means. They differ only in what they
 * do with the result — an HTTP response in one, a hold's backoff in the other — so that is all that is left of them.
 *
 * The request is PINNED to the provider asked about. Unpinned, `runUserWorkersAi` picks Anthropic first whenever an Anthropic key is stored,
 * so verifying Cloudflare spent Anthropic tokens and reported Cloudflare fine whatever its credentials were (#892). A success clears the
 * provider-account hold exactly as any real call does, because it IS a real call.
 */
import { anthropicModelProblem, type AnthropicModelId } from "./anthropic-model-routing.js";
import type { HeldProvider } from "./provider-account-observation.js";
import { getUserCloudflareAiCredentials, getUserProviderKey, runUserWorkersAi, UserAiCredentialsError, UserAiProviderError } from "./user-ai.js";
import type { Env } from "../types.js";

/** The model each provider's verify names when the caller gives none: the cheapest honest reading of "does this account work right now". */
export const VERIFY_MODEL: Record<HeldProvider, string> = { anthropic: "claude-sonnet-4-6", cloudflare: "@cf/meta/llama-3.2-3b-instruct" };

export function isVerifiableProvider(provider: string): provider is HeldProvider {
	return provider === "anthropic" || provider === "cloudflare";
}

export type KeyVerification =
	/** The key works: the request was sent and answered. */
	| { ok: true }
	/** Nothing was sent: no key is stored, or the stored credential cannot be read. `status` is what an HTTP caller should answer. */
	| { ok: false; reason: "unavailable"; status: number; message: string }
	/** The provider was asked and refused. The error carries the adapter's `kind`; classify it with `classifyCodingFailure`. */
	| { ok: false; reason: "refused"; error: UserAiProviderError };

/**
 * `opts.model`: the model the refused request named (#1344) — a 403 that only one model gets used to pass a probe on the default model,
 * clear the hold, and fail again. Anthropic accepts one of its own ids; Cloudflare any model id; anything else falls back to the default.
 *
 * Throws only for what is not the owner's key at all (the vault could not be read); callers that must not throw catch it.
 */
export async function verifyProviderKey(env: Env, userId: string, provider: HeldProvider, opts: { model?: string | null } = {}): Promise<KeyVerification> {
	// A missing credential is answered here, plainly, before a request: pinned, it would surface as the mid-turn sentence the pin was written for.
	if (provider === "anthropic" && !(await getUserProviderKey(env, userId, "anthropic"))) {
		return { ok: false, reason: "unavailable", status: 404, message: "No Anthropic key stored. Add one in Profile → API Keys → Anthropic" };
	}
	if (provider === "cloudflare") {
		const stored = await getUserCloudflareAiCredentials(env, userId).catch((e: unknown) => e);
		if (stored instanceof UserAiCredentialsError) {
			const missing = stored.message === new UserAiCredentialsError().message;
			return {
				ok: false,
				reason: "unavailable",
				status: missing ? 404 : 400,
				message: missing ? "No Cloudflare Workers AI credentials stored. Add your account ID and API token in Profile → API Keys → Cloudflare Workers AI" : stored.message,
			};
		}
		if (stored instanceof Error) throw stored;
	}
	const model = opts.model;
	const anthropicModel = provider === "anthropic" && model && !anthropicModelProblem(model) ? (model as AnthropicModelId) : undefined;
	try {
		await runUserWorkersAi(
			env,
			userId,
			model && provider === "cloudflare" ? model : VERIFY_MODEL[provider],
			{ messages: [{ role: "system", content: "Reply with exactly: ok" }, { role: "user", content: "verify" }], max_tokens: 4, maxTokens: 4 },
			undefined,
			{ provider, ...(anthropicModel ? { anthropicModel } : {}) },
		);
		return { ok: true };
	} catch (err) {
		if (err instanceof UserAiCredentialsError) return { ok: false, reason: "unavailable", status: err.status, message: err.message };
		if (err instanceof UserAiProviderError) return { ok: false, reason: "refused", error: err };
		throw err;
	}
}
