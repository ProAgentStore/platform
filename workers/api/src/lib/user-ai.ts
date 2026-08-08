import { decryptKey } from "./crypto.js";
import { mergeContent, pairToolBlocks } from "./anthropic-tool-turns.js";
import { recordUsage, type UsageContext } from "./usage.js";
import type { Env } from "../types.js";

export class UserAiCredentialsError extends Error {
	constructor(
		message = "Add your Cloudflare Workers AI account ID and API token before running this agent.",
		public readonly status = 402,
	) {
		super(message);
		this.name = "UserAiCredentialsError";
	}
}

export class UserAiProviderError extends Error {
	constructor(
		message: string,
		public readonly status = 502,
		public readonly upstreamStatus?: number,
		public readonly details?: unknown,
	) {
		super(message);
		this.name = "UserAiProviderError";
	}
}

interface StoredCloudflareAiCredentials {
	accountId: string;
	token: string;
}

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
): Promise<unknown> {
	// BYOK: try providers in order of what the user has configured
	const anthropicKey = await getUserProviderKey(env, userId, "anthropic");
	if (anthropicKey) {
		// content is usually a string, but may be an array of content blocks (e.g. a
		// PDF `document` block for résumé parsing) — passed straight through to Anthropic.
		return runAnthropic(env, userId, anthropicKey, body as { messages: Array<{ role: string; content: unknown }>; tools?: unknown[]; toolChoice?: "auto" | "none"; maxTokens?: number; timeoutMs?: number }, ctx);
	}

	const cfCredentials = await getUserCloudflareAiCredentials(env, userId).catch(() => null);
	if (cfCredentials) {
		return runCloudflareAi(env, userId, cfCredentials, model, body, ctx);
	}

	throw new UserAiCredentialsError("Add an API key in Profile → API Keys (Anthropic or Cloudflare Workers AI).");
}

/**
 * Anthropic's Messages API rejects any array whose first message isn't `user` or
 * whose roles don't strictly alternate. Our chat history routinely violates both:
 * a 10-message context window can start on `assistant` (turn 6+), an errored turn
 * leaves two adjacent `user` messages once the `system` error note is filtered out,
 * and the tool loop appends `assistant, user, user`. Normalize before sending:
 * drop leading assistants, then merge consecutive same-role messages into one.
 *
 * It now also knows about `tool_use` / `tool_result` blocks (#398). It has to: those are the two
 * block types the API pairs across turns, and this function is the only thing between the caller's
 * array and the wire that DROPS and MERGES turns. Its merge of consecutive same-role turns is
 * exactly what used to erase the boundary between a platform result and the model's own prose, and
 * left unchanged it would now bury a `tool_result` behind a trailing string or orphan one behind a
 * dropped leading assistant — both of which the provider answers with a 400 on the whole request.
 * The rules are pure and live in lib/anthropic-tool-turns.ts with their tests.
 */
function normalizeForAnthropic(
	msgs: Array<{ role: string; content: unknown }>,
): Array<{ role: "user" | "assistant"; content: unknown }> {
	const mapped = msgs.map((m) => ({
		role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
		content: m.content,
	}));
	let start = 0;
	while (start < mapped.length && mapped[start].role === "assistant") start++;
	// Pair BEFORE merging: an orphan is created by the drop above, and merging first would fold it
	// into a neighbouring turn where "which turn introduced this id" is no longer answerable.
	const paired = pairToolBlocks(mapped.slice(start));
	const merged: Array<{ role: "user" | "assistant"; content: unknown }> = [];
	for (const m of paired) {
		const last = merged[merged.length - 1];
		if (last && last.role === m.role) {
			last.content = mergeContent(last.content, m.content);
		} else {
			merged.push({ role: m.role, content: m.content });
		}
	}
	return merged;
}

async function runAnthropic(
	env: Env,
	userId: string | undefined,
	apiKey: string,
	body: { messages: Array<{ role: string; content: unknown }>; tools?: unknown[]; toolChoice?: "auto" | "none"; maxTokens?: number; timeoutMs?: number },
	ctx?: UsageContext,
): Promise<unknown> {
	const messages = normalizeForAnthropic((body.messages || []).filter((m) => m.role !== "system"));
	const systemMsg = (body.messages || []).find((m) => m.role === "system");

	const anthropicBody: Record<string, unknown> = {
		model: "claude-sonnet-4-6",
		// The fallback is what a caller inherits by NOT choosing, and #397 is the bill for that:
		// chat was the one caller that never chose, so every reply a human read end to end was cut
		// at ~4,000 characters. Every surface now names its own ceiling; this number is left where
		// it is only so a new call site fails cheaply rather than unboundedly.
		max_tokens: body.maxTokens ?? 1024,
		messages,
	};
	// Prompt-cache the (large, stable) system prompt so repeated calls within a run
	// — the apply loop fires one per step — reprocess it from cache instead of
	// re-paying for it each time. Makes the per-step cost flat instead of growing.
	if (systemMsg) anthropicBody.system = [{ type: "text", text: String(systemMsg.content), cache_control: { type: "ephemeral" } }];

	// Convert tools to Anthropic format (deduplicate by name)
	if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
		const seen = new Set<string>();
		anthropicBody.tools = [];
		for (const t of body.tools as Array<{ type: string; function?: { name: string; description: string; parameters: unknown }; name?: string; description?: string; parameters?: unknown }>) {
			const name = t.function?.name || t.name;
			if (!name || seen.has(name)) continue;
			seen.add(name);
			(anthropicBody.tools as unknown[]).push({
				name,
				description: t.function?.description || t.description || "",
				input_schema: t.function?.parameters || t.parameters || { type: "object", properties: {} },
			});
		}
		// `none` declares the tools without permitting a call (#398). The caller that needs it is
		// the one producing a FINAL answer after a structured tool round: the provider requires
		// `tools` to be defined whenever the messages contain `tool_use`/`tool_result`, and simply
		// omitting them — which is how the final call used to discourage another round — turns the
		// whole request into a 400 the moment the transcript is in the structured protocol.
		if (body.toolChoice === "none") anthropicBody.tool_choice = { type: "none" };
	}

	const timeoutMs = body.timeoutMs ?? 25_000;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	let res: Response;
	try {
		res = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
				"Content-Type": "application/json",
			},
			body: JSON.stringify(anthropicBody),
			signal: controller.signal,
		});
	} catch (err) {
		clearTimeout(timeout);
		if (err instanceof Error && err.name === "AbortError") {
			throw new UserAiProviderError(`AI request timed out (${Math.round(timeoutMs / 1000)}s)`, 504);
		}
		throw err;
	}
	clearTimeout(timeout);

	const data = await res.json().catch(() => ({})) as Record<string, unknown>;
	if (!res.ok) {
		const errObj = (data as { error?: { message?: string; type?: string } }).error;
		const errMsg = errObj?.message || JSON.stringify(data);
		const hint = res.status === 404
			? " — Your API key may not have access to this model. Get a key from console.anthropic.com/settings/keys"
			: res.status === 401
				? " — Invalid API key. Update it in Profile → API Keys → Anthropic"
				: "";
		throw new UserAiProviderError(
			`Anthropic (${res.status}): ${errMsg}${hint}`,
			res.status === 401 || res.status === 403 ? 400 : 502,
			res.status,
			data,
		);
	}
	if (!data.content) {
		throw new UserAiProviderError(
			`Anthropic: unexpected response: ${JSON.stringify(data).slice(0, 200)}`,
			502,
		);
	}

	await env.DB.prepare(
		"UPDATE user_api_keys SET last_used_at = datetime('now') WHERE user_id = ?1 AND provider = 'anthropic'",
	).bind(userId).run();

	// Convert Anthropic response to Workers AI format for compatibility
	const content = (data.content as Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }>) || [];
	const textParts = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
	const toolUse = content.filter((c) => c.type === "tool_use");
	const u = (data.usage as Record<string, number>) || {};
	// Kept SEPARATE, not summed (#212). Anthropic bills a cache read at 0.1x input and a cache
	// write at 1.25x; folding all three into `input` priced every read at the full rate and made
	// the cache invisible — you could not tell a hit from a miss, so you could not tell whether
	// caching was working before changing a prompt to make it work better.
	const usage = {
		input: u.input_tokens || 0,
		output: u.output_tokens || 0,
		cacheRead: u.cache_read_input_tokens || 0,
		cacheWrite: u.cache_creation_input_tokens || 0,
	};

	// Ledger the call for the Usage page. Best-effort: recordUsage swallows all errors,
	// so it can never break the AI call — it's a small awaited D1 insert on the return path.
	if (ctx) {
		await recordUsage(env, { ...ctx, userId, provider: "anthropic", model: (anthropicBody.model as string) || "claude-sonnet-4-6" }, usage);
	}

	// WHY the response carries the provider's verdict (#397): `stop_reason: "max_tokens"` sits in
	// this same body, one key away from the `content` and `usage` already read, and dropping it made
	// a reply cut off at the cap indistinguishable from one that finished. A caller cannot recover
	// the fact later — the truncated text looks like prose that simply ended. Surfaced on BOTH
	// returns, because a round that stops mid-`tool_use` is the same loss with worse consequences.
	const stopReason = typeof data.stop_reason === "string" ? data.stop_reason : undefined;

	if (toolUse.length > 0) {
		return {
			response: textParts,
			tool_calls: toolUse.map((t) => ({
				name: t.name,
				arguments: t.input || {},
				// The id is what makes a result ATTRIBUTABLE (#398). Dropping it is why the follow-up
				// context read `[repo_read_file]: <contents>` with no path: call one tool twice in a
				// round with different arguments and the model had to infer which result was which.
				id: t.id,
			})),
			// The assistant turn EXACTLY as the provider produced it, so the caller can append it and
			// answer its `tool_use` blocks with real `tool_result`s instead of narrating them back as
			// the model's own prose. Named `contentBlocks` rather than `content` so it cannot be
			// mistaken for a message's content field. Absent on every non-Anthropic provider, which
			// is how the caller branches without a provider enum to keep in sync.
			contentBlocks: content,
			usage,
			stopReason,
		};
	}
	return { response: textParts, usage, stopReason };
}

async function runCloudflareAi(
	env: Env,
	userId: string | undefined,
	credentials: StoredCloudflareAiCredentials,
	model: string,
	body: unknown,
	ctx?: UsageContext,
): Promise<unknown> {
	const encodedModel = model.split("/").map(encodeURIComponent).join("/");
	const timeoutMs = (body as { timeoutMs?: number })?.timeoutMs ?? 25_000;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	let res: Response;
	try {
		res = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId)}/ai/run/${encodedModel}`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${credentials.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			},
		);
	} catch (err) {
		clearTimeout(timeout);
		if (err instanceof Error && err.name === "AbortError") {
			throw new UserAiProviderError(`AI request timed out (${Math.round(timeoutMs / 1000)}s)`, 504);
		}
		throw err;
	}
	clearTimeout(timeout);
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new UserAiProviderError(
			`Cloudflare Workers AI request failed with HTTP ${res.status}`,
			res.status === 401 || res.status === 403 ? 400 : 502,
			res.status,
			data,
		);
	}
	await env.DB.prepare(
		"UPDATE user_api_keys SET last_used_at = datetime('now') WHERE user_id = ?1 AND provider = 'cloudflare'",
	).bind(userId).run();
	// CF Workers AI is per-neuron (cost ~0), but still emit a ledger row with token
	// counts when the response carries usage, so the Usage page shows CF calls too.
	if (ctx) {
		const cu = (data as { usage?: Record<string, number> })?.usage || {};
		await recordUsage(env, { ...ctx, userId, provider: "cloudflare", model }, {
			input: cu.prompt_tokens || cu.input_tokens || 0,
			output: cu.completion_tokens || cu.output_tokens || 0,
		});
	}
	if (data && typeof data === "object" && "result" in data) {
		return (data as { result: unknown }).result;
	}
	return data;
}

export async function getUserProviderKey(
	env: Env,
	userId: string | undefined,
	provider: string,
): Promise<string | null> {
	if (!userId || !env.KEY_ENCRYPTION_KEY) return null;
	const row = await env.DB.prepare(
		"SELECT key_ciphertext, dek_wrapped, iv FROM user_api_keys WHERE user_id = ?1 AND provider = ?2",
	).bind(userId, provider).first<{ key_ciphertext: ArrayBuffer; dek_wrapped: ArrayBuffer; iv: ArrayBuffer }>();
	if (!row) return null;
	try {
		return await decryptKey(
			new Uint8Array(row.key_ciphertext),
			new Uint8Array(row.dek_wrapped),
			new Uint8Array(row.iv),
			env.KEY_ENCRYPTION_KEY,
		);
	} catch {
		return null;
	}
}

async function getUserCloudflareAiCredentials(
	env: Env,
	userId: string | undefined,
): Promise<StoredCloudflareAiCredentials> {
	if (!userId) throw new UserAiCredentialsError();
	if (!env.KEY_ENCRYPTION_KEY) {
		throw new Error("Key encryption not configured");
	}

	const row = await env.DB.prepare(
		"SELECT key_ciphertext, dek_wrapped, iv FROM user_api_keys WHERE user_id = ?1 AND provider = 'cloudflare'",
	)
		.bind(userId)
		.first<{
			key_ciphertext: ArrayBuffer;
			dek_wrapped: ArrayBuffer;
			iv: ArrayBuffer;
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
	return credentials;
}

export function encodeCloudflareAiCredentials(
	accountId: string,
	token: string,
): string {
	return JSON.stringify({ accountId, token });
}

export function parseCloudflareAiCredentials(
	raw: string,
): StoredCloudflareAiCredentials | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;

	if (trimmed.startsWith("{")) {
		try {
			const data = JSON.parse(trimmed) as Partial<StoredCloudflareAiCredentials>;
			if (data.accountId?.trim() && data.token?.trim()) {
				return { accountId: data.accountId.trim(), token: data.token.trim() };
			}
		} catch {
			return null;
		}
		return null;
	}

	const separator = trimmed.indexOf(":");
	if (separator > 0) {
		const accountId = trimmed.slice(0, separator).trim();
		const token = trimmed.slice(separator + 1).trim();
		if (accountId && token) return { accountId, token };
	}

	return null;
}
