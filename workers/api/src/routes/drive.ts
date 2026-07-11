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
import {
	DRIVE_SCOPE,
	driveFileDescendsFrom,
	exportDriveFile,
	getDriveFileMetadata,
	isDriveFolder,
	listDriveFolderFiles,
	listDriveFiles,
	mintDriveAccessToken,
} from "../lib/drive.js";
import {
	deleteConnectorGrant,
	listConnectorGrants,
	requireConnectorGrant,
	upsertConnectorGrant,
} from "../lib/connector-grants.js";
import {
	readConnectorRefreshToken,
	saveConnectorRefreshToken,
	signConnectorState,
	verifyConnectorState,
} from "../lib/connector-oauth.js";
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

async function storedRefreshToken(env: Env, userId: string): Promise<string> {
	return readConnectorRefreshToken(env, userId, PROVIDER, "Google Drive");
}

driveRoutes.get("/google/start", async (c) => {
	const session = await requireUser(c);
	if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
		throw new HttpError(503, "Google Drive connection is not configured on this deployment");
	}
	const state = await signConnectorState(
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

	const uid = await verifyConnectorState(stateRaw, c.env.SESSION_SIGNING_KEY);
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

	await saveConnectorRefreshToken(c.env, {
		userId: uid,
		provider: PROVIDER,
		refreshToken: tok.refresh_token,
		accountLabel,
	});

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

driveRoutes.get("/instances/:instanceId/grants", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	return c.json({ grants: await listConnectorGrants(c.env, instanceId, session.uid, PROVIDER) });
});

driveRoutes.post("/instances/:instanceId/grants", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const body = (await c.req.json().catch(() => ({}))) as { resourceId?: string; url?: string; name?: string };
	const ref = body.resourceId || body.url;
	if (!ref) throw new HttpError(400, "resourceId or url required");
	const refresh = await storedRefreshToken(c.env, session.uid);
	const accessToken = await mintDriveAccessToken(c.env, refresh);
	const meta = await getDriveFileMetadata(accessToken, ref);
	if (!isDriveFolder(meta)) throw new HttpError(400, "Grant a Google Drive folder. File grants are not supported yet.");
	const grant = await upsertConnectorGrant(c.env, instanceId, session.uid, {
		provider: PROVIDER,
		resourceId: meta.id,
		resourceName: (body.name?.trim() || meta.name || "Google Drive folder").slice(0, 500),
		resourceType: "folder",
		resourceUrl: meta.webViewLink,
	});
	return c.json({ grant }, 201);
});

driveRoutes.delete("/instances/:instanceId/grants/:grantId", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	await deleteConnectorGrant(c.env, instanceId, session.uid, PROVIDER, c.req.param("grantId"));
	return c.json({ success: true });
});

driveRoutes.get("/instances/:instanceId/files", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const grantId = c.req.query("grantId") || "";
	if (!grantId) throw new HttpError(400, "grantId required");
	const grant = await requireConnectorGrant(c.env, instanceId, session.uid, PROVIDER, grantId);
	const refresh = await storedRefreshToken(c.env, session.uid);
	const accessToken = await mintDriveAccessToken(c.env, refresh);
	const folder = c.req.query("folder") || grant.resourceId;
	if (!await driveFileDescendsFrom(accessToken, folder, grant.resourceId)) {
		throw new HttpError(403, "This agent has not been granted access to that Drive folder");
	}
	const query = c.req.query("q") || undefined;
	const limit = Number(c.req.query("limit")) || 50;
	return c.json({ files: await listDriveFolderFiles(accessToken, folder, { query, pageSize: limit }), grant, folder });
});

driveRoutes.post("/instances/:instanceId/import", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const body = (await c.req.json().catch(() => ({}))) as { fileId?: string; url?: string; title?: string; grantId?: string };
	const fileRef = body.fileId || body.url;
	if (!fileRef) throw new HttpError(400, "fileId or url required");
	if (!body.grantId) throw new HttpError(400, "grantId required");

	const refresh = await storedRefreshToken(c.env, session.uid);
	const accessToken = await mintDriveAccessToken(c.env, refresh);
	const grant = await requireConnectorGrant(c.env, instanceId, session.uid, PROVIDER, body.grantId);
	if (!await driveFileDescendsFrom(accessToken, fileRef, grant.resourceId)) {
		throw new HttpError(403, "This agent has not been granted access to that Drive file");
	}
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
