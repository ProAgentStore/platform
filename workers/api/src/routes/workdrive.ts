/**
 * Zoho WorkDrive connector.
 *
 * Users connect WorkDrive with read-only OAuth. We store only the refresh token,
 * encrypted in the key vault as provider "zoho_workdrive". Imported files are
 * copied into the instance knowledge base through the existing vectorizing path.
 */
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HttpError, requireUser } from "../lib/auth.js";
import {
	deleteConnectorGrant,
	listConnectorGrants,
	requireConnectorGrant,
	upsertConnectorGrant,
} from "../lib/connector-grants.js";
import { decryptKey, encryptKey } from "../lib/crypto.js";
import {
	exportWorkDriveFile,
	getWorkDriveFile,
	listWorkDriveFolder,
	mintWorkDriveAccessToken,
	WORKDRIVE_SCOPE,
	workDriveAccountsBase,
	workDriveFolderContainsFile,
	workDriveResourceIdFromUrl,
} from "../lib/workdrive.js";
import type { Env } from "../types.js";
import { requireOwnedInstance } from "./instances-runtime.js";

export const workdriveRoutes = new Hono<{ Bindings: Env }>();

const STATE_TTL_SECONDS = 10 * 60;
const PROVIDER = "zoho_workdrive";

function redirectUri(c: { req: { url: string } }): string {
	return new URL("/v1/workdrive/zoho/callback", c.req.url).toString();
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
		const { uid, exp } = JSON.parse(new TextDecoder().decode(unb64url(payload))) as {
			uid: string;
			exp: number;
		};
		if (typeof uid !== "string" || typeof exp !== "number") return null;
		if (exp < Math.floor(Date.now() / 1000)) return null;
		return uid;
	} catch {
		return null;
	}
}

async function storedRefreshToken(env: Env, userId: string): Promise<string> {
	if (!env.KEY_ENCRYPTION_KEY) throw new HttpError(500, "Key encryption not configured");
	const row = await env.DB.prepare(
		"SELECT key_ciphertext, dek_wrapped, iv FROM user_api_keys WHERE user_id = ?1 AND provider = ?2",
	)
		.bind(userId, PROVIDER)
		.first<{ key_ciphertext: ArrayBuffer; dek_wrapped: ArrayBuffer; iv: ArrayBuffer }>();
	if (!row) throw new HttpError(400, "Zoho WorkDrive is not connected");
	return decryptKey(
		new Uint8Array(row.key_ciphertext),
		new Uint8Array(row.dek_wrapped),
		new Uint8Array(row.iv),
		env.KEY_ENCRYPTION_KEY,
	);
}

workdriveRoutes.get("/zoho/start", async (c) => {
	const session = await requireUser(c);
	if (!c.env.ZOHO_CLIENT_ID || !c.env.ZOHO_CLIENT_SECRET) {
		throw new HttpError(503, "Zoho WorkDrive connection is not configured on this deployment");
	}
	const state = await signState(
		session.uid,
		Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
		c.env.SESSION_SIGNING_KEY,
	);
	const url = new URL(`${workDriveAccountsBase(c.env)}/oauth/v2/auth`);
	url.searchParams.set("client_id", c.env.ZOHO_CLIENT_ID);
	url.searchParams.set("redirect_uri", redirectUri(c));
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", WORKDRIVE_SCOPE);
	url.searchParams.set("access_type", "offline");
	url.searchParams.set("prompt", "consent");
	url.searchParams.set("state", state);
	return c.json({ url: url.toString() });
});

workdriveRoutes.get("/status", async (c) => {
	const session = await requireUser(c);
	const configured = !!(c.env.ZOHO_CLIENT_ID && c.env.ZOHO_CLIENT_SECRET);
	const row = await c.env.DB.prepare(
		"SELECT created_at, account_label FROM user_api_keys WHERE user_id = ?1 AND provider = ?2",
	)
		.bind(session.uid, PROVIDER)
		.first<{ created_at: string; account_label: string | null }>();
	return c.json({ connected: !!row, account: row?.account_label ?? null, connectedAt: row?.created_at ?? null, configured });
});

workdriveRoutes.delete("/zoho", async (c) => {
	const session = await requireUser(c);
	await c.env.DB.prepare(
		"DELETE FROM user_api_keys WHERE user_id = ?1 AND provider = ?2",
	)
		.bind(session.uid, PROVIDER)
		.run();
	return c.json({ success: true });
});

workdriveRoutes.get("/zoho/callback", async (c) => {
	const code = c.req.query("code");
	const stateRaw = c.req.query("state");
	if (!code || !stateRaw) return c.text("missing code or state", 400);
	if (!c.env.ZOHO_CLIENT_ID || !c.env.ZOHO_CLIENT_SECRET) {
		return c.text("Zoho WorkDrive connection is not configured", 503);
	}
	if (!c.env.KEY_ENCRYPTION_KEY) return c.text("Key encryption not configured", 500);

	const uid = await verifyState(stateRaw, c.env.SESSION_SIGNING_KEY);
	if (!uid) return c.text("invalid or expired state", 400);

	const tokenRes = await fetch(`${workDriveAccountsBase(c.env)}/oauth/v2/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: c.env.ZOHO_CLIENT_ID,
			client_secret: c.env.ZOHO_CLIENT_SECRET,
			code,
			redirect_uri: redirectUri(c),
			grant_type: "authorization_code",
		}),
	});
	if (!tokenRes.ok) return c.text(`Zoho WorkDrive token exchange failed (${tokenRes.status})`, 400);
	const tok = (await tokenRes.json()) as { refresh_token?: string };
	if (!tok.refresh_token) {
		return c.text(
			"Zoho did not return a refresh token. Revoke this app in Zoho Accounts and reconnect WorkDrive.",
			400,
		);
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
		.bind(uid, PROVIDER, ciphertext, dekWrapped, iv, "Zoho WorkDrive")
		.run();

	return c.html(
		"<!doctype html><title>Zoho WorkDrive connected</title><body style='font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0'><div style='text-align:center'><h1>Zoho WorkDrive connected</h1><p>You can close this tab and return to ProAgentStore.</p></div></body>",
	);
});

workdriveRoutes.get("/folder", async (c) => {
	const session = await requireUser(c);
	const folder = c.req.query("folder") || c.req.query("url") || "";
	if (!folder) throw new HttpError(400, "folder or url required");
	const limit = Number(c.req.query("limit")) || undefined;
	const offset = Number(c.req.query("offset")) || undefined;
	const refresh = await storedRefreshToken(c.env, session.uid);
	const accessToken = await mintWorkDriveAccessToken(c.env, refresh);
	return c.json(await listWorkDriveFolder(c.env, accessToken, folder, { limit, offset }));
});

workdriveRoutes.get("/instances/:instanceId/grants", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	return c.json({ grants: await listConnectorGrants(c.env, instanceId, session.uid, PROVIDER) });
});

workdriveRoutes.post("/instances/:instanceId/grants", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const body = (await c.req.json().catch(() => ({}))) as { resourceId?: string; url?: string; name?: string };
	const ref = body.resourceId || body.url;
	if (!ref) throw new HttpError(400, "resourceId or url required");
	const refresh = await storedRefreshToken(c.env, session.uid);
	const accessToken = await mintWorkDriveAccessToken(c.env, refresh);
	const fallbackId = workDriveResourceIdFromUrl(ref);
	if (!fallbackId) throw new HttpError(400, "resourceId or url required");
	const meta = await getWorkDriveFile(c.env, accessToken, ref).catch(() => ({
		id: fallbackId,
		name: body.name?.trim() || "Zoho WorkDrive folder",
		type: "folder",
		isFolder: true,
		permalink: typeof body.url === "string" ? body.url : undefined,
	}));
	if (!meta.isFolder) throw new HttpError(400, "Grant a Zoho WorkDrive folder. File grants are not supported yet.");
	const grant = await upsertConnectorGrant(c.env, instanceId, session.uid, {
		provider: PROVIDER,
		resourceId: meta.id,
		resourceName: (body.name?.trim() || meta.name || "Zoho WorkDrive folder").slice(0, 500),
		resourceType: "folder",
		resourceUrl: meta.permalink,
	});
	return c.json({ grant }, 201);
});

workdriveRoutes.delete("/instances/:instanceId/grants/:grantId", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	await deleteConnectorGrant(c.env, instanceId, session.uid, PROVIDER, c.req.param("grantId"));
	return c.json({ success: true });
});

workdriveRoutes.get("/instances/:instanceId/folder", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const grantId = c.req.query("grantId") || "";
	if (!grantId) throw new HttpError(400, "grantId required");
	const grant = await requireConnectorGrant(c.env, instanceId, session.uid, PROVIDER, grantId);
	const folder = c.req.query("folder") || grant.resourceId;
	if (folder !== grant.resourceId) {
		throw new HttpError(403, "Grant this WorkDrive folder before browsing it");
	}
	const limit = Number(c.req.query("limit")) || undefined;
	const offset = Number(c.req.query("offset")) || undefined;
	const refresh = await storedRefreshToken(c.env, session.uid);
	const accessToken = await mintWorkDriveAccessToken(c.env, refresh);
	return c.json({ ...await listWorkDriveFolder(c.env, accessToken, folder, { limit, offset }), grant });
});

workdriveRoutes.post("/instances/:instanceId/import", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const body = (await c.req.json().catch(() => ({}))) as { resourceId?: string; url?: string; title?: string; grantId?: string };
	const fileRef = body.resourceId || body.url;
	if (!fileRef) throw new HttpError(400, "resourceId or url required");
	if (!body.grantId) throw new HttpError(400, "grantId required");
	const resourceId = workDriveResourceIdFromUrl(fileRef);
	if (!resourceId) throw new HttpError(400, "resourceId or url required");

	const refresh = await storedRefreshToken(c.env, session.uid);
	const accessToken = await mintWorkDriveAccessToken(c.env, refresh);
	const grant = await requireConnectorGrant(c.env, instanceId, session.uid, PROVIDER, body.grantId);
	if (!await workDriveFolderContainsFile(c.env, accessToken, grant.resourceId, resourceId)) {
		throw new HttpError(403, "This agent has not been granted access to that WorkDrive file");
	}
	const file = await exportWorkDriveFile(c.env, accessToken, resourceId);
	const title = (body.title?.trim() || file.name || "Zoho WorkDrive import").slice(0, 500);
	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
	const doRes = await stub.fetch(
		new Request("https://agent/knowledge", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title,
				content: file.text,
				source: "workdrive",
				sourceUrl: file.permalink,
			}),
		}),
	);
	const payload = (await doRes.json()) as Record<string, unknown>;
	return c.json(
		{ ...payload, workdriveFile: { id: file.id, name: file.name, mimeType: file.mimeType, permalink: file.permalink } },
		(doRes.ok ? 201 : doRes.status) as ContentfulStatusCode,
	);
});
