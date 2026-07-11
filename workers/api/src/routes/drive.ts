/**
 * Google Drive connector.
 *
 * Users connect Drive with read-only OAuth. We store only the refresh token,
 * encrypted in the key vault as provider "google_drive". Imported Drive docs are
 * copied into the instance knowledge base, then the existing DO path vectorizes
 * them like any other document.
 */
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HttpError, requireUser } from "../lib/auth.js";
import { decryptKey, encryptKey } from "../lib/crypto.js";
import { DRIVE_SCOPE, exportDriveFile, listDriveFiles, mintDriveAccessToken } from "../lib/drive.js";
import type { Env } from "../types.js";
import { requireOwnedInstance } from "./instances-runtime.js";

export const driveRoutes = new Hono<{ Bindings: Env }>();

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const STATE_TTL_SECONDS = 10 * 60;
const PROVIDER = "google_drive";

function redirectUri(c: { req: { url: string } }): string {
	return new URL("/v1/drive/google/callback", c.req.url).toString();
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

async function storedRefreshToken(env: Env, userId: string): Promise<string> {
	if (!env.KEY_ENCRYPTION_KEY) throw new HttpError(500, "Key encryption not configured");
	const row = await env.DB.prepare(
		"SELECT key_ciphertext, dek_wrapped, iv FROM user_api_keys WHERE user_id = ?1 AND provider = ?2",
	)
		.bind(userId, PROVIDER)
		.first<{ key_ciphertext: ArrayBuffer; dek_wrapped: ArrayBuffer; iv: ArrayBuffer }>();
	if (!row) throw new HttpError(400, "Google Drive is not connected");
	return decryptKey(
		new Uint8Array(row.key_ciphertext),
		new Uint8Array(row.dek_wrapped),
		new Uint8Array(row.iv),
		env.KEY_ENCRYPTION_KEY,
	);
}

driveRoutes.get("/google/start", async (c) => {
	const session = await requireUser(c);
	if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
		throw new HttpError(503, "Google Drive connection is not configured on this deployment");
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
	url.searchParams.set("scope", `openid email ${DRIVE_SCOPE}`);
	url.searchParams.set("access_type", "offline");
	url.searchParams.set("prompt", "consent");
	url.searchParams.set("state", state);
	return c.json({ url: url.toString() });
});

driveRoutes.get("/status", async (c) => {
	const session = await requireUser(c);
	const configured = !!(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET);
	const row = await c.env.DB.prepare(
		"SELECT created_at, account_label FROM user_api_keys WHERE user_id = ?1 AND provider = ?2",
	)
		.bind(session.uid, PROVIDER)
		.first<{ created_at: string; account_label: string | null }>();
	return c.json({ connected: !!row, email: row?.account_label ?? null, connectedAt: row?.created_at ?? null, configured });
});

driveRoutes.delete("/google", async (c) => {
	const session = await requireUser(c);
	await c.env.DB.prepare(
		"DELETE FROM user_api_keys WHERE user_id = ?1 AND provider = ?2",
	)
		.bind(session.uid, PROVIDER)
		.run();
	return c.json({ success: true });
});

driveRoutes.get("/google/callback", async (c) => {
	const code = c.req.query("code");
	const stateRaw = c.req.query("state");
	if (!code || !stateRaw) return c.text("missing code or state", 400);
	if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
		return c.text("Google Drive connection is not configured", 503);
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
	if (!tokenRes.ok) return c.text(`Google Drive token exchange failed (${tokenRes.status})`, 400);
	const tok = (await tokenRes.json()) as { refresh_token?: string; access_token?: string };
	if (!tok.refresh_token) {
		return c.text(
			"Google did not return a refresh token. Remove this app's access at myaccount.google.com/permissions and reconnect.",
			400,
		);
	}

	let accountLabel: string | null = null;
	if (tok.access_token) {
		try {
			const ui = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
				headers: { Authorization: `Bearer ${tok.access_token}` },
			});
			if (ui.ok) accountLabel = ((await ui.json()) as { email?: string }).email ?? null;
		} catch {
			/* non-fatal */
		}
	}

	const { ciphertext, dekWrapped, iv } = await encryptKey(
		tok.refresh_token,
		c.env.KEY_ENCRYPTION_KEY,
	);
	await c.env.DB.prepare(
		`INSERT INTO user_api_keys (user_id, provider, key_ciphertext, dek_wrapped, iv, account_label, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))
     ON CONFLICT(user_id, provider) DO UPDATE SET
       key_ciphertext = excluded.key_ciphertext,
       dek_wrapped = excluded.dek_wrapped,
       iv = excluded.iv,
       account_label = excluded.account_label,
       created_at = excluded.created_at`,
	)
		.bind(uid, PROVIDER, ciphertext, dekWrapped, iv, accountLabel)
		.run();

	return c.html(
		"<!doctype html><title>Google Drive connected</title><body style='font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0'><div style='text-align:center'><h1>Google Drive connected</h1><p>You can close this tab and return to ProAgentStore.</p></div></body>",
	);
});

driveRoutes.get("/files", async (c) => {
	const session = await requireUser(c);
	const refresh = await storedRefreshToken(c.env, session.uid);
	const accessToken = await mintDriveAccessToken(c.env, refresh);
	const query = c.req.query("q") || undefined;
	const limit = Number(c.req.query("limit")) || 20;
	return c.json({ files: await listDriveFiles(accessToken, { query, pageSize: limit }) });
});

driveRoutes.post("/instances/:instanceId/import", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const body = (await c.req.json().catch(() => ({}))) as { fileId?: string; url?: string; title?: string };
	const fileRef = body.fileId || body.url;
	if (!fileRef) throw new HttpError(400, "fileId or url required");

	const refresh = await storedRefreshToken(c.env, session.uid);
	const accessToken = await mintDriveAccessToken(c.env, refresh);
	const file = await exportDriveFile(accessToken, fileRef);
	const title = (body.title?.trim() || file.name || "Google Drive import").slice(0, 500);
	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
	const doRes = await stub.fetch(
		new Request("https://agent/knowledge", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title,
				content: file.text,
				source: "drive",
				sourceUrl: file.webViewLink,
			}),
		}),
	);
	const payload = (await doRes.json()) as Record<string, unknown>;
	return c.json(
		{ ...payload, driveFile: { id: file.id, name: file.name, mimeType: file.mimeType, webViewLink: file.webViewLink } },
		(doRes.ok ? 201 : doRes.status) as ContentfulStatusCode,
	);
});
