/**
 * PKCE authorization for user-named MCP endpoints — the protocol half of #180/#258.
 *
 * Storage lives in `mcp-oauth-store.ts`, the routes in `routes/mcp.ts`; everything here is pure
 * or takes an injected fetch, so the parts that decide who gets credited with a grant are
 * testable without a browser, a network or a database.
 *
 * ─── THE STATE IS PINNED TO THE RESOURCE, NOT JUST TO THE USER ────────────────────────────────
 *
 * An OAuth callback is unauthenticated by construction: it is a top-level navigation arriving
 * from a party we do not control, and its only evidence is the signed `state`. The platform
 * already learned twice what that evidence has to carry — `lib/oauth-nonce.ts` binds a state to
 * the BROWSER that started the flow (or an attacker's link, completed by a victim, files the
 * victim's grant under the attacker's account), and `signConnectorState` pins the PROVIDER (or a
 * state minted at one connector's start is accepted verbatim by another's callback).
 *
 * This flow adds a third pin, because it is the first flow where the remote server is CHOSEN BY
 * THE USER AT RUNTIME and is not necessarily trustworthy. A state proving only "this user started
 * some MCP OAuth flow" is replayable across servers: the operator of any server the user connects
 * sees the state in their own authorize request, and can then drive our callback with it. What
 * they must not be able to do is have that callback complete a flow bound to a DIFFERENT server —
 * exchanging their code at someone else's token endpoint, or landing their token in another
 * server's credential slot. So the state carries:
 *
 *   f — the flow id. Every parameter of the exchange (token endpoint, client id, redirect uri,
 *       PKCE verifier, resource) is read from that ONE row, written at start time from metadata
 *       we discovered ourselves. Nothing is read from the callback's query string but `code`.
 *   r — the resource the flow is for, signed. The route requires it to equal the claimed row's
 *       endpoint, so a state and a flow row cannot be paired up across servers even if a row id
 *       were guessed, and the credential can only be written under the endpoint the user asked
 *       for.
 *   p — the flow type, `"mcp_oauth"`. The SAME `SESSION_SIGNING_KEY` signs account sessions and
 *       connector states, so a payload that omits the type pin is a payload some other verifier
 *       might accept. `verifySession` type-pins for this reason; `verifyConnectorState` requires
 *       `p === <connector id>` and so rejects ours, and this verifier rejects everything that is
 *       not exactly `mcp_oauth` — including a session JWT, which has no `p` at all.
 *
 * Every one of these fails CLOSED: a missing pin is a refusal, never a grandfathered success.
 */
import { safeFetch } from "./ssrf.js";
import { oauthBindMatches } from "./oauth-nonce.js";

/** The flow type pin. Deliberately not a connector id, so the two state families cannot cross. */
export const MCP_OAUTH_STATE_TYPE = "mcp_oauth";
/** Cookie scope for the browser-binding nonce (lib/oauth-nonce.ts). */
export const MCP_OAUTH_COOKIE_SCOPE = "mcp_oauth";
/** How long a started flow may sit unfinished. Long enough to sign in at the far end, no longer. */
export const FLOW_TTL_SECONDS = 600;
/**
 * Refresh this long before the access token actually expires. Without a skew a token that is
 * valid at the moment we read it can be dead by the time the MCP server checks it — a race that
 * shows up as an unexplained 401 on long calls, which reads as "the credential is broken".
 */
export const REFRESH_SKEW_MS = 60_000;

function b64url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array {
	const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (s.length % 4)) % 4);
	return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

// ─── PKCE ────────────────────────────────────────────────────────────────────────────────────

/** A fresh high-entropy code verifier (RFC 7636 §4.1: 43–128 unreserved characters). */
export function newCodeVerifier(): string {
	return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * S256 challenge. Only S256 — `plain` is offered by the RFC and is worth nothing here, because a
 * `plain` challenge equals its verifier and an attacker who sees the authorize request has both.
 */
export async function codeChallengeS256(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return b64url(new Uint8Array(digest));
}

// ─── State ───────────────────────────────────────────────────────────────────────────────────

export interface McpOauthStateClaims {
	uid: string;
	flowId: string;
	/** The normalized MCP endpoint this flow is for. */
	resource: string;
}

export async function signMcpOauthState(claims: McpOauthStateClaims, exp: number, secret: string, nonce: string): Promise<string> {
	const payload = b64url(
		new TextEncoder().encode(JSON.stringify({ uid: claims.uid, exp, n: nonce, p: MCP_OAUTH_STATE_TYPE, f: claims.flowId, r: claims.resource })),
	);
	const sig = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(payload))));
	return `${payload}.${sig}`;
}

/**
 * Verify a callback's `state`. Returns the claims, or null — and null is the ONLY failure signal
 * on purpose: which pin failed is information an attacker probing the callback would use to find
 * the one they can satisfy.
 */
export async function verifyMcpOauthState(token: string, secret: string, cookieNonce: string | null): Promise<McpOauthStateClaims | null> {
	try {
		const [payload, sig] = String(token ?? "").split(".");
		if (!payload || !sig) return null;
		const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), unb64url(sig), new TextEncoder().encode(payload));
		if (!valid) return null;
		const claims = JSON.parse(new TextDecoder().decode(unb64url(payload))) as {
			uid?: unknown;
			exp?: unknown;
			n?: unknown;
			p?: unknown;
			f?: unknown;
			r?: unknown;
		};
		if (typeof claims.uid !== "string" || !claims.uid) return null;
		if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) return null;
		// The type pin. A connector state or an account session signed with the same key stops here.
		if (claims.p !== MCP_OAUTH_STATE_TYPE) return null;
		if (typeof claims.f !== "string" || !claims.f) return null;
		// The resource pin — the one that makes this state non-transferable between servers.
		if (typeof claims.r !== "string" || !claims.r) return null;
		if (!oauthBindMatches(typeof claims.n === "string" ? claims.n : null, cookieNonce)) return null;
		return { uid: claims.uid, flowId: claims.f, resource: claims.r };
	} catch {
		return null;
	}
}

// ─── Authorize ───────────────────────────────────────────────────────────────────────────────

export interface AuthorizeUrlInput {
	authorizationEndpoint: string;
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	state: string;
	scope?: string | null;
	/** RFC 8707 resource indicator — MCP requires it, and it is what stops a token issued for one
	 *  resource being accepted at another by a server that honours it. */
	resource: string;
}

export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
	const u = new URL(input.authorizationEndpoint);
	u.searchParams.set("response_type", "code");
	u.searchParams.set("client_id", input.clientId);
	u.searchParams.set("redirect_uri", input.redirectUri);
	u.searchParams.set("code_challenge", input.codeChallenge);
	u.searchParams.set("code_challenge_method", "S256");
	u.searchParams.set("state", input.state);
	u.searchParams.set("resource", input.resource);
	if (input.scope) u.searchParams.set("scope", input.scope);
	return u.toString();
}

// ─── Token endpoint ──────────────────────────────────────────────────────────────────────────

export interface TokenResponse {
	accessToken: string;
	refreshToken: string | null;
	/** ISO-8601, or null when the server states no lifetime (then nothing expires on our side). */
	expiresAt: string | null;
	scope: string | null;
}

/** Turn `expires_in` seconds into the absolute instant we store. Non-numeric/absurd values are
 *  dropped rather than clamped: a wrong expiry is worse than none, because it either refuses a
 *  working credential or keeps a dead one. */
export function expiresAtFrom(expiresIn: unknown, now: number = Date.now()): string | null {
	const n = typeof expiresIn === "number" ? expiresIn : typeof expiresIn === "string" ? Number(expiresIn) : Number.NaN;
	if (!Number.isFinite(n) || n <= 0 || n > 60 * 60 * 24 * 400) return null;
	return new Date(now + n * 1000).toISOString();
}

export function parseTokenResponse(raw: unknown, now: number = Date.now()): TokenResponse | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const accessToken = typeof r.access_token === "string" ? r.access_token.trim() : "";
	if (!accessToken) return null;
	return {
		accessToken,
		refreshToken: typeof r.refresh_token === "string" && r.refresh_token.trim() ? r.refresh_token.trim() : null,
		expiresAt: expiresAtFrom(r.expires_in, now),
		scope: typeof r.scope === "string" && r.scope.trim() ? r.scope.trim().slice(0, 500) : null,
	};
}

/** Should this credential be renewed now? True once we are inside the skew, so a token is never
 *  handed to a call it will expire during. */
export function needsRefresh(expiresAt: string | null | undefined, now: number = Date.now(), skewMs: number = REFRESH_SKEW_MS): boolean {
	if (!expiresAt) return false;
	const t = Date.parse(expiresAt);
	return Number.isFinite(t) && t - skewMs <= now;
}

export type TokenFetch = (url: string, init: RequestInit) => Promise<Response>;
const defaultFetch: TokenFetch = (url, init) => safeFetch(url, init);

export interface TokenRequestInput {
	tokenEndpoint: string;
	clientId: string;
	clientSecret?: string | null;
	redirectUri?: string;
	resource: string;
}

async function postToken(params: URLSearchParams, input: TokenRequestInput, fetchImpl: TokenFetch): Promise<TokenResponse> {
	params.set("client_id", input.clientId);
	// A public client sends no secret at all (that is the point of PKCE). When a server issued one
	// anyway we use `client_secret_post`, the form every server that issues secrets accepts.
	if (input.clientSecret) params.set("client_secret", input.clientSecret);
	params.set("resource", input.resource);
	const res = await fetchImpl(input.tokenEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: params.toString(),
	});
	const text = await res.text();
	if (!res.ok) {
		// The server's own error text, truncated. An OAuth error body is a spec'd `{error,
		// error_description}` object and is the only thing that says WHICH of a dozen things went
		// wrong; a generic "token exchange failed" sends the user to guess.
		throw new Error(`Token request failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
	}
	let parsed: unknown = null;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("Token endpoint returned a body that is not JSON.");
	}
	const tok = parseTokenResponse(parsed);
	if (!tok) throw new Error("Token endpoint returned no access_token.");
	return tok;
}

export async function exchangeAuthorizationCode(
	code: string,
	verifier: string,
	input: TokenRequestInput & { redirectUri: string },
	fetchImpl: TokenFetch = defaultFetch,
): Promise<TokenResponse> {
	return postToken(
		new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: input.redirectUri, code_verifier: verifier }),
		input,
		fetchImpl,
	);
}

export async function refreshAccessToken(refreshToken: string, input: TokenRequestInput, fetchImpl: TokenFetch = defaultFetch): Promise<TokenResponse> {
	return postToken(new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }), input, fetchImpl);
}
