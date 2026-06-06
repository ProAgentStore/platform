/**
 * User API Key Vault + Proxy — vendored from FAGS/FAS pattern.
 *
 * Users store their AI provider keys once (encrypted AES-256-GCM).
 * Agents access external APIs via the proxy which injects the key.
 */
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { decryptKey, encryptKey } from "../lib/crypto.js";
import type { Env } from "../types.js";

export const keysRoutes = new Hono<{ Bindings: Env }>();

// ── Providers ──────────────────────────────────────────────────────────────

interface Provider {
	id: string;
	name: string;
	host: string;
	keyPrefix: string;
	docsUrl: string;
}

const PROVIDERS: Provider[] = [
	{
		id: "openai",
		name: "OpenAI",
		host: "api.openai.com",
		keyPrefix: "sk-",
		docsUrl: "https://platform.openai.com/api-keys",
	},
	{
		id: "anthropic",
		name: "Anthropic",
		host: "api.anthropic.com",
		keyPrefix: "sk-ant-",
		docsUrl: "https://console.anthropic.com/settings/keys",
	},
	{
		id: "google",
		name: "Google AI (Gemini)",
		host: "generativelanguage.googleapis.com",
		keyPrefix: "AI",
		docsUrl: "https://aistudio.google.com/apikey",
	},
	{
		id: "openrouter",
		name: "OpenRouter",
		host: "openrouter.ai",
		keyPrefix: "sk-or-",
		docsUrl: "https://openrouter.ai/keys",
	},
	{
		id: "groq",
		name: "Groq",
		host: "api.groq.com",
		keyPrefix: "gsk_",
		docsUrl: "https://console.groq.com/keys",
	},
	{
		id: "together",
		name: "Together AI",
		host: "api.together.xyz",
		keyPrefix: "",
		docsUrl: "https://api.together.xyz/settings/api-keys",
	},
];

const PROVIDER_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));
const HOST_TO_PROVIDER = new Map(PROVIDERS.map((p) => [p.host, p.id]));

/** List supported providers (public). */
keysRoutes.get("/providers", async (c) => {
	return c.json({
		providers: PROVIDERS.map((p) => ({
			id: p.id,
			name: p.name,
			docsUrl: p.docsUrl,
		})),
	});
});

/** Which providers the user has keys for. */
keysRoutes.get("/status", async (c) => {
	const session = await requireUser(c);
	const { results } = await c.env.DB.prepare(
		"SELECT provider, created_at, last_used_at FROM user_api_keys WHERE user_id = ?1",
	)
		.bind(session.uid)
		.all<{
			provider: string;
			created_at: string;
			last_used_at: string | null;
		}>();

	const stored = new Set(results.map((r) => r.provider));
	return c.json({
		providers: PROVIDERS.map((p) => ({
			id: p.id,
			name: p.name,
			hasKey: stored.has(p.id),
			createdAt: results.find((r) => r.provider === p.id)?.created_at || null,
			lastUsedAt:
				results.find((r) => r.provider === p.id)?.last_used_at || null,
		})),
	});
});

/** Store/update an encrypted key. */
keysRoutes.put("/:provider", async (c) => {
	const session = await requireUser(c);
	const providerId = c.req.param("provider");
	const provider = PROVIDER_BY_ID.get(providerId);
	if (!provider) throw new HttpError(400, `Unknown provider: ${providerId}`);

	if (!c.env.KEY_ENCRYPTION_KEY)
		throw new HttpError(500, "Key encryption not configured");

	const { key } = await c.req.json<{ key: string }>();
	if (!key) throw new HttpError(400, "key required");

	// Basic validation
	if (provider.keyPrefix && !key.startsWith(provider.keyPrefix)) {
		throw new HttpError(
			400,
			`${provider.name} keys should start with "${provider.keyPrefix}"`,
		);
	}

	const { ciphertext, dekWrapped, iv } = await encryptKey(
		key,
		c.env.KEY_ENCRYPTION_KEY,
	);

	await c.env.DB.prepare(
		`INSERT INTO user_api_keys (user_id, provider, key_ciphertext, dek_wrapped, iv, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
     ON CONFLICT(user_id, provider) DO UPDATE SET
       key_ciphertext = excluded.key_ciphertext,
       dek_wrapped = excluded.dek_wrapped,
       iv = excluded.iv,
       created_at = excluded.created_at`,
	)
		.bind(session.uid, providerId, ciphertext, dekWrapped, iv)
		.run();

	return c.json({ success: true, provider: providerId });
});

/** Delete a key. */
keysRoutes.delete("/:provider", async (c) => {
	const session = await requireUser(c);
	const providerId = c.req.param("provider");
	await c.env.DB.prepare(
		"DELETE FROM user_api_keys WHERE user_id = ?1 AND provider = ?2",
	)
		.bind(session.uid, providerId)
		.run();
	return c.json({ success: true });
});

/**
 * Proxy — inject user's key and forward to upstream AI API.
 * Usage: POST /v1/keys/proxy/api.openai.com/v1/chat/completions
 */
keysRoutes.all("/proxy/:host{.+}", async (c) => {
	const session = await requireUser(c);
	const host = c.req.param("host");

	// Extract the path after the host
	const url = new URL(c.req.url);
	const fullPath = url.pathname;
	const proxyPrefix = `/v1/keys/proxy/${host}`;
	const upstreamPath = fullPath.slice(proxyPrefix.length) || "/";

	const providerId = HOST_TO_PROVIDER.get(host);
	if (!providerId) throw new HttpError(400, `Unsupported host: ${host}`);

	if (!c.env.KEY_ENCRYPTION_KEY)
		throw new HttpError(500, "Key encryption not configured");

	// Rate limit: 100 proxy calls/hour
	const hour = new Date().toISOString().slice(0, 13);
	const usage = await c.env.DB.prepare(
		"SELECT count FROM proxy_usage WHERE user_id = ?1 AND hour = ?2",
	)
		.bind(session.uid, hour)
		.first<{ count: number }>();
	if (usage && usage.count >= 100) {
		throw new HttpError(429, "Proxy rate limit: 100 calls/hour");
	}
	await c.env.DB.prepare(
		`INSERT INTO proxy_usage (user_id, hour, count) VALUES (?1, ?2, 1)
     ON CONFLICT(user_id, hour) DO UPDATE SET count = count + 1`,
	)
		.bind(session.uid, hour)
		.run();

	// Decrypt user's key
	const row = await c.env.DB.prepare(
		"SELECT key_ciphertext, dek_wrapped, iv FROM user_api_keys WHERE user_id = ?1 AND provider = ?2",
	)
		.bind(session.uid, providerId)
		.first<{
			key_ciphertext: ArrayBuffer;
			dek_wrapped: ArrayBuffer;
			iv: ArrayBuffer;
		}>();
	if (!row)
		throw new HttpError(
			400,
			`No ${providerId} key stored. Add it in your profile.`,
		);

	const apiKey = await decryptKey(
		new Uint8Array(row.key_ciphertext),
		new Uint8Array(row.dek_wrapped),
		new Uint8Array(row.iv),
		c.env.KEY_ENCRYPTION_KEY,
	);

	// Update last_used_at
	await c.env.DB.prepare(
		"UPDATE user_api_keys SET last_used_at = datetime('now') WHERE user_id = ?1 AND provider = ?2",
	)
		.bind(session.uid, providerId)
		.run();

	// Build upstream request
	const upstreamUrl = `https://${host}${upstreamPath}${url.search}`;
	const headers = new Headers(c.req.raw.headers);
	headers.delete("host");
	headers.delete("cf-connecting-ip");
	headers.delete("cf-ray");
	headers.delete("x-forwarded-for");
	headers.delete("x-real-ip");
	headers.delete("cf-ipcountry");
	headers.delete("cf-visitor");

	// Inject key based on provider
	if (providerId === "anthropic") {
		headers.set("x-api-key", apiKey);
		headers.delete("authorization");
	} else {
		headers.set("Authorization", `Bearer ${apiKey}`);
	}

	const upstream = await fetch(upstreamUrl, {
		method: c.req.method,
		headers,
		body:
			c.req.method !== "GET" && c.req.method !== "HEAD"
				? c.req.raw.body
				: undefined,
	});

	// Forward response with CORS
	const respHeaders = new Headers(upstream.headers);
	respHeaders.set("Access-Control-Allow-Origin", "*");
	return new Response(upstream.body, {
		status: upstream.status,
		headers: respHeaders,
	});
});
