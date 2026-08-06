// Endpoint-scoped credential material for the outbound MCP connector (#286).
//
// WHY THIS EXISTS SEPARATELY FROM THE VAULT. `user_api_keys` is keyed `(user_id, provider)`, and
// for every other connector that is exactly right: the provider IS the remote system, so one
// `github` row means one GitHub. Outbound MCP is the connector where it isn't — the server is a
// URL supplied by config at call time — so a single row at provider 'mcp' was one bearer token
// shared by every authenticated MCP endpoint the user could name. A token issued by server A was
// sent verbatim to server B as soon as anything pointed at B, which a pipeline step or an agent
// reading untrusted text can do. That is credential disclosure to an attacker-chosen party.
//
// So credential material is keyed the way reach already is: on the NORMALIZED endpoint
// (mcp-consent.ts `normalizeMcpEndpoint`). Same string, same discipline — query and fragment
// dropped, host lowercased — which means:
//
//   • a credential cannot be dodged onto another bucket with `?v=2`, exactly as consent cannot;
//   • an endpoint whose query string IS its access token never puts that token in a key column;
//   • the endpoint the console shows, the endpoint consent enforces on, the endpoint the trace
//     records, and the endpoint a credential is bound to are one value, so none can drift.
//
// WHAT THIS IS NOT. It is not a connection record. #266 decided a connection is derived from
// grants on an endpoint and that health is never cached, because a stored "connected" is the
// console's favourite lie. Nothing here has a nickname, an id, or a status column. This module
// answers one question — what credential, if any, may be sent to THIS endpoint — and nothing else.
//
// Encryption is the platform's existing envelope scheme, unchanged (lib/crypto.ts): a per-row
// AES-256-GCM DEK wrapped with AES-KW under KEY_ENCRYPTION_KEY. Plaintext exists only inside
// `resolveMcpCredential`'s return value, on its way to an `Authorization` header. It is never
// logged, never returned by a route, and never put in a tool result.
import type { Env } from "../types.js";
import { decryptKey, encryptKey } from "./crypto.js";
import { HttpError } from "./auth.js";

/** The legacy provider-wide vault slot this replaces. Read only to REPORT it, never to send it. */
export const LEGACY_MCP_PROVIDER = "mcp";

/** How a credential was obtained. Recorded so a later OAuth flow (#258/#180) writes rows here
 *  rather than inventing a parallel store, and so the resolver never has to guess. */
export type McpAuthMode = "bearer" | "oauth";

/** Non-secret metadata about a stored credential — the shape a route may return. */
export interface McpCredentialInfo {
	endpoint: string;
	authMode: McpAuthMode;
	issuer: string | null;
	scopes: string | null;
	expiresAt: string | null;
	/** Derived, not stored: `expiresAt` is in the past. */
	expired: boolean;
	accountLabel: string | null;
	createdAt: string;
	updatedAt: string;
}

/**
 * What the connector may do about this endpoint right now.
 *
 * Three outcomes, not two, because "no credential" and "the credential has run out" have
 * different remedies and a single "not connected" sends the user to paste a token they already
 * pasted. `missing` additionally carries whether an unbound LEGACY token exists, so the refusal
 * can name the one action that fixes it instead of reading as data loss.
 */
export type McpCredentialResolution =
	| { status: "ok"; token: string; authMode: McpAuthMode; expiresAt: string | null }
	| { status: "expired"; authMode: McpAuthMode; expiresAt: string }
	| { status: "missing"; legacy: boolean };

interface CredRow {
	endpoint: string;
	auth_mode: string;
	issuer: string | null;
	scopes: string | null;
	expires_at: string | null;
	account_label: string | null;
	created_at: string;
	updated_at: string;
}

interface CipherRow {
	key_ciphertext: ArrayBuffer;
	dek_wrapped: ArrayBuffer;
	iv: ArrayBuffer;
}

function authModeOf(raw: string | null | undefined): McpAuthMode {
	return raw === "oauth" ? "oauth" : "bearer";
}

/** Is an ISO timestamp in the past? An unparseable value is treated as NOT expired: refusing on
 *  a value we cannot read would brick a working credential over a formatting bug, and the wire
 *  still fails closed if the server disagrees. */
export function isExpired(expiresAt: string | null | undefined, now: number = Date.now()): boolean {
	if (!expiresAt) return false;
	const t = Date.parse(expiresAt);
	return Number.isFinite(t) && t <= now;
}

function toInfo(r: CredRow, now = Date.now()): McpCredentialInfo {
	return {
		endpoint: r.endpoint,
		authMode: authModeOf(r.auth_mode),
		issuer: r.issuer,
		scopes: r.scopes,
		expiresAt: r.expires_at,
		expired: isExpired(r.expires_at, now),
		accountLabel: r.account_label,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	};
}

/** Does the account still hold the old provider-wide token? Used only to explain the situation. */
export async function hasLegacyMcpCredential(env: Env, userId: string): Promise<boolean> {
	if (!userId) return false;
	try {
		const row = await env.DB.prepare("SELECT 1 AS present FROM user_api_keys WHERE user_id = ?1 AND provider = ?2")
			.bind(userId, LEGACY_MCP_PROVIDER)
			.first<{ present: number }>();
		return !!row;
	} catch {
		return false;
	}
}

/**
 * THE resolution rule. Fail-closed on every uncertainty: no user, no endpoint, no row, a decrypt
 * failure, a D1 error, an expired credential — all refuse.
 *
 * There is deliberately NO fallback to the legacy provider-wide token. Falling back would restore
 * the exact behaviour this ticket is about: an unbound token is one whose server we do not know,
 * and sending it anyway is the disclosure. The legacy token is reported (so the user can bind it
 * in one click, without re-typing it) and never sent.
 */
export async function resolveMcpCredential(env: Env | undefined, userId: string | undefined, endpoint: string | null): Promise<McpCredentialResolution> {
	if (!env?.DB || !userId || !endpoint) return { status: "missing", legacy: false };
	try {
		const row = await env.DB.prepare(
			"SELECT auth_mode, expires_at, key_ciphertext, dek_wrapped, iv FROM mcp_credentials WHERE user_id = ?1 AND endpoint = ?2",
		)
			.bind(userId, endpoint)
			.first<CipherRow & { auth_mode: string; expires_at: string | null }>();

		if (!row) return { status: "missing", legacy: await hasLegacyMcpCredential(env, userId) };

		const authMode = authModeOf(row.auth_mode);
		if (isExpired(row.expires_at)) return { status: "expired", authMode, expiresAt: String(row.expires_at) };
		if (!env.KEY_ENCRYPTION_KEY) return { status: "missing", legacy: false };

		const token = await decryptKey(new Uint8Array(row.key_ciphertext), new Uint8Array(row.dek_wrapped), new Uint8Array(row.iv), env.KEY_ENCRYPTION_KEY);
		if (!token) return { status: "missing", legacy: false };
		return { status: "ok", token, authMode, expiresAt: row.expires_at };
	} catch {
		// A storage or crypto failure must not degrade into "send nothing and hope", nor into
		// falling back to a token bound to some other server.
		return { status: "missing", legacy: false };
	}
}

/** The credentials this account holds, metadata only — never the token. */
export async function listMcpCredentials(env: Env, userId: string): Promise<McpCredentialInfo[]> {
	const res = await env.DB.prepare(
		"SELECT endpoint, auth_mode, issuer, scopes, expires_at, account_label, created_at, updated_at FROM mcp_credentials WHERE user_id = ?1 ORDER BY endpoint",
	)
		.bind(userId)
		.all<CredRow>();
	const now = Date.now();
	return (res.results ?? []).map((r) => toInfo(r, now));
}

export interface SaveMcpCredentialInput {
	userId: string;
	/** Already normalized by the caller — this module never re-derives it, so there is one parser. */
	endpoint: string;
	token: string;
	authMode?: McpAuthMode;
	issuer?: string | null;
	scopes?: string | null;
	expiresAt?: string | null;
	accountLabel?: string | null;
	/** OAuth only (#180/#258). Envelope-encrypted separately from the access token. */
	refreshToken?: string | null;
	/** Where to renew it, recorded so a 3am refresh is one POST, not the whole discovery chain. */
	tokenEndpoint?: string | null;
}

/**
 * Store (or replace) the credential for ONE endpoint. Replacing one endpoint's credential
 * touches no other endpoint — that isolation is the whole point of the primary key.
 *
 * FULL-REPLACE semantics, including the OAuth columns: writing a credential means "this is now
 * the credential for this server", so a pasted bearer clears leftover refresh material rather
 * than leaving a refresh token that would silently resurrect a revoked authorization. The
 * rotate-in-place path is `updateMcpAccessToken`, which is the one that preserves it.
 */
export async function saveMcpCredential(env: Env, input: SaveMcpCredentialInput): Promise<void> {
	if (!env.KEY_ENCRYPTION_KEY) throw new HttpError(500, "Key encryption not configured");
	const { ciphertext, dekWrapped, iv } = await encryptKey(input.token, env.KEY_ENCRYPTION_KEY);
	// A separate DEK for the refresh token: the access token is copied into an Authorization header
	// on every call while the refresh token never leaves the token endpoint, so they do not share a
	// key even though they share a row.
	const refresh = input.refreshToken ? await encryptKey(input.refreshToken, env.KEY_ENCRYPTION_KEY) : null;
	await env.DB.prepare(
		`INSERT INTO mcp_credentials (user_id, endpoint, auth_mode, issuer, scopes, expires_at, key_ciphertext, dek_wrapped, iv, account_label, token_endpoint, refresh_ciphertext, refresh_dek_wrapped, refresh_iv, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, datetime('now'), datetime('now'))
		 ON CONFLICT(user_id, endpoint) DO UPDATE SET
		   auth_mode = excluded.auth_mode,
		   issuer = excluded.issuer,
		   scopes = excluded.scopes,
		   expires_at = excluded.expires_at,
		   key_ciphertext = excluded.key_ciphertext,
		   dek_wrapped = excluded.dek_wrapped,
		   iv = excluded.iv,
		   account_label = excluded.account_label,
		   token_endpoint = excluded.token_endpoint,
		   refresh_ciphertext = excluded.refresh_ciphertext,
		   refresh_dek_wrapped = excluded.refresh_dek_wrapped,
		   refresh_iv = excluded.refresh_iv,
		   updated_at = datetime('now')`,
	)
		.bind(
			input.userId,
			input.endpoint,
			input.authMode ?? "bearer",
			input.issuer ?? null,
			input.scopes ?? null,
			input.expiresAt ?? null,
			ciphertext,
			dekWrapped,
			iv,
			input.accountLabel ?? null,
			input.tokenEndpoint ?? null,
			refresh?.ciphertext ?? null,
			refresh?.dekWrapped ?? null,
			refresh?.iv ?? null,
		)
		.run();
}

/** What a renewal needs, decrypted. Null when this endpoint holds no refreshable credential. */
export interface McpRefreshMaterial {
	issuer: string | null;
	tokenEndpoint: string;
	refreshToken: string;
	expiresAt: string | null;
}

/**
 * Read the material for an unattended renewal — refresh token plus where to spend it.
 *
 * Deliberately separate from `resolveMcpCredential`: that function answers "what may be sent to
 * this server right now" and must stay a pure read that fails closed. A refresh token is not
 * sendable to the resource at all, so returning it there would put a credential the MCP server
 * must never see one field away from the header we build.
 */
export async function readMcpRefreshMaterial(env: Env, userId: string, endpoint: string): Promise<McpRefreshMaterial | null> {
	if (!env.KEY_ENCRYPTION_KEY) return null;
	try {
		const row = await env.DB.prepare(
			"SELECT auth_mode, issuer, token_endpoint, expires_at, refresh_ciphertext, refresh_dek_wrapped, refresh_iv FROM mcp_credentials WHERE user_id = ?1 AND endpoint = ?2",
		)
			.bind(userId, endpoint)
			.first<{
				auth_mode: string;
				issuer: string | null;
				token_endpoint: string | null;
				expires_at: string | null;
				refresh_ciphertext: ArrayBuffer | null;
				refresh_dek_wrapped: ArrayBuffer | null;
				refresh_iv: ArrayBuffer | null;
			}>();
		if (!row || authModeOf(row.auth_mode) !== "oauth") return null;
		if (!row.token_endpoint || !row.refresh_ciphertext || !row.refresh_dek_wrapped || !row.refresh_iv) return null;
		const refreshToken = await decryptKey(
			new Uint8Array(row.refresh_ciphertext),
			new Uint8Array(row.refresh_dek_wrapped),
			new Uint8Array(row.refresh_iv),
			env.KEY_ENCRYPTION_KEY,
		);
		if (!refreshToken) return null;
		return { issuer: row.issuer, tokenEndpoint: row.token_endpoint, refreshToken, expiresAt: row.expires_at };
	} catch {
		return null;
	}
}

/**
 * Rotate an OAuth credential in place after a successful refresh.
 *
 * The refresh token is updated ONLY when the server issued a new one. Servers that rotate
 * refresh tokens send a replacement and invalidate the old; servers that don't send nothing —
 * and overwriting with NULL there would throw away the only thing that can renew this credential,
 * turning a working unattended chain into one that dies at the next expiry.
 */
export async function updateMcpAccessToken(
	env: Env,
	input: { userId: string; endpoint: string; token: string; expiresAt: string | null; scopes?: string | null; refreshToken?: string | null },
): Promise<void> {
	if (!env.KEY_ENCRYPTION_KEY) throw new HttpError(500, "Key encryption not configured");
	const { ciphertext, dekWrapped, iv } = await encryptKey(input.token, env.KEY_ENCRYPTION_KEY);
	const refresh = input.refreshToken ? await encryptKey(input.refreshToken, env.KEY_ENCRYPTION_KEY) : null;
	await env.DB.prepare(
		`UPDATE mcp_credentials SET
		   key_ciphertext = ?3,
		   dek_wrapped = ?4,
		   iv = ?5,
		   expires_at = ?6,
		   scopes = COALESCE(?7, scopes),
		   refresh_ciphertext = COALESCE(?8, refresh_ciphertext),
		   refresh_dek_wrapped = COALESCE(?9, refresh_dek_wrapped),
		   refresh_iv = COALESCE(?10, refresh_iv),
		   updated_at = datetime('now')
		 WHERE user_id = ?1 AND endpoint = ?2`,
	)
		.bind(
			input.userId,
			input.endpoint,
			ciphertext,
			dekWrapped,
			iv,
			input.expiresAt ?? null,
			input.scopes ?? null,
			refresh?.ciphertext ?? null,
			refresh?.dekWrapped ?? null,
			refresh?.iv ?? null,
		)
		.run();
}

/** Forget one endpoint's credential. Returns false when there was nothing to forget, so the
 *  console can distinguish "disconnected" from "there was never a credential here". */
export async function deleteMcpCredential(env: Env, userId: string, endpoint: string): Promise<boolean> {
	const res = await env.DB.prepare("DELETE FROM mcp_credentials WHERE user_id = ?1 AND endpoint = ?2").bind(userId, endpoint).run();
	return (res.meta?.changes ?? 0) > 0;
}

/** Discard the unbound legacy token. Offered so "you have a token bound to nothing" is a state
 *  the user can clear, rather than a permanent notice they learn to ignore. */
export async function discardLegacyMcpCredential(env: Env, userId: string): Promise<boolean> {
	const res = await env.DB.prepare("DELETE FROM user_api_keys WHERE user_id = ?1 AND provider = ?2").bind(userId, LEGACY_MCP_PROVIDER).run();
	return (res.meta?.changes ?? 0) > 0;
}

/**
 * Bind the legacy provider-wide token to ONE endpoint, without the user re-typing it.
 *
 * The ciphertext, wrapped DEK and IV are copied VERBATIM. Same KEK, same wrapping, so this is a
 * pure relocation: no plaintext is produced to perform it, which means adoption cannot leak the
 * credential even into a Worker's memory, and a KEK rotation story is unchanged.
 *
 * Returns false when there is no legacy token — the caller reports that rather than writing a
 * row with no material behind it.
 */
export async function adoptLegacyMcpCredential(env: Env, userId: string, endpoint: string): Promise<boolean> {
	const row = await env.DB.prepare("SELECT key_ciphertext, dek_wrapped, iv, account_label FROM user_api_keys WHERE user_id = ?1 AND provider = ?2")
		.bind(userId, LEGACY_MCP_PROVIDER)
		.first<CipherRow & { account_label: string | null }>();
	if (!row) return false;
	await env.DB.prepare(
		`INSERT INTO mcp_credentials (user_id, endpoint, auth_mode, key_ciphertext, dek_wrapped, iv, account_label, created_at, updated_at)
		 VALUES (?1, ?2, 'bearer', ?3, ?4, ?5, ?6, datetime('now'), datetime('now'))
		 ON CONFLICT(user_id, endpoint) DO UPDATE SET
		   auth_mode = 'bearer',
		   key_ciphertext = excluded.key_ciphertext,
		   dek_wrapped = excluded.dek_wrapped,
		   iv = excluded.iv,
		   account_label = excluded.account_label,
		   expires_at = NULL,
		   updated_at = datetime('now')`,
	)
		.bind(userId, endpoint, row.key_ciphertext, row.dek_wrapped, row.iv, row.account_label ?? null)
		.run();
	return true;
}

/**
 * The refusal text, written to be actionable. A "no credential" that doesn't say WHICH server
 * needs one gets read as "MCP is broken" — and, since #286, a user who previously had a working
 * global token needs to be told their token still exists and where to bind it, or the change
 * reads as data loss.
 */
export function mcpCredentialDenial(endpoint: string, r: Extract<McpCredentialResolution, { status: "missing" | "expired" }>): string {
	if (r.status === "expired") {
		return `The credential for ${endpoint} expired at ${r.expiresAt}. Reconnect that server under Settings → Permissions & Connections → MCP connections.`;
	}
	const legacy = r.legacy
		? " You still have an older account-wide MCP token, but it is not bound to any server — for safety it is no longer sent automatically. Bind it to this server (or replace it) in the same panel."
		: "";
	return `No credential stored for ${endpoint}. Add that server's access token under Settings → Permissions & Connections → MCP connections, or pass auth:"none" for an open server.${legacy}`;
}
