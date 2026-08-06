/**
 * Storage for the MCP OAuth flow (#180/#258, migration 0085) — client registrations, in-flight
 * authorizations, and the unattended renewal that makes the credential worth having.
 *
 * The protocol lives in `mcp-oauth.ts` and the routes in `routes/mcp.ts`; this file is the part
 * that touches D1 and `KEY_ENCRYPTION_KEY`. Everything secret here — the client secret when a
 * server issues one, the PKCE verifier while a flow is in flight — uses the platform's existing
 * envelope scheme (per-row AES-256-GCM DEK wrapped with AES-KW, `lib/crypto.ts`). No second
 * scheme, and nothing here has a reveal route: none of it has a client-side use.
 */
import type { Env } from "../types.js";
import { decryptKey, encryptKey } from "./crypto.js";
import { registerClient, type ClientRegistration } from "./connectors/dcr.js";
import {
	exchangeAuthorizationCode,
	needsRefresh,
	refreshAccessToken,
	type TokenFetch,
	type TokenResponse,
	FLOW_TTL_SECONDS,
} from "./mcp-oauth.js";
import { readMcpRefreshMaterial, resolveMcpCredential, saveMcpCredential, updateMcpAccessToken, type McpCredentialResolution } from "./mcp-credentials.js";

// ─── Client registrations, cached per (user, authorization server) ───────────────────────────

interface ClientRow {
	client_id: string;
	redirect_uri: string;
	secret_ciphertext: ArrayBuffer | null;
	secret_dek_wrapped: ArrayBuffer | null;
	secret_iv: ArrayBuffer | null;
}

async function decryptSecret(env: Env, row: ClientRow): Promise<string | null> {
	if (!row.secret_ciphertext || !row.secret_dek_wrapped || !row.secret_iv || !env.KEY_ENCRYPTION_KEY) return null;
	try {
		return (await decryptKey(new Uint8Array(row.secret_ciphertext), new Uint8Array(row.secret_dek_wrapped), new Uint8Array(row.secret_iv), env.KEY_ENCRYPTION_KEY)) || null;
	} catch {
		return null;
	}
}

/** A registration this account already holds at that issuer, or null. */
export async function readClientRegistration(env: Env, userId: string, issuer: string): Promise<ClientRegistration | null> {
	const row = await env.DB.prepare(
		"SELECT client_id, redirect_uri, secret_ciphertext, secret_dek_wrapped, secret_iv FROM mcp_oauth_clients WHERE user_id = ?1 AND issuer = ?2",
	)
		.bind(userId, issuer)
		.first<ClientRow>();
	if (!row) return null;
	return { clientId: row.client_id, clientSecret: await decryptSecret(env, row), redirectUri: row.redirect_uri };
}

async function writeClientRegistration(env: Env, userId: string, issuer: string, reg: ClientRegistration): Promise<void> {
	const secret = reg.clientSecret && env.KEY_ENCRYPTION_KEY ? await encryptKey(reg.clientSecret, env.KEY_ENCRYPTION_KEY) : null;
	await env.DB.prepare(
		`INSERT INTO mcp_oauth_clients (user_id, issuer, client_id, redirect_uri, secret_ciphertext, secret_dek_wrapped, secret_iv, created_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))
		 ON CONFLICT(user_id, issuer) DO UPDATE SET
		   client_id = excluded.client_id,
		   redirect_uri = excluded.redirect_uri,
		   secret_ciphertext = excluded.secret_ciphertext,
		   secret_dek_wrapped = excluded.secret_dek_wrapped,
		   secret_iv = excluded.secret_iv,
		   created_at = datetime('now')`,
	)
		.bind(userId, issuer, reg.clientId, reg.redirectUri, secret?.ciphertext ?? null, secret?.dekWrapped ?? null, secret?.iv ?? null)
		.run();
}

/**
 * The registration to use for this (user, issuer) — reused when we have one, registered when we
 * don't.
 *
 * REUSE IS THE POINT, not an optimization. A refresh months later has to present the SAME
 * `client_id` the grant was issued to; re-registering per flow would leave every past credential
 * holding a client id nothing can renew, and would spray throwaway client records across servers
 * that (rightly) rate-limit registration.
 *
 * A cached registration whose redirect_uri no longer matches ours is re-registered: the redirect
 * is part of what the server validates, so a stale one fails the authorize request with an error
 * the user cannot act on.
 */
export async function getOrRegisterClient(
	env: Env,
	userId: string,
	issuer: string,
	registrationEndpoint: string | undefined,
	redirectUri: string,
	scope?: string | null,
): Promise<ClientRegistration> {
	const existing = await readClientRegistration(env, userId, issuer);
	if (existing && existing.redirectUri === redirectUri) return existing;
	if (!registrationEndpoint) {
		throw new Error("This authorization server does not support dynamic client registration, so ProAgentStore cannot register itself with it. Store an access token for this server instead.");
	}
	const reg = await registerClient({ registrationEndpoint, redirectUri, scope });
	await writeClientRegistration(env, userId, issuer, reg);
	return reg;
}

// ─── In-flight authorizations ────────────────────────────────────────────────────────────────

export interface McpOauthFlow {
	id: string;
	userId: string;
	endpoint: string;
	issuer: string;
	tokenEndpoint: string;
	clientId: string;
	redirectUri: string;
	scope: string | null;
	verifier: string;
}

/** Record a started flow. The verifier is encrypted: it is the secret half of PKCE, and a stored
 *  plaintext verifier would make the D1 row as good as the code it protects. */
export async function saveFlow(env: Env, flow: McpOauthFlow, ttlSeconds: number = FLOW_TTL_SECONDS): Promise<void> {
	if (!env.KEY_ENCRYPTION_KEY) throw new Error("Key encryption not configured");
	const { ciphertext, dekWrapped, iv } = await encryptKey(flow.verifier, env.KEY_ENCRYPTION_KEY);
	await env.DB.prepare(
		`INSERT INTO mcp_oauth_flows (id, user_id, endpoint, issuer, token_endpoint, client_id, redirect_uri, scope, verifier_ciphertext, verifier_dek_wrapped, verifier_iv, created_at, expires_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'), ?12)`,
	)
		.bind(
			flow.id,
			flow.userId,
			flow.endpoint,
			flow.issuer,
			flow.tokenEndpoint,
			flow.clientId,
			flow.redirectUri,
			flow.scope ?? null,
			ciphertext,
			dekWrapped,
			iv,
			new Date(Date.now() + ttlSeconds * 1000).toISOString(),
		)
		.run();
}

/**
 * Take a flow — atomically, and once.
 *
 * DELETE … RETURNING rather than SELECT-then-DELETE: an authorization code is single-use at the
 * server too, so a replayed callback must lose the race here rather than reach the token endpoint
 * twice. The user id is part of the WHERE clause, so a state signed for one account cannot claim
 * another's flow even if the id were known.
 */
export async function claimFlow(env: Env, flowId: string, userId: string): Promise<McpOauthFlow | null> {
	if (!env.KEY_ENCRYPTION_KEY) return null;
	const row = await env.DB.prepare(
		`DELETE FROM mcp_oauth_flows WHERE id = ?1 AND user_id = ?2 AND expires_at > datetime('now')
		 RETURNING id, user_id, endpoint, issuer, token_endpoint, client_id, redirect_uri, scope, verifier_ciphertext, verifier_dek_wrapped, verifier_iv`,
	)
		.bind(flowId, userId)
		.first<{
			id: string;
			user_id: string;
			endpoint: string;
			issuer: string;
			token_endpoint: string;
			client_id: string;
			redirect_uri: string;
			scope: string | null;
			verifier_ciphertext: ArrayBuffer;
			verifier_dek_wrapped: ArrayBuffer;
			verifier_iv: ArrayBuffer;
		}>();
	if (!row) return null;
	const verifier = await decryptKey(
		new Uint8Array(row.verifier_ciphertext),
		new Uint8Array(row.verifier_dek_wrapped),
		new Uint8Array(row.verifier_iv),
		env.KEY_ENCRYPTION_KEY,
	);
	if (!verifier) return null;
	return {
		id: row.id,
		userId: row.user_id,
		endpoint: row.endpoint,
		issuer: row.issuer,
		tokenEndpoint: row.token_endpoint,
		clientId: row.client_id,
		redirectUri: row.redirect_uri,
		scope: row.scope,
		verifier,
	};
}

/** Drop abandoned flows. Cheap, and keeps a table of encrypted secrets from growing forever. */
export async function purgeExpiredFlows(env: Env): Promise<void> {
	await env.DB.prepare("DELETE FROM mcp_oauth_flows WHERE expires_at <= datetime('now')").run().catch(() => undefined);
}

// ─── Completing a flow ───────────────────────────────────────────────────────────────────────

/**
 * Exchange the code and store the result as THIS endpoint's credential.
 *
 * Every parameter of the exchange comes from the claimed flow row — never from the callback's
 * query string — so the request goes to the token endpoint we discovered for the server the user
 * named, and the credential lands under that same normalized endpoint. `auth_mode: "oauth"` is
 * what later tells `resolveMcpCredential` that an expiry is renewable rather than terminal.
 */
export async function completeFlow(env: Env, flow: McpOauthFlow, code: string, fetchImpl?: TokenFetch): Promise<TokenResponse> {
	const client = await readClientRegistration(env, flow.userId, flow.issuer);
	const tok = await exchangeAuthorizationCode(
		code,
		flow.verifier,
		{
			tokenEndpoint: flow.tokenEndpoint,
			clientId: flow.clientId,
			clientSecret: client?.clientSecret ?? null,
			redirectUri: flow.redirectUri,
			resource: flow.endpoint,
		},
		fetchImpl,
	);
	await saveMcpCredential(env, {
		userId: flow.userId,
		endpoint: flow.endpoint,
		token: tok.accessToken,
		authMode: "oauth",
		issuer: flow.issuer,
		scopes: tok.scope ?? flow.scope ?? null,
		expiresAt: tok.expiresAt,
		refreshToken: tok.refreshToken,
		tokenEndpoint: flow.tokenEndpoint,
	});
	return tok;
}

// ─── Unattended renewal ──────────────────────────────────────────────────────────────────────

/**
 * Resolve the credential to send to `endpoint`, renewing it first when it is OAuth and at (or
 * near) expiry.
 *
 * THIS IS THE PIECE THAT MAKES OAUTH USABLE FOR AGENTS. Without it a 24h access token turns every
 * cron-fired chain into a daily outage: the resolver correctly reports `expired`, the delivery
 * dead-letters, and a human has to be at a browser to restart it — the exact property #181 warns
 * against wiring. With a refresh token and the client id it was issued to, renewal is one POST
 * with no human present.
 *
 * FAILURE IS NOT ESCALATED. A refresh that fails (revoked grant, server down, network) returns the
 * ORIGINAL resolution — `expired`, with its actionable "reconnect that server" text — rather than
 * a new error class. A revoked grant genuinely does need a human; inventing a distinct failure for
 * it would only mean two messages saying the same thing, and a transient server outage must not
 * be reported as "your authorization was revoked".
 */
export async function ensureMcpAccessToken(
	env: Env | undefined,
	userId: string | undefined,
	endpoint: string | null,
	fetchImpl?: TokenFetch,
): Promise<McpCredentialResolution> {
	const current = await resolveMcpCredential(env, userId, endpoint);
	if (!env?.DB || !userId || !endpoint) return current;
	if (current.status === "missing") return current;
	// Renew when it has expired, and also when it is about to: a token that passes our check and
	// dies mid-request comes back as an unexplained 401 the user reads as a broken credential.
	const stillFresh = current.status === "ok" && !needsRefresh(current.expiresAt);
	if (stillFresh) return current;

	const material = await readMcpRefreshMaterial(env, userId, endpoint);
	if (!material) return current; // a pasted bearer, or an OAuth grant with no refresh token
	const client = material.issuer ? await readClientRegistration(env, userId, material.issuer).catch(() => null) : null;
	if (!client) return current; // no client id to present — nothing can renew this
	try {
		const tok = await refreshAccessToken(
			material.refreshToken,
			{ tokenEndpoint: material.tokenEndpoint, clientId: client.clientId, clientSecret: client.clientSecret, resource: endpoint },
			fetchImpl,
		);
		await updateMcpAccessToken(env, {
			userId,
			endpoint,
			token: tok.accessToken,
			expiresAt: tok.expiresAt,
			scopes: tok.scope,
			refreshToken: tok.refreshToken,
		});
		return { status: "ok", token: tok.accessToken, authMode: "oauth", expiresAt: tok.expiresAt };
	} catch {
		return current;
	}
}
