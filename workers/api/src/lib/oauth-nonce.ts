// Bind an OAuth `state` to the browser that will complete the flow.
//
// THE BUG THIS CLOSES. An OAuth callback is unauthenticated by construction — it is a top-level
// navigation arriving from the provider — so it has exactly one piece of evidence about who to
// credit: the signed `state`. Our states carried only the INITIATOR's uid, and nothing tied them
// to a browser. That makes the account that RECEIVES the grant the account that STARTED the flow,
// not the account that consented:
//
//   1. Attacker A calls `/v1/auth/github/link/start` with A's own bearer and gets back a consent
//      URL carrying `state{linkUid: A}`, valid 30 minutes.
//   2. A sends the URL to victim V. V clicks it. If V has already authorized the OAuth app, GitHub
//      redirects with no consent screen at all.
//   3. The callback exchanges V's code and runs
//      `UPDATE users SET linked_github_login = <V> WHERE id = <A>`, then
//      `bindMemberOrgInstallations(A, V's login, V's token)` — minting App installation tokens,
//      under A's rows, for every org V belongs to that has the App installed.
//   4. A reads V's private repos through `/v1/github/installations/:id/repos` and clones them via
//      the Coder path.
//
// The same shape applies to every connector callback (Gmail, Drive, WorkDrive, generic): V's
// refresh token is stored under A's `user_api_keys`, and A then points an instance at V's mailbox
// or documents. This is the cross-tenant installation access the 2026-07 audit closed inside
// `getInstallationToken`, re-opened through the path that legitimately CREATES the binding.
//
// THE FIX. A nonce in the state plus the same nonce in a `HttpOnly; Secure; SameSite=Lax` cookie
// set on the start response. The cookie lives in the browser that STARTED the flow; a victim who
// merely clicks the link has no such cookie, so the callback refuses. This is the standard
// requirement that OAuth state be bound to the user agent — signing it is not enough, because the
// attacker is a legitimate holder of a validly-signed state.
//
// Fails CLOSED: no cookie, or a mismatched one, aborts the flow. A soft fallback would restore the
// exact hole, since the attack's whole shape is "the completing browser is not the initiating one".
//
// NOT applied to plain SIGN-IN (`/github/start`, `/google/start`): there the callback mints a
// session for whoever consented, so completing someone else's flow signs you in as yourself.

const COOKIE = "pags_oauth_bind";
/** Matches the longest state TTL in use (the GitHub link flow's 30 min). */
const MAX_AGE = 1800;

export function newOauthNonce(): string {
	return crypto.randomUUID().replace(/-/g, "");
}

/** `Set-Cookie` value for the start response. Path=/ so every callback path receives it. */
export function oauthBindCookie(nonce: string): string {
	return `${COOKIE}=${nonce}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

/** Expire the cookie once a flow finishes — a nonce is single-use. */
export function clearOauthBindCookie(): string {
	return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/** Read the bind nonce from a request's Cookie header, or null. */
export function readOauthBindCookie(cookieHeader: string | null | undefined): string | null {
	if (!cookieHeader) return null;
	for (const part of cookieHeader.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		if (part.slice(0, eq).trim() !== COOKIE) continue;
		const v = part.slice(eq + 1).trim();
		return v || null;
	}
	return null;
}

/**
 * Does the completing browser own this state? Constant-time-ish compare on a random 32-hex
 * nonce; length-equality first so an early return can't leak the length.
 */
export function oauthBindMatches(stateNonce: string | null | undefined, cookieNonce: string | null): boolean {
	if (!stateNonce || !cookieNonce || stateNonce.length !== cookieNonce.length) return false;
	let diff = 0;
	for (let i = 0; i < stateNonce.length; i++) diff |= stateNonce.charCodeAt(i) ^ cookieNonce.charCodeAt(i);
	return diff === 0;
}

/** The message shown when the binding fails — deliberately explains rather than just 400s. */
export const OAUTH_BIND_ERROR =
	"This authorization link was started in a different browser or has expired. For your security, start the connection again from your own console.";
