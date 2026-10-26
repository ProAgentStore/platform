import { decryptKey } from "./crypto.js";
import { backfillKeyHint } from "./key-hint-backfill.js";
import { anthropicAdapter } from "./anthropic.js";
import { cloudflareAdapter } from "./cloudflare-ai.js";
import { type StoredCloudflareAiCredentials, parseCloudflareAiCredentials } from "./cloudflare-credentials.js";
import { type ProviderAdapter, type AiProvider } from "./provider-adapter.js";
import { providerErrorTag } from "./provider-error-kind.js";
import { observeProviderAccount, recordProviderCallSuccess } from "./provider-account-observation.js";
import { recordUsage, type UsageContext } from "./usage.js";
import { isWorkersAiModel } from "./brain-models.js";
import { logPromptSectionEstimates } from "./prompt-section-estimates.js";
import { DEFAULT_ANTHROPIC_MODEL, anthropicModelProblem, type AnthropicModelId } from "./anthropic-model-routing.js";
import type { StreamDeadlines } from "./stream-phase.js";
import { UserAiCredentialsError, UserAiProviderError } from "./user-ai-errors.js";
import type { Env } from "../types.js";

// What used to be defined here now lives beside the code it belongs to (#1356). Every name stays importable from this module.
export { UserAiCredentialsError, UserAiProviderError, UserAiUnsupportedInputError } from "./user-ai-errors.js";
export type { StreamDeadlines, StreamPhase } from "./stream-phase.js";
export { streamPhaseFromMessage, streamPhaseSuffix } from "./stream-phase.js";
export { isCreditBalanceMessage } from "./provider-error-kind.js";
export { encodeCloudflareAiCredentials, parseCloudflareAiCredentials, type StoredCloudflareAiCredentials } from "./cloudflare-credentials.js";
export { providerFacts, type AiProvider } from "./provider-adapter.js";
export { type SystemPromptBlock, anthropicSystemBlocks, isSystemPromptBlocks, isUserPromptBlocks, systemPromptSections, systemPromptText } from "./anthropic-prompt.js";

/** The two providers a brain runs on — which one a turn is on is read off its first completion. */

const midTurnLoss = (provider: string, credential: string) =>
	`This turn's earlier rounds ran on ${provider}, and ${credential} can no longer be read, so it cannot continue — another provider cannot read those rounds. Check it in Profile → API Keys, then ask again.`;

/**
 * Run AI inference using the user's stored API key.
 * Priority: Anthropic Claude > Cloudflare Workers AI.
 * BYOK: uses whatever provider the user has configured.
 */
export async function runUserWorkersAi(
	env: Env,
	userId: string | undefined,
	model: string,
	body: unknown,
	ctx?: UsageContext,
	/** `honorModel`: the owner PICKED this model (#852) — a Workers AI pick runs on Workers AI even
	 *  when an Anthropic key is also stored. Without it the long-standing order below applies.
	 *  `provider`: the provider this TURN already ran on (#853 finding 9) — it continues there or fails. */
	opts?: { honorModel?: boolean; provider?: AiProvider; anthropicModel?: AnthropicModelId },
): Promise<unknown> {
	// Explicit provider routing is independent of the role policy: Haiku may handle ticket work, never coding.
	if (opts?.anthropicModel !== undefined && anthropicModelProblem(opts.anthropicModel)) throw new UserAiProviderError(anthropicModelProblem(opts.anthropicModel) as string, 400);
	if (opts?.anthropicModel === "claude-haiku-5-5" && (ctx?.kind === "coding" || ctx?.promptSource === "coding")) throw new UserAiProviderError("Haiku is not permitted for coding.", 400);
	if (ctx) ctx = { ...ctx, attempt: (body as { streamDeadlines?: StreamDeadlines } | null)?.streamDeadlines?.attempt ?? ctx.attempt }; // #1040: retries on the ledger
	if (ctx?.promptSections?.length) {
		await logPromptSectionEstimates(env, {
			userId,
			instanceId: ctx.instanceId ?? null,
			traceId: ctx.traceId ?? null,
			source: ctx.promptSource ?? ctx.kind,
			kind: ctx.kind,
			model,
			phase: ctx.promptPhase ?? null,
			sections: ctx.promptSections,
		});
	}
	// A turn under way stays where it started (#853 finding 9): its history is in THAT provider's tool
	// protocol, which the other one cannot read. Choosing per call sent a later round wherever the keys
	// pointed at that moment — a removed or unreadable key flipped the turn mid-way.
	if (opts?.provider === "anthropic" || opts?.anthropicModel !== undefined) {
		const key = await getUserProviderKey(env, userId, "anthropic");
		if (!key) throw new UserAiCredentialsError(opts?.anthropicModel ? "The selected model uses your Anthropic API key. Add it in Profile → API Keys." : midTurnLoss("Anthropic", "the Anthropic key"));
		return completeWith(anthropicAdapter, env, userId, key, opts.anthropicModel ?? DEFAULT_ANTHROPIC_MODEL, body, ctx);
	}
	if (opts?.provider === "cloudflare") {
		const creds = await getUserCloudflareAiCredentials(env, userId).catch(() => null);
		if (!creds) throw new UserAiCredentialsError(midTurnLoss("Cloudflare Workers AI", "the Cloudflare credentials"));
		return completeWith(cloudflareAdapter, env, userId, creds, model, body, ctx);
	}
	if (opts?.honorModel && isWorkersAiModel(model)) {
		// The owner PICKED this model, so it runs here or the turn fails saying why (#853 finding 8).
		// Falling through to the order below ran — and billed — Anthropic under the Cloudflare pick
		// whenever the credentials were removed, revoked or unreadable after the pick was checked; and a
		// read that failed on a LATER round flipped the provider mid-turn (#853 finding 9).
		const picked = await getUserCloudflareAiCredentials(env, userId).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
		if (!(picked instanceof Error)) return completeWith(cloudflareAdapter, env, userId, picked, model, body, ctx);
		// No row at all is the one error thrown with the class's default message.
		const removed = picked instanceof UserAiCredentialsError && picked.message === new UserAiCredentialsError().message;
		throw new UserAiCredentialsError(
			removed
				? `${model} runs on Cloudflare Workers AI, and no Cloudflare credentials are stored — they were removed after this brain model was picked. Add your Cloudflare account ID and API token in Profile → API Keys, or pick another brain model.`
				: `${model} runs on Cloudflare Workers AI, but your stored Cloudflare credentials cannot be read (${picked.message}). Re-add them in Profile → API Keys, or pick another brain model.`,
		);
	}
	// BYOK: try providers in order of what the user has configured
	const anthropicKey = await getUserProviderKey(env, userId, "anthropic");
	if (anthropicKey) {
		// content is usually a string, but may be an array of content blocks (e.g. a
		// PDF `document` block for résumé parsing) — passed straight through to Anthropic.
		return completeWith(anthropicAdapter, env, userId, anthropicKey, DEFAULT_ANTHROPIC_MODEL, body, ctx);
	}

	const cfCredentials = await getUserCloudflareAiCredentials(env, userId).catch(() => null);
	if (cfCredentials) {
		return completeWith(cloudflareAdapter, env, userId, cfCredentials, model, body, ctx);
	}

	throw new UserAiCredentialsError("Add an API key in Profile → API Keys (Anthropic or Cloudflare Workers AI).");
}

/**
 * One call to one provider, whichever it is (#1356). The adapter knows the wire; THIS is where everything that is the same for both happens,
 * once: a refusal is read into its `kind` by the adapter and the account's hold follows from the kind; a success records the key's use and
 * clears a hold in a single round trip, then writes the ledger.
 */
async function completeWith<Cred, Req extends { model: string }, Raw>(
	adapter: ProviderAdapter<Cred, Req, Raw>,
	env: Env,
	userId: string | undefined,
	credential: Cred,
	model: string,
	body: unknown,
	ctx?: UsageContext,
): Promise<unknown> {
	const req = adapter.buildRequest(body, model, ctx);
	const res = await adapter.send(req, credential);
	if (!res.ok) {
		const wire = await adapter.parseError(res, req, credential);
		// The hold follows from the kind the adapter decided — credit and credentials are different holds with different remedies.
		if (wire.kind === "credit" || wire.kind === "credentials") {
			await observeProviderAccount(env, userId, adapter.id, adapter.credentialRef(credential), wire.kind === "credit" ? "provider_credit" : "provider_credentials", Date.now(), req.model);
		}
		throw new UserAiProviderError(`${wire.message}${providerErrorTag(wire.kind)}`, wire.status, wire.upstreamStatus, wire.details, wire.retryable, wire.kind);
	}
	const raw = await adapter.readSuccess(res, req);
	await recordProviderCallSuccess(env, userId, adapter.id, adapter.credentialRef(credential));
	// Ledger the call for the Usage page. Best-effort: recordUsage swallows all errors, so it can never break the AI call.
	if (ctx) await recordUsage(env, { ...ctx, userId, provider: adapter.id, model: req.model }, adapter.usage(raw));
	return adapter.toResult(raw, req);
}

export async function getUserProviderKey(
	env: Env,
	userId: string | undefined,
	provider: string,
): Promise<string | null> {
	if (!userId || !env.KEY_ENCRYPTION_KEY) return null;
	const row = await env.DB.prepare(
		// `account_id` and `key_hint` ride along for the display-hint backfill (#780). The WHERE
		// deliberately does NOT name an account — this is the long-standing "give me a key for
		// this provider" read — so the account of the row `.first()` actually returned has to
		// come back with it. Backfilling under this same loose WHERE could stamp one account's
		// hint onto another's row, and a confidently wrong "which key is this" is worse than none.
		"SELECT key_ciphertext, dek_wrapped, iv, account_id, key_hint FROM user_api_keys WHERE user_id = ?1 AND provider = ?2",
	).bind(userId, provider).first<{ key_ciphertext: ArrayBuffer; dek_wrapped: ArrayBuffer; iv: ArrayBuffer; account_id: string; key_hint: string | null }>();
	if (!row) return null;
	try {
		const plaintext = await decryptKey(
			new Uint8Array(row.key_ciphertext),
			new Uint8Array(row.dek_wrapped),
			new Uint8Array(row.iv),
			env.KEY_ENCRYPTION_KEY,
		);
		// This is the path that decrypts the BYOK Anthropic key on every chat turn, so it is the
		// one that gives a pre-0146 key its hint without the owner re-entering anything. It costs
		// nothing once the hint exists: `backfillKeyHint` returns on `row.key_hint` before D1.
		await backfillKeyHint(env, userId, provider, row.account_id ?? "", plaintext, row.key_hint);
		return plaintext;
	} catch {
		return null;
	}
}

export async function getUserCloudflareAiCredentials(
	env: Env,
	userId: string | undefined,
): Promise<StoredCloudflareAiCredentials> {
	if (!userId) throw new UserAiCredentialsError();
	if (!env.KEY_ENCRYPTION_KEY) {
		throw new Error("Key encryption not configured");
	}

	const row = await env.DB.prepare(
		// `account_id`/`key_hint`: see getUserProviderKey — the WHERE names no account, so the
		// hint backfill (#780) needs the row it actually got rather than a guessed slot.
		"SELECT key_ciphertext, dek_wrapped, iv, account_id, key_hint FROM user_api_keys WHERE user_id = ?1 AND provider = 'cloudflare'",
	)
		.bind(userId)
		.first<{
			key_ciphertext: ArrayBuffer;
			dek_wrapped: ArrayBuffer;
			iv: ArrayBuffer;
			account_id: string;
			key_hint: string | null;
		}>();
	if (!row) throw new UserAiCredentialsError();

	const raw = await decryptKey(
		new Uint8Array(row.key_ciphertext),
		new Uint8Array(row.dek_wrapped),
		new Uint8Array(row.iv),
		env.KEY_ENCRYPTION_KEY,
	);

	const credentials = parseCloudflareAiCredentials(raw);
	if (!credentials) {
		throw new UserAiCredentialsError(
			"Stored Cloudflare Workers AI credentials are invalid. Re-add your Cloudflare account ID and API token.",
		);
	}
	// `raw` is the `{accountId,token}` envelope; `keyHint` unwraps it so the hint names the token
	// the owner pasted, not the last four characters of the JSON encoding.
	await backfillKeyHint(env, userId, "cloudflare", row.account_id ?? "", raw, row.key_hint);
	return credentials;
}
