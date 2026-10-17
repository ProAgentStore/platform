/**
 * OAuth2 for HTTP credential profiles (#1124): client-credentials and authorization-code grants, the
 * encrypted token store (migration 0250), and expiry/refresh.
 *
 * The profile's secret is the CLIENT secret; it is only ever sent to the profile's own `tokenUrl`. What
 * an API request carries is the access token this module mints, stored encrypted and refreshed
 * {@link REFRESH_SKEW_MS} before it expires. An authorization-code profile needs the owner's consent
 * once (`startProfileAuthorization` → the provider → `completeProfileAuthorization`), which stores the
 * refresh token; from then on refreshes are silent. A refresh the provider refuses with `invalid_grant`
 * CLEARS the grant and says so: retrying a dead refresh token forever would only hide that the owner
 * must authorize again.
 *
 * Token-endpoint failures report the HTTP status and the OAuth `error` code — never the response body,
 * which may echo the client secret or a token back.
 */
import { decryptKey, encryptKey } from "./crypto.js";
import type { OAuth2Config } from "./http-auth-strategies.js";
import { safeFetch } from "./ssrf.js";
import type { Env } from "../types.js";

/** Refresh this long before expiry, so a token valid when read is not dead by the time the API checks it. */
export const REFRESH_SKEW_MS = 60_000;

export class ProfileAuthError extends Error {}

export type TokenFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface OAuthDeps {
	fetch?: TokenFetch;
	now?: () => number;
}

type Sealed = { ciphertext: Uint8Array; dekWrapped: Uint8Array; iv: Uint8Array };
interface TokenRow {
	access_ciphertext: ArrayBuffer | null;
	access_dek: ArrayBuffer | null;
	access_iv: ArrayBuffer | null;
	access_expires_at: number | null;
	refresh_ciphertext: ArrayBuffer | null;
	refresh_dek: ArrayBuffer | null;
	refresh_iv: ArrayBuffer | null;
}

function kek(env: Pick<Env, "KEY_ENCRYPTION_KEY">): string {
	if (!env.KEY_ENCRYPTION_KEY) throw new ProfileAuthError("Credential encryption is not configured on this platform.");
	return env.KEY_ENCRYPTION_KEY;
}

const open = (env: Pick<Env, "KEY_ENCRYPTION_KEY">, c: ArrayBuffer | null, d: ArrayBuffer | null, i: ArrayBuffer | null) =>
	c && d && i ? decryptKey(new Uint8Array(c), new Uint8Array(d), new Uint8Array(i), kek(env)) : Promise.resolve(null);

async function readRow(env: Pick<Env, "DB">, profileId: string, userId: string): Promise<TokenRow | null> {
	return env.DB.prepare("SELECT * FROM http_credential_oauth_tokens WHERE profile_id = ?1 AND user_id = ?2").bind(profileId, userId).first<TokenRow>();
}

/** Store what a token endpoint issued. A refresh that returns no new refresh token keeps the old one. */
async function saveTokens(env: Pick<Env, "DB" | "KEY_ENCRYPTION_KEY">, profileId: string, userId: string, t: { accessToken: string; expiresAt: number | null; refreshToken?: string | null }): Promise<void> {
	const access: Sealed = await encryptKey(t.accessToken, kek(env));
	const refresh: Sealed | null = t.refreshToken ? await encryptKey(t.refreshToken, kek(env)) : null;
	await env.DB.prepare(
		`INSERT INTO http_credential_oauth_tokens (profile_id, user_id, access_ciphertext, access_dek, access_iv, access_expires_at, refresh_ciphertext, refresh_dek, refresh_iv, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'))
		 ON CONFLICT(profile_id) DO UPDATE SET access_ciphertext = excluded.access_ciphertext, access_dek = excluded.access_dek, access_iv = excluded.access_iv,
		   access_expires_at = excluded.access_expires_at,
		   refresh_ciphertext = COALESCE(excluded.refresh_ciphertext, refresh_ciphertext), refresh_dek = COALESCE(excluded.refresh_dek, refresh_dek), refresh_iv = COALESCE(excluded.refresh_iv, refresh_iv),
		   updated_at = excluded.updated_at`,
	)
		.bind(profileId, userId, access.ciphertext, access.dekWrapped, access.iv, t.expiresAt, refresh?.ciphertext ?? null, refresh?.dekWrapped ?? null, refresh?.iv ?? null)
		.run();
}

/** Forget a profile's grant — on an `invalid_grant`, a rotated client secret, or a deleted profile. */
export async function clearProfileTokens(env: Pick<Env, "DB">, profileId: string, userId: string): Promise<void> {
	await env.DB.prepare("DELETE FROM http_credential_oauth_tokens WHERE profile_id = ?1 AND user_id = ?2").bind(profileId, userId).run();
}

/** What a profile's view and test may say about its grant: presence and expiry only. */
export async function profileTokenStatus(env: Pick<Env, "DB">, profileId: string, userId: string): Promise<{ accessToken: boolean; refreshToken: boolean; expiresAt: string | null }> {
	const row = await readRow(env, profileId, userId).catch(() => null);
	return { accessToken: !!row?.access_ciphertext, refreshToken: !!row?.refresh_ciphertext, expiresAt: row?.access_expires_at ? new Date(row.access_expires_at).toISOString() : null };
}

async function tokenRequest(cfg: OAuth2Config, clientSecret: string, params: Record<string, string>, deps: OAuthDeps): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: number | null }> {
	const body = new URLSearchParams(params);
	const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
	if (cfg.clientAuth === "basic") headers.Authorization = `Basic ${btoa(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(clientSecret)}`)}`;
	else {
		body.set("client_id", cfg.clientId);
		body.set("client_secret", clientSecret);
	}
	let res: Response;
	try {
		res = await (deps.fetch ?? ((u, i) => safeFetch(u, i)))(cfg.tokenUrl, { method: "POST", headers, body: body.toString() });
	} catch (e) {
		throw new ProfileAuthError(`The OAuth2 token endpoint could not be reached (${e instanceof Error ? e.name : "error"}).`);
	}
	const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
	if (!res.ok || !json || typeof json.access_token !== "string" || !json.access_token) {
		const code = typeof json?.error === "string" && /^[a-z_]{1,64}$/.test(json.error) ? json.error : null;
		const err = new ProfileAuthError(`The OAuth2 token endpoint refused the request (HTTP ${res.status}${code ? `, ${code}` : ""}).`);
		(err as ProfileAuthError & { oauthError?: string | null }).oauthError = code;
		throw err;
	}
	const now = (deps.now ?? Date.now)();
	const expiresIn = Number(json.expires_in);
	return {
		accessToken: json.access_token,
		refreshToken: typeof json.refresh_token === "string" && json.refresh_token ? json.refresh_token : null,
		expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null,
	};
}

/**
 * The access token for one request: the stored one while it is valid, else a fresh one —
 * client_credentials by asking again, authorization_code by spending the refresh token. `force` skips the
 * stored token (the API answered 401 to it).
 */
export async function profileAccessToken(
	env: Pick<Env, "DB" | "KEY_ENCRYPTION_KEY">,
	profile: { id: string; userId: string; strategy: "oauth2_client_credentials" | "oauth2_authorization_code"; cfg: OAuth2Config },
	clientSecret: string,
	opts: OAuthDeps & { force?: boolean } = {},
): Promise<string> {
	const now = (opts.now ?? Date.now)();
	const row = await readRow(env, profile.id, profile.userId);
	if (!opts.force && row?.access_ciphertext) {
		const fresh = row.access_expires_at === null || row.access_expires_at - now > REFRESH_SKEW_MS;
		const access = fresh ? await open(env, row.access_ciphertext, row.access_dek, row.access_iv) : null;
		if (access) return access;
	}
	if (profile.strategy === "oauth2_client_credentials") {
		const t = await tokenRequest(profile.cfg, clientSecret, { grant_type: "client_credentials", ...(profile.cfg.scope ? { scope: profile.cfg.scope } : {}) }, opts);
		await saveTokens(env, profile.id, profile.userId, { accessToken: t.accessToken, expiresAt: t.expiresAt });
		return t.accessToken;
	}
	const refresh = row ? await open(env, row.refresh_ciphertext, row.refresh_dek, row.refresh_iv) : null;
	if (!refresh) throw new ProfileAuthError("This OAuth2 profile has not been authorized yet: the owner must grant access once (authorize the profile in a browser), after which refreshes are automatic.");
	try {
		const t = await tokenRequest(profile.cfg, clientSecret, { grant_type: "refresh_token", refresh_token: refresh }, opts);
		await saveTokens(env, profile.id, profile.userId, { accessToken: t.accessToken, expiresAt: t.expiresAt, refreshToken: t.refreshToken });
		return t.accessToken;
	} catch (e) {
		if ((e as { oauthError?: string | null }).oauthError === "invalid_grant") {
			await clearProfileTokens(env, profile.id, profile.userId);
			throw new ProfileAuthError("The OAuth2 grant for this profile has expired or was revoked (invalid_grant); it has been cleared. The owner must authorize the profile again.");
		}
		throw e;
	}
}

/** The authorize URL for the owner's consent. `state` is signed and browser-bound by the caller. */
export function profileAuthorizeUrl(cfg: OAuth2Config, redirectUri: string, state: string): string {
	if (!cfg.authorizeUrl) throw new ProfileAuthError("This profile has no authorizeUrl.");
	const u = new URL(cfg.authorizeUrl);
	u.searchParams.set("response_type", "code");
	u.searchParams.set("client_id", cfg.clientId);
	u.searchParams.set("redirect_uri", redirectUri);
	if (cfg.scope) u.searchParams.set("scope", cfg.scope);
	u.searchParams.set("access_type", "offline");
	u.searchParams.set("state", state);
	return u.toString();
}

/** Exchange the consent's code and store the grant. A provider that issues no refresh token is refused: the grant could not be renewed. */
export async function completeProfileAuthorization(
	env: Pick<Env, "DB" | "KEY_ENCRYPTION_KEY">,
	profile: { id: string; userId: string; cfg: OAuth2Config },
	clientSecret: string,
	code: string,
	redirectUri: string,
	deps: OAuthDeps = {},
): Promise<void> {
	const t = await tokenRequest(profile.cfg, clientSecret, { grant_type: "authorization_code", code, redirect_uri: redirectUri }, deps);
	if (!t.refreshToken) throw new ProfileAuthError("The provider issued no refresh token, so this grant could not be renewed. Ask for offline access at the provider, then authorize again.");
	await saveTokens(env, profile.id, profile.userId, { accessToken: t.accessToken, expiresAt: t.expiresAt, refreshToken: t.refreshToken });
}
