import { HttpError } from "./auth.js";
import { decryptKey, encryptKey } from "./crypto.js";
import { oauthBindMatches } from "./oauth-nonce.js";
import type { Env } from "../types.js";

export interface ConnectorTokenInput {
	userId: string;
	provider: string;
	refreshToken: string;
	accountLabel?: string | null;
	/**
	 * WHICH account this credential belongs to (#715) — the provider's own id for it, which for
	 * Google is the mailbox address. Omitted means '' , the reserved id for the account's single
	 * unnamed credential, which is what every AI-provider key is and what callers that have not
	 * been made account-aware still write.
	 *
	 * Using the provider's identifier rather than a surrogate key is what makes reconnecting the
	 * SAME mailbox an update of the same row instead of a duplicate.
	 */
	accountId?: string;
	/** What the provider actually granted (#713), space-separated. */
	grantedScopes?: string | null;
}

function b64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array {
	const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (s.length % 4)) % 4);
	return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

/**
 * Sign the `state` for a connector OAuth flow.
 *
 * Two things beyond the uid, both required — see lib/oauth-nonce.ts for the full attack:
 *
 * - `nonce` binds the state to the browser that STARTED the flow. Without it, a state is
 *   bearer-grade: an attacker starts the flow with their own bearer, sends the consent URL to a
 *   victim, and the victim's refresh token is stored under the ATTACKER's `user_api_keys` — their
 *   instances then read the victim's Gmail or Drive.
 * - `provider` pins the state to the connector it was minted for. Every callback used the same
 *   `{uid, exp}` shape, so a state minted at `/v1/drive/google/start` was accepted verbatim by the
 *   Gmail, WorkDrive and generic-connector callbacks.
 */
export async function signConnectorState(
	uid: string,
	exp: number,
	secret: string,
	bind: { nonce: string; provider: string },
): Promise<string> {
	const payload = b64url(
		new TextEncoder().encode(JSON.stringify({ uid, exp, n: bind.nonce, p: bind.provider })),
	);
	const sig = b64url(
		new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(payload))),
	);
	return `${payload}.${sig}`;
}

/**
 * Verify a connector `state` and return the uid it credits — or null.
 *
 * Fails CLOSED on a missing nonce or provider, so states minted before this shipped stop working
 * rather than being grandfathered: honouring them would leave the hole open for their whole TTL.
 */
export async function verifyConnectorState(
	token: string,
	secret: string,
	bind: { cookieNonce: string | null; provider: string },
): Promise<string | null> {
	try {
		const [payload, sig] = token.split(".");
		if (!payload || !sig) return null;
		const valid = await crypto.subtle.verify(
			"HMAC",
			await hmacKey(secret),
			unb64url(sig),
			new TextEncoder().encode(payload),
		);
		if (!valid) return null;
		const { uid, exp, n, p } = JSON.parse(new TextDecoder().decode(unb64url(payload))) as {
			uid: string;
			exp: number;
			n?: string;
			p?: string;
		};
		if (typeof uid !== "string" || typeof exp !== "number") return null;
		if (exp < Math.floor(Date.now() / 1000)) return null;
		if (p !== bind.provider) return null;
		if (!oauthBindMatches(n, bind.cookieNonce)) return null;
		return uid;
	} catch {
		return null;
	}
}

/**
 * Read one connector credential.
 *
 * `accountId` names WHICH of the owner's accounts (#715). Omitting it keeps the pre-#715
 * behaviour for a caller that has not been made account-aware — but note that "the row at ''"
 * is now a real, specific row rather than "the only row", so a caller that could face several
 * accounts must resolve one first (lib/connector-accounts.ts) instead of relying on this.
 */
export async function readConnectorRefreshToken(
	env: Env,
	userId: string,
	provider: string,
	displayName: string,
	accountId = "",
): Promise<string> {
	if (!env.KEY_ENCRYPTION_KEY) throw new HttpError(500, "Key encryption not configured");
	const row = await env.DB.prepare(
		"SELECT key_ciphertext, dek_wrapped, iv FROM user_api_keys WHERE user_id = ?1 AND provider = ?2 AND account_id = ?3",
	)
		.bind(userId, provider, accountId)
		.first<{ key_ciphertext: ArrayBuffer; dek_wrapped: ArrayBuffer; iv: ArrayBuffer }>();
	if (!row) throw new HttpError(400, `${displayName} is not connected`);
	return decryptKey(
		new Uint8Array(row.key_ciphertext),
		new Uint8Array(row.dek_wrapped),
		new Uint8Array(row.iv),
		env.KEY_ENCRYPTION_KEY,
	);
}

export async function saveConnectorRefreshToken(env: Env, input: ConnectorTokenInput): Promise<void> {
	if (!env.KEY_ENCRYPTION_KEY) throw new HttpError(500, "Key encryption not configured");
	const { ciphertext, dekWrapped, iv } = await encryptKey(
		input.refreshToken,
		env.KEY_ENCRYPTION_KEY,
	);
	// The conflict target is the full key including account_id, so reconnecting the same account
	// refreshes that row and connecting a different one adds a row beside it (#715).
	await env.DB.prepare(
		`INSERT INTO user_api_keys (user_id, provider, account_id, key_ciphertext, dek_wrapped, iv, account_label, granted_scopes, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'))
     ON CONFLICT(user_id, provider, account_id) DO UPDATE SET
       key_ciphertext = excluded.key_ciphertext,
       dek_wrapped = excluded.dek_wrapped,
       iv = excluded.iv,
       account_label = excluded.account_label,
       granted_scopes = excluded.granted_scopes,
       created_at = excluded.created_at`,
	)
		.bind(
			input.userId,
			input.provider,
			input.accountId ?? "",
			ciphertext,
			dekWrapped,
			iv,
			input.accountLabel ?? null,
			input.grantedScopes ?? null,
		)
		.run();
}
