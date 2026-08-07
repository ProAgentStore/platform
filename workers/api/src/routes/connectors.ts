// Generic connector OAuth2 (issue #147). ONE authorize/callback flow for every oauth
// connector, driven by the connector's manifest `oauth` config (authUrl/tokenUrl/scopes +
// the env-var names for the client credentials) instead of a hand-rolled per-provider route
// (drive.ts remains its own for Drive-specific userinfo labeling). Adding an OAuth SaaS is
// then a manifest + an OAuth app registration pointing its redirect at
// `/v1/connectors/<id>/oauth/callback` — no bespoke route code.
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { CONNECTORS, getConnector } from "../lib/connectors/registry.js";
import { resolveOauthConfig } from "../lib/connectors/client.js";
import { connectorGrantReach, connectorGrantReachByProvider, revokeUserConnectorGrants } from "../lib/connector-grants.js";
import { unattendedClassOf } from "../lib/connectors/unattended.js";
import type { Connector } from "../lib/connectors/types.js";
import { signConnectorState, verifyConnectorState, saveConnectorRefreshToken } from "../lib/connector-oauth.js";
import { clearOauthBindCookie, newOauthNonce, oauthBindCookie, readOauthBindCookie, OAUTH_BIND_ERROR } from "../lib/oauth-nonce.js";
import type { Env } from "../types.js";

export const connectorRoutes = new Hono<{ Bindings: Env }>();

const STATE_TTL_SECONDS = 600;

function callbackUri(reqUrl: string, id: string): string {
	return new URL(`/v1/connectors/${encodeURIComponent(id)}/oauth/callback`, reqUrl).toString();
}

/** Resolve a connector that is oauth-auth AND has credentials wired, or throw a clear error. */
function requireOauthConnector(env: Env, id: string) {
	const connector = getConnector(id);
	if (connector?.auth !== "oauth" || !connector.oauth) {
		throw new HttpError(404, `No OAuth connector "${id}".`);
	}
	const creds = resolveOauthConfig(env, id);
	if (!creds.clientId || !creds.clientSecret || !creds.tokenUrl) {
		throw new HttpError(503, `The ${id} connector's OAuth credentials are not configured on this deployment.`);
	}
	return { connector, creds };
}

/**
 * Is this connector usable ON THIS DEPLOYMENT at all? Distinct from "the caller connected it" —
 * the same distinction #353 had to draw in the console, where an unconfigured connector was
 * rendered as the owner's error.
 */
function isConfigured(env: Env, connector: Connector): boolean {
	const e = env as unknown as Record<string, string | undefined>;
	// A connector that names its credential env vars is judged on those — the only way to answer
	// for one whose OAuth endpoints are not manifest-expressible (Zoho WorkDrive). See types.ts.
	if (connector.credentialEnv?.length) return connector.credentialEnv.every((k) => !!e[k]?.trim());
	switch (connector.auth) {
		case "oauth": {
			const creds = resolveOauthConfig(env, connector.id);
			return !!(creds.clientId && creds.clientSecret && creds.tokenUrl);
		}
		// A platform-token connector needs its env var; a vault-backed one is configured by
		// definition (the credential is the user's to supply).
		case "token":
			return connector.tokenEnv ? !!env[connector.tokenEnv]?.trim() : true;
		case "app":
			return !!(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY);
		case "none":
			return true;
	}
}

/**
 * Which connect/disconnect flow is LIVE for a connector today (#355).
 *
 * Three of them predate the generic OAuth routes and keep their own, because their OAuth apps
 * register `/v1/{drive,email}/google/callback` — not `/v1/connectors/<id>/oauth/callback` — so
 * the generic authorize URL would be rejected at the provider (see connected-accounts.ts).
 *
 * This lives on the server rather than in the console because the console is the FOURTH consumer
 * to need it, and the previous three each hardcoded their own copy. That is the arrangement this
 * whole route exists to end: the account page renders whatever the catalog says, so an owner sees
 * a new connector without a console change, and #352 Stage 2 retires a dedicated flow by deleting
 * one line here rather than by hunting for the buttons that point at it.
 */
const DEDICATED_FLOWS: Record<string, { start: string; disconnect: string }> = {
	google_drive: { start: "/v1/drive/google/start", disconnect: "/v1/drive/google" },
	zoho_workdrive: { start: "/v1/workdrive/zoho/start", disconnect: "/v1/workdrive/zoho" },
	gmail: { start: "/v1/email/google/start", disconnect: "/v1/email/google" },
};

/** The endpoints a UI should call to connect/disconnect, or null when there is nothing to call. */
function connectFlow(connector: Connector): { start: string; disconnect: string } | null {
	const dedicated = DEDICATED_FLOWS[connector.id];
	if (dedicated) return dedicated;
	// The generic flow can only be offered to a connector whose manifest declares where to send
	// the browser. Anything else has no connect step a caller could take.
	if (connector.auth !== "oauth" || !connector.oauth) return null;
	const id = encodeURIComponent(connector.id);
	return { start: `/v1/connectors/${id}/oauth/start`, disconnect: `/v1/connectors/${id}/oauth` };
}

/**
 * GET /v1/connectors — the catalog, resolved for the caller (#352 Stage 1).
 *
 * The registry has been the single source of truth for connectors since #86, but nothing could
 * READ it from outside the Worker, so every consumer that needed "which connectors exist and is
 * this one connected" wrote its own list: two route files, three hand-written console blocks, an
 * MCP `PROVIDERS` map plus a matching Zod enum, and the `sync_connector` trigger branch. Five
 * copies, each a place a sixth connector has to be remembered. This is the one answer they can
 * all derive from — the next consumer is a `.map()`.
 *
 * `connected` is one indexed read over `user_api_keys` for the whole catalog rather than one per
 * connector, because the list is short and the round trips are not. `reach` is the same trick
 * over `instance_connector_grants`: the account page states what a disconnect would revoke BEFORE
 * the click (#355/#357), and it has to state it for every row, not the one being confirmed.
 */
connectorRoutes.get("/", async (c) => {
	const session = await requireUser(c);
	const [rows, reachByProvider] = await Promise.all([
		c.env.DB.prepare("SELECT provider, created_at, account_label FROM user_api_keys WHERE user_id = ?1")
			.bind(session.uid)
			.all<{ provider: string; created_at: string; account_label: string | null }>(),
		connectorGrantReachByProvider(c.env, session.uid),
	]);
	const stored = new Map((rows.results ?? []).map((r) => [r.provider, r]));
	return c.json({
		connectors: CONNECTORS.map((connector) => {
			const row = stored.get(connector.id);
			// Only a connector that HOLDS a credential can be "connected". A relay/no-auth one has
			// nothing to connect, and reporting `connected:false` for it would read as a gap.
			const holdsCredential = connector.auth === "oauth" || (connector.auth === "token" && !connector.tokenEnv);
			return {
				id: connector.id,
				label: connector.label,
				auth: connector.auth,
				scopes: connector.scopes,
				grantModel: connector.grantModel,
				unattended: unattendedClassOf(connector),
				tools: connector.tools.map((t) => t.name),
				configured: isConfigured(c.env, connector),
				connected: holdsCredential ? !!row : null,
				account: row?.account_label ?? null,
				connectedAt: row?.created_at ?? null,
				// Only meaningful where a grant IS the reach. A `user`-model connector has no grants
				// to count, and `{grants:0}` on it would read as "nothing uses this" rather than
				// "this is not how its reach works".
				reach: connector.grantModel === "instance-resource"
					? (reachByProvider.get(connector.id) ?? { grants: 0, instances: 0 })
					: null,
				flow: connectFlow(connector),
			};
		}),
	});
});

/** GET /v1/connectors/:id/oauth/start — return the provider authorize URL (signed state). */
connectorRoutes.get("/:id/oauth/start", async (c) => {
	const session = await requireUser(c);
	const id = c.req.param("id");
	const { connector, creds } = requireOauthConnector(c.env, id);

	// Bind the state to THIS browser and to THIS connector — a signed state is otherwise
	// bearer-grade, so an attacker's link completed by a victim stores the VICTIM's refresh
	// token under the ATTACKER's account. See lib/oauth-nonce.ts.
	const bindNonce = newOauthNonce();
	const state = await signConnectorState(
		session.uid,
		Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
		c.env.SESSION_SIGNING_KEY,
		{ nonce: bindNonce, provider: id },
	);
	c.header("Set-Cookie", oauthBindCookie(bindNonce, id));
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
	const uid = await verifyConnectorState(stateRaw, c.env.SESSION_SIGNING_KEY, {
		cookieNonce: readOauthBindCookie(c.req.header("cookie"), id),
		provider: id,
	});
	c.header("Set-Cookie", clearOauthBindCookie(id)); // single-use, whatever the outcome
	if (!uid) return c.text(OAUTH_BIND_ERROR, 400);

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
	if (connector?.auth !== "oauth") throw new HttpError(404, `No OAuth connector "${id}".`);
	const creds = resolveOauthConfig(c.env, id);
	const row = await c.env.DB.prepare("SELECT created_at, account_label FROM user_api_keys WHERE user_id = ?1 AND provider = ?2")
		.bind(session.uid, id)
		.first<{ created_at: string; account_label: string | null }>();
	// Grant-holding connectors report what a disconnect would revoke, the same contract
	// /v1/{drive,workdrive}/status carry (#357) — so a caller can state it before confirming.
	const reach = connector.grantModel === "instance-resource"
		? await connectorGrantReach(c.env, session.uid, id)
		: undefined;
	return c.json({
		connected: !!row,
		account: row?.account_label ?? null,
		connectedAt: row?.created_at ?? null,
		configured: !!(creds.clientId && creds.clientSecret),
		...(reach ? { reach } : {}),
	});
});

/**
 * DELETE /v1/connectors/:id/oauth — disconnect: drop the stored refresh token AND, for a
 * connector whose reach is per-instance grants, those grants.
 *
 * Declaring Drive/WorkDrive (#352 Stage 1) makes this route a SECOND way to disconnect them, so
 * without the cascade it would have quietly re-opened #357 through a different door: token gone,
 * grants standing, restored by the next reconnect. A permission rule that only holds on one of
 * two paths is not a rule.
 */
connectorRoutes.delete("/:id/oauth", async (c) => {
	const session = await requireUser(c);
	const id = c.req.param("id");
	const connector = getConnector(id);
	const revoked = connector?.grantModel === "instance-resource"
		? await revokeUserConnectorGrants(c.env, session.uid, id)
		: undefined;
	await c.env.DB.prepare("DELETE FROM user_api_keys WHERE user_id = ?1 AND provider = ?2").bind(session.uid, id).run();
	return c.json({ success: true, ...(revoked ? { revoked } : {}) });
});
