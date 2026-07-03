/**
 * Gmail connection for the permissioned agent email tool.
 *
 * A user connects their Gmail (read-only) so agents they have granted email
 * permission can look up confirmation/verification links. We request offline
 * access and persist ONLY the refresh token, encrypted in the key vault as
 * provider "gmail". Access tokens are minted on demand and never stored.
 */
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { decryptKey, encryptKey } from "../lib/crypto.js";
import { GMAIL_SCOPE, mintGmailAccessToken } from "../lib/gmail.js";
import type { Env } from "../types.js";

export const emailRoutes = new Hono<{ Bindings: Env }>();

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const STATE_TTL_SECONDS = 10 * 60;

function redirectUri(c: { req: { url: string } }): string {
	return new URL("/v1/email/google/callback", c.req.url).toString();
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

/** Sign a short-lived state token carrying the user id. */
async function signState(uid: string, exp: number, secret: string): Promise<string> {
	const payload = b64url(new TextEncoder().encode(JSON.stringify({ uid, exp })));
	const sig = b64url(
		new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(payload))),
	);
	return `${payload}.${sig}`;
}

async function verifyState(token: string, secret: string): Promise<string | null> {
	const [payload, sig] = token.split(".");
	if (!payload || !sig) return null;
	const valid = await crypto.subtle.verify(
		"HMAC",
		await hmacKey(secret),
		unb64url(sig),
		new TextEncoder().encode(payload),
	);
	if (!valid) return null;
	const { uid, exp } = JSON.parse(new TextDecoder().decode(unb64url(payload))) as {
		uid: string;
		exp: number;
	};
	if (exp < Math.floor(Date.now() / 1000)) return null;
	return uid;
}

/** Start the Gmail OAuth flow. Returns the Google consent URL to open. */
emailRoutes.get("/google/start", async (c) => {
	const session = await requireUser(c);
	if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
		throw new HttpError(503, "Gmail connection is not configured on this deployment");
	}
	const state = await signState(
		session.uid,
		Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
		c.env.SESSION_SIGNING_KEY,
	);
	const url = new URL(AUTH_ENDPOINT);
	url.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID);
	url.searchParams.set("redirect_uri", redirectUri(c));
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", `openid email ${GMAIL_SCOPE}`);
	url.searchParams.set("access_type", "offline");
	url.searchParams.set("prompt", "consent"); // force a refresh_token every time
	url.searchParams.set("state", state);
	return c.json({ url: url.toString() });
});

/** Whether the current user has Gmail connected — and which account. */
emailRoutes.get("/status", async (c) => {
	const session = await requireUser(c);
	const configured = !!(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET);
	const row = await c.env.DB.prepare(
		"SELECT created_at, account_label, key_ciphertext, dek_wrapped, iv FROM user_api_keys WHERE user_id = ?1 AND provider = 'gmail'",
	)
		.bind(session.uid)
		.first<{ created_at: string; account_label: string | null; key_ciphertext: ArrayBuffer; dek_wrapped: ArrayBuffer; iv: ArrayBuffer }>();
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
	return c.json({ connected: !!row, email, connectedAt: row?.created_at ?? null, configured });
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

	const uid = await verifyState(stateRaw, c.env.SESSION_SIGNING_KEY);
	if (!uid) return c.text("invalid or expired state", 400);

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
	const tok = (await tokenRes.json()) as { refresh_token?: string; access_token?: string };
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
	await c.env.DB.prepare(
		`INSERT INTO user_api_keys (user_id, provider, key_ciphertext, dek_wrapped, iv, account_label, created_at)
     VALUES (?1, 'gmail', ?2, ?3, ?4, ?5, datetime('now'))
     ON CONFLICT(user_id, provider) DO UPDATE SET
       key_ciphertext = excluded.key_ciphertext,
       dek_wrapped = excluded.dek_wrapped,
       iv = excluded.iv,
       account_label = excluded.account_label,
       created_at = excluded.created_at`,
	)
		.bind(uid, ciphertext, dekWrapped, iv, accountLabel)
		.run();

	return c.html(
		"<!doctype html><title>Gmail connected</title><body style='font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0'><div style='text-align:center'><h1>✅ Gmail connected</h1><p>You can close this tab and return to ProAgentStore.</p></div></body>",
	);
});
