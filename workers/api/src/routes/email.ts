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
import { listConnectorAccounts } from "../lib/connector-accounts.js";
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

/**
 * Which Gmail accounts the current user has connected (#715).
 *
 * Was a single-row lookup, which stopped being correct the moment the vault could hold two
 * mailboxes: the query still matched, `.first()` still returned something, and WHICH something
 * was whatever SQLite felt like. A silent wrong-mailbox answer is precisely what this feature
 * must not introduce, so the route now returns the list.
 *
 * The top-level `email` / `connectedAt` / `canSend` fields are kept for callers written before
 * this, and describe the ONE account when there is exactly one. With several connected they go
 * null / false — not "the first one" — because a single answer to "which mailbox is this?" does
 * not exist any more, and inventing one is the bug.
 */
emailRoutes.get("/status", async (c) => {
	const session = await requireUser(c);
	const configured = !!(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET);
	const accounts = await listConnectorAccounts(c.env, session.uid, "gmail");

	// Backfill the address for a connection made before we captured it (and verify the token
	// still works — a revoked one makes minting throw). Only for a lone unlabelled row: with
	// several rows there is no way to know which mailbox a probe just described.
	//
	// It deliberately fills `account_label` only, not `account_id`. Changing an id would move a
	// primary key and could collide with a row already at that address; the row identifies itself
	// properly on its next reconnect, which is the cheap and safe moment.
	if (accounts.length === 1 && !accounts[0].label && accounts[0].accountId === "" && configured && c.env.KEY_ENCRYPTION_KEY) {
		try {
			const row = await c.env.DB.prepare(
				"SELECT key_ciphertext, dek_wrapped, iv FROM user_api_keys WHERE user_id = ?1 AND provider = 'gmail' AND account_id = ''",
			)
				.bind(session.uid)
				.first<{ key_ciphertext: ArrayBuffer; dek_wrapped: ArrayBuffer; iv: ArrayBuffer }>();
			if (row) {
				const refresh = await decryptKey(new Uint8Array(row.key_ciphertext), new Uint8Array(row.dek_wrapped), new Uint8Array(row.iv), c.env.KEY_ENCRYPTION_KEY);
				const accessToken = await mintGmailAccessToken(c.env, refresh);
				const ui = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: `Bearer ${accessToken}` } });
				if (ui.ok) {
					const found = ((await ui.json()) as { email?: string }).email ?? null;
					if (found) {
						await c.env.DB.prepare(
							"UPDATE user_api_keys SET account_label = ?1 WHERE user_id = ?2 AND provider = 'gmail' AND account_id = ''",
						)
							.bind(found, session.uid)
							.run();
						accounts[0].label = found;
					}
				}
			}
		} catch {
			/* token may be revoked/expired — leave the label null, still "connected" per the row */
		}
	}

	const only = accounts.length === 1 ? accounts[0] : null;
	return c.json({
		connected: accounts.length > 0,
		email: only?.label ?? null,
		connectedAt: only?.connectedAt ?? null,
		configured,
		// Fail-closed with several accounts: whichever one an agent resolves to must be able to
		// send, so "yes" is only honest when every one of them can.
		canSend: accounts.length > 0 && accounts.every((a) => scopesAllowSend(a.grantedScopes)),
		accounts: accounts.map((a) => ({
			accountId: a.accountId,
			label: a.label,
			connectedAt: a.connectedAt,
			canSend: scopesAllowSend(a.grantedScopes),
		})),
	});
});

/**
 * Disconnect ONE Gmail account, or all of them.
 *
 * `?account=<id>` removes that mailbox; omitting it removes every Gmail connection, which is
 * what the pre-#715 route did and what a caller written against it still expects. The response
 * says how many rows went, so a console can report "disconnected 1 of 2" rather than implying
 * the whole provider is gone.
 */
emailRoutes.delete("/google", async (c) => {
	const session = await requireUser(c);
	const account = c.req.query("account");
	const result = account === undefined
		? await c.env.DB.prepare("DELETE FROM user_api_keys WHERE user_id = ?1 AND provider = 'gmail'").bind(session.uid).run()
		: await c.env.DB.prepare("DELETE FROM user_api_keys WHERE user_id = ?1 AND provider = 'gmail' AND account_id = ?2").bind(session.uid, account).run();
	const remaining = await listConnectorAccounts(c.env, session.uid, "gmail");
	return c.json({
		success: true,
		removed: result.meta?.changes ?? 0,
		remaining: remaining.map((a) => ({ accountId: a.accountId, label: a.label })),
	});
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

	// The mailbox address IS the account id (#715). Reconnecting the same mailbox updates its
	// row; authorising a DIFFERENT one adds a row beside it, which is the whole point — one
	// person, several mailboxes, each agent choosing which it speaks as.
	//
	// An address we could not read falls back to '', the unnamed-default id. That collapses with
	// any other unlabelled connection, which is the old single-slot behaviour and is the right
	// fallback: it is what the row meant before this change.
	const accountId = accountLabel ?? "";

	await c.env.DB.prepare(
		`INSERT INTO user_api_keys (user_id, provider, account_id, key_ciphertext, dek_wrapped, iv, account_label, granted_scopes, created_at)
     VALUES (?1, 'gmail', ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))
     ON CONFLICT(user_id, provider, account_id) DO UPDATE SET
       key_ciphertext = excluded.key_ciphertext,
       dek_wrapped = excluded.dek_wrapped,
       iv = excluded.iv,
       account_label = excluded.account_label,
       granted_scopes = excluded.granted_scopes,
       created_at = excluded.created_at`,
	)
		.bind(uid, accountId, ciphertext, dekWrapped, iv, accountLabel, grantedScopes)
		.run();

	return c.html(
		"<!doctype html><title>Gmail connected</title><body style='font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0'><div style='text-align:center'><h1>✅ Gmail connected</h1><p>You can close this tab and return to ProAgentStore.</p></div></body>",
	);
});
