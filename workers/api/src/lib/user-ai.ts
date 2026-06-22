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
	// Try Anthropic first (better quality), fall back to Cloudflare
	const anthropicKey = await getUserProviderKey(env, userId, "anthropic");
	if (anthropicKey) {
		return runAnthropic(env, userId, anthropicKey, body as { messages: Array<{ role: string; content: string }>; tools?: unknown[] });
	}

	const credentials = await getUserCloudflareAiCredentials(env, userId);
	return runCloudflareAi(env, userId, credentials, model, body);
}

async function runAnthropic(
	env: Env,
	userId: string | undefined,
	apiKey: string,
	body: { messages: Array<{ role: string; content: string }>; tools?: unknown[] },
): Promise<unknown> {
	const messages = (body.messages || []).filter((m) => m.role !== "system");
	const systemMsg = (body.messages || []).find((m) => m.role === "system");

	const anthropicBody: Record<string, unknown> = {
		model: "claude-sonnet-4-20250514",
		max_tokens: 1024,
		messages: messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
	};
	if (systemMsg) anthropicBody.system = systemMsg.content;

	// Convert tools to Anthropic format
	if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
		anthropicBody.tools = (body.tools as Array<{ type: string; function: { name: string; description: string; parameters: unknown } }>).map((t) => ({
			name: t.function?.name || (t as Record<string, unknown>).name,
			description: t.function?.description || (t as Record<string, unknown>).description,
			input_schema: t.function?.parameters || (t as Record<string, unknown>).parameters || { type: "object", properties: {} },
		}));
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 25_000);
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
			throw new UserAiProviderError("AI request timed out (25s)", 504);
		}
		throw err;
	}
	clearTimeout(timeout);

	const data = await res.json().catch(() => ({})) as Record<string, unknown>;
	if (!res.ok) {
		throw new UserAiProviderError(
			`Anthropic API failed: ${(data as { error?: { message?: string } }).error?.message || res.status}`,
			res.status === 401 ? 400 : 502,
			res.status,
			data,
		);
	}

	await env.DB.prepare(
		"UPDATE user_api_keys SET last_used_at = datetime('now') WHERE user_id = ?1 AND provider = 'anthropic'",
	).bind(userId).run();

	// Convert Anthropic response to Workers AI format for compatibility
	const content = (data.content as Array<{ type: string; text?: string; name?: string; input?: unknown }>) || [];
	const textParts = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
	const toolUse = content.filter((c) => c.type === "tool_use");

	if (toolUse.length > 0) {
		return {
			response: textParts,
			tool_calls: toolUse.map((t) => ({
				name: t.name,
				arguments: t.input || {},
			})),
		};
	}
	return { response: textParts };
}

async function runCloudflareAi(
	env: Env,
	userId: string | undefined,
	credentials: StoredCloudflareAiCredentials,
	model: string,
	body: unknown,
): Promise<unknown> {
	const encodedModel = model.split("/").map(encodeURIComponent).join("/");
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 25_000);
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
			throw new UserAiProviderError("AI request timed out (25s)", 504);
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
