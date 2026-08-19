/**
 * Gmail connection for the permissioned agent email tools.
 *
 * A user connects their Gmail so agents they have granted email permission can read it and —
 * since #713 — reply from it. We request offline access and persist ONLY the refresh token,
 * encrypted in the key vault as provider "gmail". Access tokens are minted on demand and never
 * stored.
 *
 * Two scopes are requested: `gmail.readonly` and `gmail.send`. They are deliberately separate
 * powers and `gmail.send` is send-ONLY — it cannot read, delete or modify. `gmail.modify` would
 * cover sending too and is not requested, because it would also let a bug delete the owner's mail.
 *
 * A connection made before #713 holds `gmail.readonly` alone. Its refresh token keeps working and
 * keeps minting access tokens, so nothing looks broken until a send 403s at Google. That is why
 * the granted scopes are recorded (migration 0133) and surfaced as `canSend` — the read half of
 * an old connection is unaffected, and the send half says "reconnect" instead of failing raw.
 */
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { decryptKey, encryptKey } from "../lib/crypto.js";
import { GMAIL_SCOPE, GMAIL_SEND_SCOPE, mintGmailAccessToken, scopesAllowSend } from "../lib/gmail.js";
import { signConnectorState, verifyConnectorState } from "../lib/connector-oauth.js";
import { clearOauthBindCookie, newOauthNonce, oauthBindCookie, readOauthBindCookie, OAUTH_BIND_ERROR } from "../lib/oauth-nonce.js";
import type { Env } from "../types.js";

export const emailRoutes = new Hono<{ Bindings: Env }>();

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const STATE_TTL_SECONDS = 10 * 60;
/** The vault provider this flow stores under — also pins the state to THIS connector. */
const PROVIDER = "gmail";

function redirectUri(c: { req: { url: string } }): string {
	return new URL("/v1/email/google/callback", c.req.url).toString();
}

// The state helpers used to be a LOCAL copy of connector-oauth.ts's, byte-identical down to the
// base64url helpers — so the fix that binds a state to its browser (and to its connector) would
// have landed in three files and missed this one. Gmail is the highest-value of the four: the
// refresh token it stores is what `find_confirmation_link` reads the owner's mail with.

/** Start the Gmail OAuth flow. Returns the Google consent URL to open. */
emailRoutes.get("/google/start", async (c) => {
	const session = await requireUser(c);
	if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
		throw new HttpError(503, "Gmail connection is not configured on this deployment");
	}
	// Bind the state to THIS browser and to THIS connector: otherwise an attacker starts the
	// flow, sends the consent URL to a victim, and the VICTIM's Gmail refresh token is stored
	// under the ATTACKER's account. See lib/oauth-nonce.ts.
	const bindNonce = newOauthNonce();
	const state = await signConnectorState(
		session.uid,
		Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
		c.env.SESSION_SIGNING_KEY,
		{ nonce: bindNonce, provider: PROVIDER },
	);
	c.header("Set-Cookie", oauthBindCookie(bindNonce, PROVIDER));
	const url = new URL(AUTH_ENDPOINT);
	url.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID);
	url.searchParams.set("redirect_uri", redirectUri(c));
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", `openid email ${GMAIL_SCOPE} ${GMAIL_SEND_SCOPE}`);
	url.searchParams.set("access_type", "offline");
	// Forces a refresh_token every time — and, since #713, is also what re-prompts an ALREADY
	// connected user for the newly-added send scope. Without it Google silently returns the old
	// grant and the reconnect appears to succeed while changing nothing.
	url.searchParams.set("prompt", "consent");
	url.searchParams.set("state", state);
	return c.json({ url: url.toString() });
});

/** Whether the current user has Gmail connected — and which account. */
emailRoutes.get("/status", async (c) => {
	const session = await requireUser(c);
	const configured = !!(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET);
	const row = await c.env.DB.prepare(
		"SELECT created_at, account_label, granted_scopes, key_ciphertext, dek_wrapped, iv FROM user_api_keys WHERE user_id = ?1 AND provider = 'gmail'",
	)
		.bind(session.uid)
		.first<{ created_at: string; account_label: string | null; granted_scopes: string | null; key_ciphertext: ArrayBuffer; dek_wrapped: ArrayBuffer; iv: ArrayBuffer }>();
	let email = row?.account_label ?? null;
	// Backfill the account email for a connection made before we captured it — this
	// also verifies the token still works (a revoked one makes minting throw).
	if (row && !email && configured && c.env.KEY_ENCRYPTION_KEY) {
		try {
			const refresh = await decryptKey(new Uint8Array(row.key_ciphertext), new Uint8Array(row.dek_wrapped), new Uint8Array(row.iv), c.env.KEY_ENCRYPTION_KEY);
			const accessToken = await mintGmailAccessToken(c.env, refresh);
			const ui = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: `Bearer ${accessToken}` } });
			if (ui.ok) {
				email = ((await ui.json()) as { email?: string }).email ?? null;
				if (email) await c.env.DB.prepare("UPDATE user_api_keys SET account_label = ?1 WHERE user_id = ?2 AND provider = 'gmail'").bind(email, session.uid).run();
			}
		} catch {
			/* token may be revoked/expired — leave email null, still "connected" per the row */
		}
	}
	// `canSend` is the #713 distinction the console needs: a connection made before the send
	// scope existed is CONNECTED but read-only, and the only fix is a reconnect. Reporting it
	// here is what lets the UI say so instead of the agent discovering it as a 403 mid-reply.
	return c.json({
		connected: !!row,
		email,
		connectedAt: row?.created_at ?? null,
		configured,
		canSend: scopesAllowSend(row?.granted_scopes),
	});
});

/** Disconnect Gmail. */
emailRoutes.delete("/google", async (c) => {
	const session = await requireUser(c);
	await c.env.DB.prepare(
		"DELETE FROM user_api_keys WHERE user_id = ?1 AND provider = 'gmail'",
	)
		.bind(session.uid)
		.run();
	return c.json({ success: true });
});

/** OAuth callback — exchange the code, store the refresh token. */
emailRoutes.get("/google/callback", async (c) => {
	const code = c.req.query("code");
	const stateRaw = c.req.query("state");
	if (!code || !stateRaw) return c.text("missing code or state", 400);
	if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
		return c.text("Gmail connection is not configured", 503);
	}
	if (!c.env.KEY_ENCRYPTION_KEY) return c.text("Key encryption not configured", 500);

	const uid = await verifyConnectorState(stateRaw, c.env.SESSION_SIGNING_KEY, {
		cookieNonce: readOauthBindCookie(c.req.header("cookie"), PROVIDER),
		provider: PROVIDER,
	});
	c.header("Set-Cookie", clearOauthBindCookie(PROVIDER)); // single-use, whatever the outcome
	if (!uid) return c.text(OAUTH_BIND_ERROR, 400);

	const tokenRes = await fetch(TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: c.env.GOOGLE_CLIENT_ID,
			client_secret: c.env.GOOGLE_CLIENT_SECRET,
			code,
			redirect_uri: redirectUri(c),
			grant_type: "authorization_code",
		}),
	});
	if (!tokenRes.ok) return c.text(`Gmail token exchange failed (${tokenRes.status})`, 400);
	const tok = (await tokenRes.json()) as { refresh_token?: string; access_token?: string; scope?: string };
	if (!tok.refresh_token) {
		return c.text(
			"Google did not return a refresh token. Remove this app's access at myaccount.google.com/permissions and reconnect.",
			400,
		);
	}

	// Capture WHICH account this is, so the UI can show it (scope includes `email`).
	let accountLabel: string | null = null;
	if (tok.access_token) {
		try {
			const ui = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
				headers: { Authorization: `Bearer ${tok.access_token}` },
			});
			if (ui.ok) accountLabel = ((await ui.json()) as { email?: string }).email ?? null;
		} catch {
			/* non-fatal — the connection still works without the label */
		}
	}

	const { ciphertext, dekWrapped, iv } = await encryptKey(
		tok.refresh_token,
		c.env.KEY_ENCRYPTION_KEY,
	);
	// What Google ACTUALLY granted, not what we asked for. A user can untick a scope on the
	// consent screen, and recording the request rather than the grant would make `canSend` lie in
	// exactly the case it exists to catch (migration 0133).
	const grantedScopes = tok.scope ?? null;

	await c.env.DB.prepare(
		`INSERT INTO user_api_keys (user_id, provider, key_ciphertext, dek_wrapped, iv, account_label, granted_scopes, created_at)
     VALUES (?1, 'gmail', ?2, ?3, ?4, ?5, ?6, datetime('now'))
     ON CONFLICT(user_id, provider) DO UPDATE SET
       key_ciphertext = excluded.key_ciphertext,
       dek_wrapped = excluded.dek_wrapped,
       iv = excluded.iv,
       account_label = excluded.account_label,
       granted_scopes = excluded.granted_scopes,
       created_at = excluded.created_at`,
	)
		.bind(uid, ciphertext, dekWrapped, iv, accountLabel, grantedScopes)
		.run();

	return c.html(
		"<!doctype html><title>Gmail connected</title><body style='font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0'><div style='text-align:center'><h1>✅ Gmail connected</h1><p>You can close this tab and return to ProAgentStore.</p></div></body>",
	);
});
