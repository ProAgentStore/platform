import { decryptKey } from "./crypto.js";
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
): Promise<unknown> {
	// BYOK: try providers in order of what the user has configured
	const anthropicKey = await getUserProviderKey(env, userId, "anthropic");
	if (anthropicKey) {
		// content is usually a string, but may be an array of content blocks (e.g. a
		// PDF `document` block for résumé parsing) — passed straight through to Anthropic.
		return runAnthropic(env, userId, anthropicKey, body as { messages: Array<{ role: string; content: unknown }>; tools?: unknown[]; maxTokens?: number; timeoutMs?: number });
	}

	const cfCredentials = await getUserCloudflareAiCredentials(env, userId).catch(() => null);
	if (cfCredentials) {
		return runCloudflareAi(env, userId, cfCredentials, model, body);
	}

	throw new UserAiCredentialsError("Add an API key in Profile → API Keys (Anthropic or Cloudflare Workers AI).");
}

async function runAnthropic(
	env: Env,
	userId: string | undefined,
	apiKey: string,
	body: { messages: Array<{ role: string; content: unknown }>; tools?: unknown[]; maxTokens?: number; timeoutMs?: number },
): Promise<unknown> {
	const messages = (body.messages || []).filter((m) => m.role !== "system");
	const systemMsg = (body.messages || []).find((m) => m.role === "system");

	const anthropicBody: Record<string, unknown> = {
		model: "claude-sonnet-4-6",
		max_tokens: body.maxTokens ?? 1024,
		messages: messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
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
	const content = (data.content as Array<{ type: string; text?: string; name?: string; input?: unknown }>) || [];
	const textParts = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
	const toolUse = content.filter((c) => c.type === "tool_use");
	const u = (data.usage as Record<string, number>) || {};
	const usage = {
		input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
		output: u.output_tokens || 0,
	};

	if (toolUse.length > 0) {
		return {
			response: textParts,
			tool_calls: toolUse.map((t) => ({
				name: t.name,
				arguments: t.input || {},
			})),
			usage,
		};
	}
	return { response: textParts, usage };
}

async function runCloudflareAi(
	env: Env,
	userId: string | undefined,
	credentials: StoredCloudflareAiCredentials,
	model: string,
	body: unknown,
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
	if (data && typeof data === "object" && "result" in data) {
		return (data as { result: unknown }).result;
	}
	return data;
}

async function getUserProviderKey(
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
