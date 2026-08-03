// Generic connector OAuth2 (issue #147). ONE authorize/callback flow for every oauth
// connector, driven by the connector's manifest `oauth` config (authUrl/tokenUrl/scopes +
// the env-var names for the client credentials) instead of a hand-rolled per-provider route
// (drive.ts remains its own for Drive-specific userinfo labeling). Adding an OAuth SaaS is
// then a manifest + an OAuth app registration pointing its redirect at
// `/v1/connectors/<id>/oauth/callback` — no bespoke route code.
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { getConnector } from "../lib/connectors/registry.js";
import { resolveOauthConfig } from "../lib/connectors/client.js";
import { signConnectorState, verifyConnectorState, saveConnectorRefreshToken } from "../lib/connector-oauth.js";
import type { Env } from "../types.js";

export const connectorRoutes = new Hono<{ Bindings: Env }>();

const STATE_TTL_SECONDS = 600;

function callbackUri(reqUrl: string, id: string): string {
	return new URL(`/v1/connectors/${encodeURIComponent(id)}/oauth/callback`, reqUrl).toString();
}

/** Resolve a connector that is oauth-auth AND has credentials wired, or throw a clear error. */
function requireOauthConnector(env: Env, id: string) {
	const connector = getConnector(id);
	if (!connector || connector.auth !== "oauth" || !connector.oauth) {
		throw new HttpError(404, `No OAuth connector "${id}".`);
	}
	const creds = resolveOauthConfig(env, id);
	if (!creds.clientId || !creds.clientSecret || !creds.tokenUrl) {
		throw new HttpError(503, `The ${id} connector's OAuth credentials are not configured on this deployment.`);
	}
	return { connector, creds };
}

/** GET /v1/connectors/:id/oauth/start — return the provider authorize URL (signed state). */
connectorRoutes.get("/:id/oauth/start", async (c) => {
	const session = await requireUser(c);
	const id = c.req.param("id");
	const { connector, creds } = requireOauthConnector(c.env, id);

	const state = await signConnectorState(
		session.uid,
		Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
		c.env.SESSION_SIGNING_KEY,
	);
	const url = new URL(connector.oauth!.authUrl);
	url.searchParams.set("client_id", creds.clientId!);
	url.searchParams.set("redirect_uri", callbackUri(c.req.url, id));
	url.searchParams.set("response_type", "code");
	if (connector.oauth!.scopes?.length) url.searchParams.set("scope", connector.oauth!.scopes.join(" "));
	// Ask for a durable refresh token (Google/most providers honor these; harmless elsewhere).
	url.searchParams.set("access_type", "offline");
	url.searchParams.set("prompt", "consent");
	url.searchParams.set("state", state);
	return c.json({ url: url.toString() });
});

/** GET /v1/connectors/:id/oauth/callback — exchange the code, store the refresh token. */
connectorRoutes.get("/:id/oauth/callback", async (c) => {
	const id = c.req.param("id");
	const code = c.req.query("code");
	const stateRaw = c.req.query("state");
	if (!code || !stateRaw) return c.text("missing code or state", 400);
	if (!c.env.KEY_ENCRYPTION_KEY) return c.text("Key encryption not configured", 500);

	const { creds } = requireOauthConnector(c.env, id);
	const uid = await verifyConnectorState(stateRaw, c.env.SESSION_SIGNING_KEY);
	if (!uid) return c.text("invalid or expired state", 400);

	const tokenRes = await fetch(creds.tokenUrl!, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams({
			client_id: creds.clientId!,
			client_secret: creds.clientSecret!,
			code,
			redirect_uri: callbackUri(c.req.url, id),
			grant_type: "authorization_code",
		}),
	});
	if (!tokenRes.ok) return c.text(`${id} token exchange failed (${tokenRes.status})`, 400);
	const tok = (await tokenRes.json()) as { refresh_token?: string; access_token?: string };
	if (!tok.refresh_token) {
		return c.text(`${id} did not return a refresh token — reconnect and grant offline access.`, 400);
	}

	await saveConnectorRefreshToken(c.env, { userId: uid, provider: id, refreshToken: tok.refresh_token });

	return c.html(
		`<!doctype html><title>${id} connected</title><body style='font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0'><div style='text-align:center'><h1>Connected</h1><p>You can close this tab and return to ProAgentStore.</p></div></body>`,
	);
});

/** GET /v1/connectors/:id/oauth/status — is this oauth connector connected for the caller? */
connectorRoutes.get("/:id/oauth/status", async (c) => {
	const session = await requireUser(c);
	const id = c.req.param("id");
	const connector = getConnector(id);
	if (!connector || connector.auth !== "oauth") throw new HttpError(404, `No OAuth connector "${id}".`);
	const creds = resolveOauthConfig(c.env, id);
	const row = await c.env.DB.prepare("SELECT created_at FROM user_api_keys WHERE user_id = ?1 AND provider = ?2")
		.bind(session.uid, id)
		.first<{ created_at: string }>();
	return c.json({ connected: !!row, connectedAt: row?.created_at ?? null, configured: !!(creds.clientId && creds.clientSecret) });
});

/** DELETE /v1/connectors/:id/oauth — disconnect (drop the stored refresh token). */
connectorRoutes.delete("/:id/oauth", async (c) => {
	const session = await requireUser(c);
	const id = c.req.param("id");
	await c.env.DB.prepare("DELETE FROM user_api_keys WHERE user_id = ?1 AND provider = ?2").bind(session.uid, id).run();
	return c.json({ success: true });
});
