/**
 * User API Key Vault + Proxy.
 *
 * Users store their AI provider keys once (encrypted AES-256-GCM).
 * Agents access external APIs via the proxy which injects the key.
 */
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { decryptKey, encryptKey } from "../lib/crypto.js";
import { logError } from "../lib/error-log.js";
import { recordVoiceUsage } from "../lib/usage.js";
import { estimateTtsMicros, estimateSttMicros, secondsFromAudioBytes } from "../lib/ai-pricing.js";
import {
	encodeCloudflareAiCredentials,
	runUserWorkersAi,
	UserAiCredentialsError,
	UserAiProviderError,
} from "../lib/user-ai.js";
import type { Env } from "../types.js";

export const keysRoutes = new Hono<{ Bindings: Env }>();

const ALLOWED_CORS_ORIGINS = new Set([
	"https://proagentstore.online",
	"https://console.proagentstore.online",
	"http://localhost:5173",
	"http://localhost:4173",
]);

export function allowedCorsOrigin(origin: string | undefined): string {
	return origin && ALLOWED_CORS_ORIGINS.has(origin)
		? origin
		: "https://console.proagentstore.online";
}

// ── Providers ──────────────────────────────────────────────────────────────

interface Provider {
	id: string;
	name: string;
	host: string | null;
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
	{
		id: "xai",
		name: "xAI (Grok)",
		host: "api.x.ai",
		keyPrefix: "xai-",
		docsUrl: "https://console.x.ai",
	},
	{
		id: "cloudflare",
		name: "Cloudflare Workers AI",
		host: null,
		keyPrefix: "",
		docsUrl: "https://dash.cloudflare.com/profile/api-tokens",
	},
	{
		// Claude Code sign-in for the Coder engine: a long-lived OAuth token from
		// `claude setup-token` (works with a Pro/Max subscription). host:null — this is
		// NOT proxyable; it's injected as CLAUDE_CODE_OAUTH_TOKEN into the runner's
		// headless `claude` process so the engine works signed-in on any machine.
		id: "claude-code",
		name: "Claude Code (Coder engine sign-in)",
		host: null,
		keyPrefix: "sk-ant-oat",
		docsUrl: "https://code.claude.com/docs/en/authentication",
	},
];

const PROVIDER_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));
const HOST_TO_PROVIDER = new Map(
	PROVIDERS.filter((p) => p.host).map((p) => [p.host as string, p.id]),
);

/**
 * The proxy route `/proxy/:host{.+}` greedily captures the hostname AND the upstream
 * path in one param (Hono's `.+` matches across slashes), e.g.
 * "api.openai.com/v1/audio/transcriptions". Split the hostname (first segment) from
 * the upstream path so the allowlist check sees the bare host — reading the whole
 * thing as the host rejected every path-bearing call as "Unsupported host", which is
 * why Whisper STT + OpenAI TTS silently 400'd and never transcribed.
 */
export function splitProxyHostPath(raw: string): { host: string; upstreamPath: string } {
	const slash = raw.indexOf("/");
	return slash === -1
		? { host: raw, upstreamPath: "/" }
		: { host: raw.slice(0, slash), upstreamPath: raw.slice(slash) };
}

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

	const { key, accountId } = await c.req.json<{
		key: string;
		accountId?: string;
	}>();
	if (!key) throw new HttpError(400, "key required");

	let keyToStore = key;
	if (providerId === "cloudflare") {
		if (!accountId?.trim()) {
			throw new HttpError(
				400,
				"Cloudflare Workers AI requires accountId and key",
			);
		}
		keyToStore = encodeCloudflareAiCredentials(accountId.trim(), key.trim());
	} else if (provider.keyPrefix && !key.startsWith(provider.keyPrefix)) {
		throw new HttpError(
			400,
			`${provider.name} keys should start with "${provider.keyPrefix}"`,
		);
	}

	const { ciphertext, dekWrapped, iv } = await encryptKey(
		keyToStore,
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

/** Verify a stored provider key with a minimal provider request. */
keysRoutes.post("/:provider/verify", async (c) => {
	const session = await requireUser(c);
	const providerId = c.req.param("provider");
	if (providerId !== "cloudflare") {
		throw new HttpError(400, `Verification not available for ${providerId}`);
	}

	try {
		await runUserWorkersAi(
			c.env,
			session.uid,
			"@cf/meta/llama-3.2-3b-instruct",
			{
				messages: [
					{ role: "system", content: "Reply with exactly: ok" },
					{ role: "user", content: "verify" },
				],
				max_tokens: 4,
			},
		);
		return c.json({ ok: true, provider: providerId, checkedAt: new Date().toISOString() });
	} catch (err) {
		if (err instanceof UserAiCredentialsError) {
			throw new HttpError(err.status, err.message);
		}
		if (err instanceof UserAiProviderError) {
			return c.json({
				ok: false,
				error: err.message,
				upstreamStatus: err.upstreamStatus,
				details: err.details,
			}, 400);
		}
		throw err;
	}
});

/** Reveal a decrypted key (for browser-direct connections like OpenAI Realtime WS). */
keysRoutes.get("/:provider/reveal", async (c) => {
	const session = await requireUser(c);
	const providerId = c.req.param("provider");
	if (!PROVIDER_BY_ID.has(providerId)) throw new HttpError(400, `Unknown provider: ${providerId}`);
	if (!c.env.KEY_ENCRYPTION_KEY) throw new HttpError(500, "Key encryption not configured");
	const row = await c.env.DB.prepare(
		"SELECT key_ciphertext, dek_wrapped, iv FROM user_api_keys WHERE user_id = ?1 AND provider = ?2",
	)
		.bind(session.uid, providerId)
		.first<{ key_ciphertext: ArrayBuffer; dek_wrapped: ArrayBuffer; iv: ArrayBuffer }>();
	if (!row) throw new HttpError(404, "No key stored for this provider");
	const key = await decryptKey(
		new Uint8Array(row.key_ciphertext),
		new Uint8Array(row.dek_wrapped),
		new Uint8Array(row.iv),
		c.env.KEY_ENCRYPTION_KEY,
	);
	// Mark as used
	await c.env.DB.prepare("UPDATE user_api_keys SET last_used_at = datetime('now') WHERE user_id = ?1 AND provider = ?2")
		.bind(session.uid, providerId)
		.run();
	return c.json({ key });
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
	// `:host{.+}` GREEDILY captures the hostname AND the upstream path as one string,
	// e.g. "api.openai.com/v1/audio/transcriptions". Split them (see splitProxyHostPath).
	const { host, upstreamPath } = splitProxyHostPath(c.req.param("host"));
	const url = new URL(c.req.url);

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
	if (!row) {
		// Log pre-upstream rejections too (not just upstream 4xx) so a Whisper/voice
		// failure is visible in the error log, not only in the caller's browser.
		await logError(c.env, {
			source: "keys-proxy",
			userId: session.uid,
			status: 400,
			message: `No ${providerId} key stored (${host}${upstreamPath})`,
			context: { provider: providerId, host, path: upstreamPath, method: c.req.method },
		}).catch(() => undefined);
		throw new HttpError(400, `No ${providerId} key stored. Add it in your profile.`);
	}

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

	// BUFFER the request body rather than streaming `c.req.raw.body`. A streamed body
	// becomes chunked transfer-encoding with no Content-Length, which OpenAI's gateway
	// rejects for multipart uploads — the Whisper transcription was 404'ing with
	// "Invalid URL (POST /v1/audio/transcriptions)" even though the URL was correct.
	// Proxy request bodies are always small (chat JSON, or audio < 5MB), so buffering is
	// safe; the RESPONSE is still streamed untouched below.
	const reqBody =
		c.req.method !== "GET" && c.req.method !== "HEAD"
			? await c.req.arrayBuffer()
			: undefined;
	const upstream = await fetch(upstreamUrl, {
		method: c.req.method,
		headers,
		body: reqBody,
	});

	// Forward response with CORS
	const respHeaders = new Headers(upstream.headers);
	respHeaders.set("Access-Control-Allow-Origin", allowedCorsOrigin(c.req.header("Origin")));
	respHeaders.set("Vary", "Origin");
	// Never swallow an upstream failure: log the status + body (visible in `wrangler
	// tail`) and pass the real body through to the caller. Success responses stream
	// straight through untouched (don't buffer AI/audio streams).
	if (!upstream.ok) {
		const errBody = await upstream.text().catch(() => "");
		console.error(`[keys-proxy] ${providerId} ${host}${upstreamPath} → ${upstream.status} ${errBody.slice(0, 800)}`);
		await logError(c.env, {
			source: "keys-proxy",
			userId: session.uid,
			status: upstream.status,
			message: errBody || `${host}${upstreamPath} → ${upstream.status}`,
			context: { provider: providerId, host, path: upstreamPath, method: c.req.method },
		});
		return new Response(errBody, { status: upstream.status, headers: respHeaders });
	}
	// Meter voice (OpenAI audio) for the Usage page. TTS char-count is exact (from the
	// request `input`); STT duration is estimated from the uploaded audio size. Best-effort
	// and cost-only (these aren't LLM tokens). Fire-and-forget — never delays the response.
	if (providerId === "openai" && reqBody && (upstreamPath.includes("/audio/speech") || upstreamPath.includes("/audio/transcriptions"))) {
		try {
			if (upstreamPath.includes("/audio/speech")) {
				const j = JSON.parse(new TextDecoder().decode(reqBody)) as { input?: unknown; model?: unknown };
				const chars = typeof j.input === "string" ? j.input.length : 0;
				void recordVoiceUsage(c.env, { userId: session.uid, model: `tts:${String(j.model || "tts-1")}`, costMicros: estimateTtsMicros(chars) });
			} else {
				const seconds = secondsFromAudioBytes(reqBody.byteLength);
				void recordVoiceUsage(c.env, { userId: session.uid, model: "stt:whisper", costMicros: estimateSttMicros(seconds) });
			}
		} catch { /* metering is best-effort */ }
	}

	return new Response(upstream.body, {
		status: upstream.status,
		headers: respHeaders,
	});
});
