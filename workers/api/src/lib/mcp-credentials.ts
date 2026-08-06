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
}

/** Store (or replace) the credential for ONE endpoint. Replacing one endpoint's credential
 *  touches no other endpoint — that isolation is the whole point of the primary key. */
export async function saveMcpCredential(env: Env, input: SaveMcpCredentialInput): Promise<void> {
	if (!env.KEY_ENCRYPTION_KEY) throw new HttpError(500, "Key encryption not configured");
	const { ciphertext, dekWrapped, iv } = await encryptKey(input.token, env.KEY_ENCRYPTION_KEY);
	await env.DB.prepare(
		`INSERT INTO mcp_credentials (user_id, endpoint, auth_mode, issuer, scopes, expires_at, key_ciphertext, dek_wrapped, iv, account_label, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now'), datetime('now'))
		 ON CONFLICT(user_id, endpoint) DO UPDATE SET
		   auth_mode = excluded.auth_mode,
		   issuer = excluded.issuer,
		   scopes = excluded.scopes,
		   expires_at = excluded.expires_at,
		   key_ciphertext = excluded.key_ciphertext,
		   dek_wrapped = excluded.dek_wrapped,
		   iv = excluded.iv,
		   account_label = excluded.account_label,
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
