import { verifyMcpSession } from "./session.js";

/**
 * The audit subject behind a per-call `token` argument (#702).
 *
 * `PagsMcp.safety(provided)` used to set `subject: undefined` whenever a token was supplied,
 * and `audit()` no-ops without a subject — so a scripted caller wrote NO audit row from any
 * tool, mutating or not, including `coding_session_message`, which runs code on the owner's
 * machine. `platform-docs/mcp.md` steers scripted callers down exactly that path, so it was
 * the documented way to automate against the platform, not an edge case.
 *
 * The token already IS an identity: the two-part `data.sig` HMAC `verifyMcpSession` validates
 * and `oauth-provider.ts` already calls for this purpose. Nothing new is stored.
 *
 * It lives here rather than in `safety.ts` because that module is the one other OFO stores
 * vendor and its contract is to import only `./http.js`; and rather than in `index.ts` because
 * that file is at its size pin and this is exactly the kind of mechanism the ratchet asks to be
 * split out.
 */

/** Last verified (token → uid) pair, with the token's own expiry. */
export interface TokenSubject {
	token: string;
	uid?: string;
	exp: number;
}

/** A one-entry memo. A scripted caller uses ONE token, and an unbounded map on a long-lived
 *  Durable Object is a leak. Held by the caller so it survives across `safety()` calls. */
export interface TokenSubjectCache {
	current: TokenSubject | null;
}

export function newTokenSubjectCache(): TokenSubjectCache {
	return { current: null };
}

/**
 * Build the `resolveSubject` thunk a `SafetyContext` carries. Memoised because one tool call
 * audits more than once (a denial writes a row; so does the completion of an allowed call),
 * and `exp`-aware because a cached uid must not outlive the token that proved it —
 * `verifyMcpSession` rejects an expired token, and a cache that ignored that would quietly
 * undo the check.
 *
 * Returns `undefined` — i.e. no audit row, and no crash — when the token is not a valid
 * session or the signing key is unset. An unverified token must never become an identity.
 */
export function tokenSubjectResolver(
	signingKey: string | undefined,
	token: string,
	cache: TokenSubjectCache,
): () => Promise<string | undefined> {
	return async () => {
		const now = Math.floor(Date.now() / 1000);
		const hit = cache.current;
		if (hit && hit.token === token && hit.exp > now) return hit.uid;
		if (!signingKey) return undefined;
		let uid: string | undefined;
		let exp = now;
		try {
			const payload = await verifyMcpSession(token, signingKey);
			uid = payload?.uid;
			exp = payload?.exp ?? now;
		} catch {
			// A malformed token is a caller error, not a server one, and must not turn a working
			// tool call into a crash: `verifyMcpSession` base64-decodes both halves, so a string
			// that is not a PAGS session throws rather than returning null. The call proceeds
			// unaudited and the tool still refuses on its own terms — today's behaviour for an
			// unauthenticated caller.
			uid = undefined;
		}
		cache.current = { token, uid, exp };
		return uid;
	};
}
