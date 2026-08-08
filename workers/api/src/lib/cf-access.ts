import type { Context, Next } from "hono";
import type { Env } from "../types.js";
import { HttpError } from "./auth.js";
import { logError } from "./error-log.js";

/**
 * Cloudflare Access perimeter for the admin surface (defense-in-depth, issue #28).
 *
 * When `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` are configured, every request must
 * carry a valid `Cf-Access-Jwt-Assertion` header (injected by Cloudflare's edge for
 * users who passed the Access policy — SSO + optional hardware key). We verify it
 * (RS256 against the team JWKS) so a leaked account JWT alone can't reach the admin
 * API. The role check (requireAdmin) still runs behind this.
 *
 * ── Three states, because switching this on blind can brick the portal (#108) ──
 *
 * The perimeter's failure mode is total: if the env vars are set but Cloudflare is not
 * actually injecting the header for this hostname, EVERY admin request 403s and the
 * only way back is deleting a secret and redeploying — locking the operator out of the
 * portal they would use to notice. The header is injected by the edge, so whether it
 * arrives cannot be established from inside the Worker, or from a test, or from the
 * dashboard. It has to be MEASURED in production, and measuring it must not be the same
 * act as enforcing it.
 *
 *   off     — either env var unset. No-op. Local, dev, and prod today.
 *   audit   — both set, `CF_ACCESS_ENFORCE` not truthy. Verifies the token and RECORDS
 *             what it found, then allows the request regardless. Silence in the log
 *             means every admin request is carrying a valid Access JWT, which is the
 *             evidence — and the only evidence — that enforcing is safe.
 *   enforce — both set AND `CF_ACCESS_ENFORCE` truthy. Missing/invalid token → 403.
 *
 * So the rollout is: create the Access application → set the two vars → read the log →
 * only then set `CF_ACCESS_ENFORCE`. Default stays `off`, and `audit` is the default the
 * moment the vars appear, so a half-finished rollout degrades to observation rather than
 * to a lockout.
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

/** What the gate does with an admin request. See the file header. */
export type CfAccessMode = "off" | "audit" | "enforce";

/**
 * Enforcement is OPT-IN and explicit.
 *
 * Anything that isn't a recognised affirmative — including unset, empty, `"false"`, and the
 * `"undefined"` string a shell can produce from an unset variable — means audit. A typo in this
 * secret must degrade to watching, never to blocking, because blocking is the state with no way
 * back through the UI.
 */
function truthy(v: string | undefined): boolean {
	return ["1", "true", "yes", "on"].includes(String(v ?? "").trim().toLowerCase());
}

/** Resolve the gate's state from the environment. */
export function cloudflareAccessMode(env: Env): CfAccessMode {
	if (!cloudflareAccessConfigured(env)) return "off";
	return truthy(env.CF_ACCESS_ENFORCE) ? "enforce" : "audit";
}

/**
 * What the gate found on the request. `valid` is the only one that isn't recorded — a
 * healthy perimeter must produce NO log volume, or the signal that it is healthy would be
 * buried in the evidence of it (the #423 lesson: a row per request is a log nobody reads).
 */
type AccessOutcome = "valid" | "missing" | "invalid";

/**
 * One fixed string per (mode, outcome), because `logError` collapses repeats only on a
 * byte-identical message. A misconfigured rollout that fails on every request therefore
 * costs ~1 row/hour instead of one per poll of the admin SPA.
 */
const OUTCOME_MESSAGE: Record<Exclude<AccessOutcome, "valid">, Record<"audit" | "enforce", string>> = {
	missing: {
		audit: "Cloudflare Access (audit): an admin request carried no Access token — do NOT enforce yet",
		enforce: "Cloudflare Access (enforce): blocked an admin request carrying no Access token",
	},
	invalid: {
		audit: "Cloudflare Access (audit): an admin request carried an invalid Access token — do NOT enforce yet",
		enforce: "Cloudflare Access (enforce): blocked an admin request carrying an invalid Access token",
	},
};

/**
 * Hono middleware: the Cloudflare Access perimeter on the admin surface.
 *
 * Records under its OWN source (`cf-access`) rather than falling through to the global
 * handler's generic 403 path: a perimeter rejection and an ordinary permission wall are both
 * 403 and were indistinguishable in the log, so "is Access rejecting me?" could not be
 * answered by the one instrument that would be reachable while locked out of the portal.
 */
export function cloudflareAccessGate() {
	return async (c: Context<{ Bindings: Env }>, next: Next) => {
		const mode = cloudflareAccessMode(c.env);
		if (mode === "off") return next();

		const token = c.req.header("Cf-Access-Jwt-Assertion");
		const outcome: AccessOutcome = !token
			? "missing"
			: (await verifyAccessJwt(token, c.env.CF_ACCESS_TEAM_DOMAIN as string, c.env.CF_ACCESS_AUD as string).catch(
						() => false,
					))
				? "valid"
				: "invalid";

		if (outcome === "valid") return next();

		// Best-effort and never fatal: the perimeter's decision must not depend on the log
		// being writable, in either direction.
		await logError(c.env, {
			source: "cf-access",
			level: "warn",
			status: mode === "enforce" ? 403 : undefined,
			message: OUTCOME_MESSAGE[outcome][mode],
			context: { mode, outcome, path: c.req.path, method: c.req.method },
		}).catch(() => undefined);

		// Audit observes and stands aside — this is the whole point of the mode.
		if (mode === "audit") return next();
		throw new HttpError(403, outcome === "missing" ? "Cloudflare Access required" : "Invalid Cloudflare Access token");
	};
}
