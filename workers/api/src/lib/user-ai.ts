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

export async function runUserWorkersAi(
	env: Env,
	userId: string | undefined,
	model: string,
	body: unknown,
): Promise<unknown> {
	const credentials = await getUserCloudflareAiCredentials(env, userId);
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
	)
		.bind(userId)
		.run();
	if (data && typeof data === "object" && "result" in data) {
		return (data as { result: unknown }).result;
	}
	return data;
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
