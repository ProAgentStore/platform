import type { Env } from "../types.js";

/** SHA-256 hex of a string (Web Crypto — available in Workers). */
async function sha256hex(s: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Codes are single-use and very short-lived — they only bridge the redirect → exchange gap. */
const CODE_TTL_SECONDS = 60;

/**
 * Mint a one-time authorization code for the MCP OAuth callback (#25). Returns the PLAINTEXT
 * code to place in the redirect (`?code=`); only its HASH + the session it maps to are stored,
 * single-use and short-lived. This replaces putting the raw session token in the URL, where it
 * leaks to request logs / Referer / history and is a directly reusable Bearer for the session's
 * life.
 */
export async function mintMcpAuthCode(env: Env, session: string): Promise<string> {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const code = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
	const now = Math.floor(Date.now() / 1000);
	// Opportunistic sweep so expired codes can't accumulate (also covered by the expiry index).
	await env.DB.prepare("DELETE FROM mcp_auth_codes WHERE expires_at < ?1").bind(now).run().catch(() => undefined);
	await env.DB.prepare("INSERT INTO mcp_auth_codes (code_hash, session, expires_at) VALUES (?1, ?2, ?3)")
		.bind(await sha256hex(code), session, now + CODE_TTL_SECONDS)
		.run();
	return code;
}

/**
 * Exchange a one-time code for its session, server-to-server. Atomic single-use: the row is
 * DELETEd (RETURNING) so a race can't mint two sessions from one code; an expired / unknown /
 * already-used code returns null (fail-closed — never reveals validity beyond null).
 */
export async function exchangeMcpAuthCode(env: Env, code: string): Promise<string | null> {
	if (!code || typeof code !== "string") return null;
	const now = Math.floor(Date.now() / 1000);
	const row = await env.DB.prepare(
		"DELETE FROM mcp_auth_codes WHERE code_hash = ?1 AND expires_at > ?2 RETURNING session",
	)
		.bind(await sha256hex(code), now)
		.first<{ session: string }>()
		.catch(() => null);
	return row?.session ?? null;
}
