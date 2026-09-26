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
	driveFileDescendsFrom,
	exportDriveFile,
	getDriveFileMetadata,
	isDriveFolder,
	listDriveFolderFiles,
	listDriveFiles,
	mintDriveAccessToken,
} from "../lib/drive.js";
import {
	connectorGrantReach,
	deleteConnectorGrant,
	listConnectorGrants,
	requireConnectorGrant,
	revokeUserConnectorGrants,
	upsertConnectorGrant,
} from "../lib/connector-grants.js";
import { readConnectorRefreshToken } from "../lib/connector-oauth.js";
import { completeConnectorOauth, startConnectorOauth } from "../lib/connector-oauth-flow.js";
import { connectorRefusalFor } from "../lib/instance-connector-access.js";
import type { Env } from "../types.js";
import { requireOwnedInstance } from "./instances-runtime.js";

export const driveRoutes = new Hono<{ Bindings: Env }>();

const PROVIDER = "google_drive";

async function storedRefreshToken(env: Env, userId: string): Promise<string> {
	return readConnectorRefreshToken(env, userId, PROVIDER, "Google Drive");
}

// #352 Stage 2 — the OAuth flow is the generic one (`lib/connector-oauth-flow.ts`). These two paths
// stay mounted as aliases, never as a second implementation: `/v1/drive/google/callback` is the redirect URI
// the provider's OAuth app has registered (the connector declares it as `redirectPath`), and the start
// path keeps any caller written before the console read `flow.start` from `GET /v1/connectors`.
driveRoutes.get("/google/start", (c) => startConnectorOauth(c, PROVIDER));
driveRoutes.get("/google/callback", (c) => completeConnectorOauth(c, PROVIDER));

driveRoutes.get("/status", async (c) => {
	const session = await requireUser(c);
	const configured = !!(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET);
	const row = await c.env.DB.prepare(
		"SELECT created_at, account_label FROM user_api_keys WHERE user_id = ?1 AND provider = ?2",
	)
		.bind(session.uid, PROVIDER)
		.first<{ created_at: string; account_label: string | null }>();
	// `reach` is what a disconnect would destroy (#357). Sent with the status so the
	// confirmation can name it BEFORE the click, rather than the console discovering it
	// afterwards — a permission surface has to state its own blast radius.
	const reach = await connectorGrantReach(c.env, session.uid, PROVIDER);
	return c.json({
		connected: !!row,
		email: row?.account_label ?? null,
		connectedAt: row?.created_at ?? null,
		configured,
		reach,
	});
});

// Disconnect REVOKES: the token row and every folder grant this user made for Drive, on
// every agent. Grants used to survive, invisibly, and a reconnect silently re-armed all of
// them (#357). Grants go first: if the token delete then failed we would have over-revoked,
// which is the direction a permission bug should fail in.
driveRoutes.delete("/google", async (c) => {
	const session = await requireUser(c);
	const revoked = await revokeUserConnectorGrants(c.env, session.uid, PROVIDER);
	await c.env.DB.prepare(
		"DELETE FROM user_api_keys WHERE user_id = ?1 AND provider = ?2",
	)
		.bind(session.uid, PROVIDER)
		.run();
	return c.json({ success: true, revoked });
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
	const instance = await requireOwnedInstance(c.env, instanceId, session.uid);
	// #352: the grant IS the permission, so this is the door where "may THIS agent use a file
	// connector" has to be answered. The console already stops offering the panel to an agent that
	// cannot read a document; without this the same grant was one MCP tool call away, which is a
	// picker-only fix on a surface with three doors. Refused BEFORE the Drive round trip, because
	// a refusal about the agent should not depend on a working Drive connection.
	const refusal = await connectorRefusalFor(c.env, PROVIDER, instanceId, session.uid, instance.config);
	if (refusal) throw new HttpError(403, refusal);
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
