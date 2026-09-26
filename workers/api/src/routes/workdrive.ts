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
import {
	exportWorkDriveFile,
	getWorkDriveFile,
	listWorkDriveFolder,
	mintWorkDriveAccessToken,
	workDriveFolderContainsFile,
	workDriveResourceIdFromUrl,
} from "../lib/workdrive.js";
import type { Env } from "../types.js";
import { requireOwnedInstance } from "./instances-runtime.js";

export const workdriveRoutes = new Hono<{ Bindings: Env }>();

const PROVIDER = "zoho_workdrive";

async function storedRefreshToken(env: Env, userId: string): Promise<string> {
	return readConnectorRefreshToken(env, userId, PROVIDER, "Zoho WorkDrive");
}

// #352 Stage 2 — the OAuth flow is the generic one (`lib/connector-oauth-flow.ts`). These two paths
// stay mounted as aliases, never as a second implementation: `/v1/workdrive/zoho/callback` is the redirect URI
// the provider's OAuth app has registered (the connector declares it as `redirectPath`), and the start
// path keeps any caller written before the console read `flow.start` from `GET /v1/connectors`.
workdriveRoutes.get("/zoho/start", (c) => startConnectorOauth(c, PROVIDER));
workdriveRoutes.get("/zoho/callback", (c) => completeConnectorOauth(c, PROVIDER));

workdriveRoutes.get("/status", async (c) => {
	const session = await requireUser(c);
	const configured = !!(c.env.ZOHO_CLIENT_ID && c.env.ZOHO_CLIENT_SECRET);
	const row = await c.env.DB.prepare(
		"SELECT created_at, account_label FROM user_api_keys WHERE user_id = ?1 AND provider = ?2",
	)
		.bind(session.uid, PROVIDER)
		.first<{ created_at: string; account_label: string | null }>();
	// What a disconnect would destroy, sent with the status so the confirmation can name it
	// before the click (#357). Same contract as /v1/drive/status.
	const reach = await connectorGrantReach(c.env, session.uid, PROVIDER);
	return c.json({
		connected: !!row,
		account: row?.account_label ?? null,
		connectedAt: row?.created_at ?? null,
		configured,
		reach,
	});
});

// Disconnect REVOKES every WorkDrive folder grant this user made, on every agent — see the
// matching handler in drive.ts for why keeping them was not defensible (#357).
workdriveRoutes.delete("/zoho", async (c) => {
	const session = await requireUser(c);
	const revoked = await revokeUserConnectorGrants(c.env, session.uid, PROVIDER);
	await c.env.DB.prepare(
		"DELETE FROM user_api_keys WHERE user_id = ?1 AND provider = ?2",
	)
		.bind(session.uid, PROVIDER)
		.run();
	return c.json({ success: true, revoked });
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
	const instance = await requireOwnedInstance(c.env, instanceId, session.uid);
	// #352, same gate as Drive and for the same reason — keyed on the connector's declared
	// `grantModel`, so it is one rule applied twice rather than two providers hardcoded twice.
	const refusal = await connectorRefusalFor(c.env, PROVIDER, instanceId, session.uid, instance.config);
	if (refusal) throw new HttpError(403, refusal);
	const body = (await c.req.json().catch(() => ({}))) as { resourceId?: string; url?: string; name?: string };
	const ref = body.resourceId || body.url;
	if (!ref) throw new HttpError(400, "resourceId or url required");
	const refresh = await storedRefreshToken(c.env, session.uid);
	const accessToken = await mintWorkDriveAccessToken(c.env, refresh);
	const fallbackId = workDriveResourceIdFromUrl(ref);
	if (!fallbackId) throw new HttpError(400, "resourceId or url required");
	const meta = await getWorkDriveFile(c.env, accessToken, ref).catch(() => null);
	if (!meta) throw new HttpError(502, "Couldn't verify that Zoho WorkDrive item. Check the link and try again.");
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
	const refresh = await storedRefreshToken(c.env, session.uid);
	const accessToken = await mintWorkDriveAccessToken(c.env, refresh);
	if (!await workDriveFolderContainsFile(c.env, accessToken, grant.resourceId, folder)) {
		throw new HttpError(403, "Grant this WorkDrive folder before browsing it");
	}
	const limit = Number(c.req.query("limit")) || undefined;
	const offset = Number(c.req.query("offset")) || undefined;
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
