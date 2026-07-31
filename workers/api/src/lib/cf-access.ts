import type { Context, Next } from "hono";
import type { Env } from "../types.js";
import { HttpError } from "./auth.js";

/**
 * Cloudflare Access perimeter for the admin surface (defense-in-depth, issue #28).
 *
 * When `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` are configured, every request must
 * carry a valid `Cf-Access-Jwt-Assertion` header (injected by Cloudflare's edge for
 * users who passed the Access policy — SSO + optional hardware key). We verify it
 * (RS256 against the team JWKS) so a leaked account JWT alone can't reach the admin
 * API. The role check (requireAdmin) still runs behind this.
 *
 * INERT until configured: if either env var is unset (local/dev, and current prod
 * until CF Access is turned on for admin.*), the gate is a no-op. This mirrors FAS's
 * verifyAccessJwt so the perimeter can be switched on with zero code changes.
 */

interface Jwk {
	kid: string;
	kty: string;
	alg?: string;
	n: string;
	e: string;
}

// In-memory JWKS cache (per isolate). The team certs rotate rarely; cache for an
// hour so we don't fetch on every admin request.
let jwksCache: { domain: string; keys: Jwk[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

async function getJwks(teamDomain: string): Promise<Jwk[]> {
	const now = Date.now();
	if (jwksCache && jwksCache.domain === teamDomain && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
		return jwksCache.keys;
	}
	const url = `https://${teamDomain}/cdn-cgi/access/certs`;
	const res = await fetch(url);
	if (!res.ok) throw new HttpError(503, "Could not fetch Cloudflare Access certs");
	const data = (await res.json()) as { keys?: Jwk[] };
	const keys = data.keys || [];
	jwksCache = { domain: teamDomain, keys, fetchedAt: now };
	return keys;
}

function b64urlToUint8(b64url: string): Uint8Array {
	const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64url.length / 4) * 4, "=");
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

async function verifyAccessJwt(token: string, teamDomain: string, aud: string): Promise<boolean> {
	const parts = token.split(".");
	if (parts.length !== 3) return false;
	const [headerB64, payloadB64, sigB64] = parts;

	let header: { kid?: string; alg?: string };
	let payload: { aud?: string | string[]; exp?: number; iss?: string };
	try {
		header = JSON.parse(new TextDecoder().decode(b64urlToUint8(headerB64)));
		payload = JSON.parse(new TextDecoder().decode(b64urlToUint8(payloadB64)));
	} catch {
		return false;
	}
	if (header.alg !== "RS256" || !header.kid) return false;

	// Claims: audience must include our AUD; must not be expired; issuer is the team.
	const auds = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
	if (!auds.includes(aud)) return false;
	if (payload.exp && payload.exp * 1000 < Date.now()) return false;
	if (payload.iss && payload.iss !== `https://${teamDomain}`) return false;

	const keys = await getJwks(teamDomain);
	const jwk = keys.find((k) => k.kid === header.kid);
	if (!jwk) return false;

	const key = await crypto.subtle.importKey(
		"jwk",
		{ kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["verify"],
	);
	const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
	return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToUint8(sigB64), data);
}

/** Is the CF Access perimeter configured for this environment? */
export function cloudflareAccessConfigured(env: Env): boolean {
	return Boolean(env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD);
}

/**
 * Hono middleware: enforce Cloudflare Access on the admin surface. No-op unless
 * configured. Throws HttpError(403) when a required Access token is missing/invalid.
 */
export function cloudflareAccessGate() {
	return async (c: Context<{ Bindings: Env }>, next: Next) => {
		if (!cloudflareAccessConfigured(c.env)) return next();
		const token = c.req.header("Cf-Access-Jwt-Assertion");
		if (!token) throw new HttpError(403, "Cloudflare Access required");
		const ok = await verifyAccessJwt(
			token,
			c.env.CF_ACCESS_TEAM_DOMAIN as string,
			c.env.CF_ACCESS_AUD as string,
		).catch(() => false);
		if (!ok) throw new HttpError(403, "Invalid Cloudflare Access token");
		return next();
	};
}
