/**
 * Outbound-MCP authorization (#180, #258) and the first-party preset (#287).
 *
 * WHAT THIS ADDS. Until now the only way to reach an authenticated MCP server was for the user to
 * paste a bearer token — the one thing modern MCP servers document as "do not do", because they
 * are OAuth public clients with no token a human can copy. These routes complete the flow those
 * servers actually implement: discover (RFC 9728 → RFC 8414), register ourselves at runtime
 * (RFC 7591), authorize with PKCE S256, and store the result as this endpoint's credential.
 *
 * ACCOUNT-SCOPED, NOT INSTANCE-SCOPED. A credential belongs to the account and a callback is a
 * bare navigation that cannot carry an instance id, so these live at `/v1/mcp/*` rather than under
 * `/v1/instances/:id`. Authorizing a server is NOT consent to its tools: #262's per-(instance,
 * endpoint, tool) grants are untouched by anything here, and a freshly authorized server can still
 * call nothing until the owner ticks tools in the console.
 *
 * Every outbound hop — metadata discovery, registration, token exchange, refresh — goes through
 * `safeFetch` (https-only, redirect-revalidated, private/metadata addresses refused), because the
 * endpoint is user-supplied config and an authenticated "connect this URL" button is otherwise a
 * textbook SSRF primitive.
 */
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { discoverAuthServer } from "../lib/connectors/discovery.js";
import { normalizeMcpEndpoint } from "../lib/mcp-consent.js";
import { buildAuthorizeUrl, codeChallengeS256, newCodeVerifier, signMcpOauthState, verifyMcpOauthState, FLOW_TTL_SECONDS, MCP_OAUTH_COOKIE_SCOPE } from "../lib/mcp-oauth.js";
import { claimFlow, completeFlow, getOrRegisterClient, purgeExpiredFlows, saveFlow } from "../lib/mcp-oauth-store.js";
import { clearOauthBindCookie, newOauthNonce, oauthBindCookie, readOauthBindCookie, OAUTH_BIND_ERROR } from "../lib/oauth-nonce.js";
import { firstPartyMcpPresets } from "../lib/mcp-presets.js";
import type { Env } from "../types.js";

export const mcpRoutes = new Hono<{ Bindings: Env }>();

const CALLBACK_PATH = "/v1/mcp/oauth/callback";

function callbackUri(reqUrl: string): string {
	return new URL(CALLBACK_PATH, reqUrl).toString();
}

/** Same-origin trailing-slash-insensitive comparison for issuer validation. */
function sameIssuer(a: string, b: string): boolean {
	return a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();
}

/** A minimal end-of-flow page. No user data, no script, and never the code or the state. */
function resultPage(title: string, message: string): string {
	const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);
	return `<!doctype html><title>${esc(title)}</title><body style='font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0'><div style='text-align:center;max-width:32rem;padding:1rem'><h1 style='font-size:1.25rem'>${esc(title)}</h1><p style='color:#555;line-height:1.5'>${esc(message)}</p></div></body>`;
}

/**
 * GET /v1/mcp/presets — first-party MCP servers this deployment knows about (#287).
 *
 * Environment-derived (`MCP_SELF_URL`), never a literal in the connector: `lib/connectors/mcp.ts`
 * deliberately contains no host at all, so that PAGS stays self-contained and a configured server
 * remains user DATA. A deployment that does not set the var simply offers no preset, which is what
 * keeps production out of a local build.
 *
 * A preset is a PREFILLED URL and nothing more. It carries no credential, grants no tool, and
 * skips no gate — the endpoint it names goes through the same test, the same per-tool consent and
 * the same authorization flow as one the user typed. "We wrote this server" is not a permission.
 */
mcpRoutes.get("/presets", async (c) => {
	await requireUser(c);
	return c.json({ presets: firstPartyMcpPresets(c.env) });
});

/**
 * POST /v1/mcp/oauth/start { url, scope? } — begin authorization for one MCP endpoint.
 *
 * Returns the provider's authorize URL for the console to open. Refuses, with a reason, every
 * server this flow cannot honestly serve: one that publishes no OAuth metadata (paste a token
 * instead), one that will not register a client at runtime (nobody can pre-register for a URL the
 * operator has never seen), and one that does not offer PKCE S256 — for which there is deliberately
 * no `plain` fallback, since a plain challenge equals its verifier and protects nothing.
 */
mcpRoutes.post("/oauth/start", async (c) => {
	const session = await requireUser(c);
	if (!c.env.KEY_ENCRYPTION_KEY) throw new HttpError(500, "Key encryption not configured");
	const body = (await c.req.json().catch(() => ({}))) as { url?: string; scope?: string };

	// Normalize FIRST: the credential must land under the same key consent, the trace and the
	// connector all use, or the flow would succeed and the agent would still report "no credential".
	const endpoint = normalizeMcpEndpoint(String(body.url ?? ""));
	if (!endpoint) throw new HttpError(400, "`url` must be an https MCP endpoint, e.g. https://example.com/mcp.");
	const scope = body.scope ? String(body.scope).trim().slice(0, 200) : null;

	const discovery = await discoverAuthServer(endpoint);
	if (!discovery.protected) {
		throw new HttpError(400, "That server publishes no OAuth metadata, so there is no authorization flow to start. Store an access token for it instead, or use it as an open server.");
	}
	const { metadata } = discovery;
	// RFC 8414 issuer validation. A metadata document whose `issuer` is not the server we fetched
	// it from is the classic mix-up: it points our authorize and token requests at a third party
	// while the user believes they are connecting the server they named.
	if (metadata.issuer && !sameIssuer(metadata.issuer, discovery.authorizationServer)) {
		throw new HttpError(400, "That server's authorization metadata names a different issuer than the server it was published by, so it cannot be trusted.");
	}
	if (!metadata.authorizationEndpoint || !metadata.tokenEndpoint) {
		throw new HttpError(400, "That server's authorization metadata is incomplete (no authorization or token endpoint).");
	}
	if (!discovery.pkceS256) {
		throw new HttpError(400, "That authorization server does not support PKCE S256. ProAgentStore will not authorize as a public client without it.");
	}

	const redirectUri = callbackUri(c.req.url);
	let client: Awaited<ReturnType<typeof getOrRegisterClient>>;
	try {
		client = await getOrRegisterClient(c.env, session.uid, discovery.authorizationServer, metadata.registrationEndpoint, redirectUri, scope);
	} catch (e) {
		throw new HttpError(400, e instanceof Error ? e.message : "Could not register with that authorization server.");
	}

	const verifier = newCodeVerifier();
	const flowId = crypto.randomUUID();
	await saveFlow(c.env, {
		id: flowId,
		userId: session.uid,
		endpoint,
		issuer: discovery.authorizationServer,
		tokenEndpoint: metadata.tokenEndpoint,
		clientId: client.clientId,
		redirectUri,
		scope,
		verifier,
	});
	// Opportunistic cleanup — a flow nobody finished is an encrypted row with no owner watching it.
	await purgeExpiredFlows(c.env);

	// The browser binding (lib/oauth-nonce.ts) plus the resource + flow pins (lib/mcp-oauth.ts).
	// A signed state that proves only "this user started SOME MCP flow" is replayable across
	// servers by anyone who operates one the user connects.
	const bindNonce = newOauthNonce();
	const state = await signMcpOauthState(
		{ uid: session.uid, flowId, resource: endpoint },
		Math.floor(Date.now() / 1000) + FLOW_TTL_SECONDS,
		c.env.SESSION_SIGNING_KEY,
		bindNonce,
	);
	c.header("Set-Cookie", oauthBindCookie(bindNonce, MCP_OAUTH_COOKIE_SCOPE));

	return c.json({
		url: buildAuthorizeUrl({
			authorizationEndpoint: metadata.authorizationEndpoint,
			clientId: client.clientId,
			redirectUri,
			codeChallenge: await codeChallengeS256(verifier),
			state,
			scope,
			resource: endpoint,
		}),
		endpoint,
		issuer: discovery.authorizationServer,
		// #181's verdict, surfaced at the moment the user decides to wire this server into a chain:
		// "interactive-only" means the credential dies and cannot be renewed with nobody present.
		unattended: discovery.unattended,
		expiresIn: FLOW_TTL_SECONDS,
	});
});

/**
 * GET /v1/mcp/oauth/callback — finish the flow.
 *
 * Unauthenticated by construction: this is a top-level navigation arriving from a server we do not
 * control, and the `state` is the only evidence about who to credit. Everything the exchange needs
 * is read from the claimed flow row — token endpoint, client id, redirect uri, PKCE verifier,
 * resource — and NOTHING but `code` is read from this request's query string, so a caller cannot
 * steer the exchange at a server of their choosing.
 */
mcpRoutes.get("/oauth/callback", async (c) => {
	const err = c.req.query("error");
	if (err) {
		c.header("Set-Cookie", clearOauthBindCookie(MCP_OAUTH_COOKIE_SCOPE));
		return c.html(resultPage("Authorization cancelled", `The server reported: ${String(err).slice(0, 120)}. Nothing was stored. You can close this tab and try again.`), 400);
	}
	const code = c.req.query("code");
	const stateRaw = c.req.query("state");
	if (!code || !stateRaw) return c.html(resultPage("Missing details", "That callback carried no authorization code. Start the connection again from your console."), 400);
	if (!c.env.KEY_ENCRYPTION_KEY) return c.html(resultPage("Not configured", "Key encryption is not configured on this deployment."), 500);

	const claims = await verifyMcpOauthState(stateRaw, c.env.SESSION_SIGNING_KEY, readOauthBindCookie(c.req.header("cookie"), MCP_OAUTH_COOKIE_SCOPE));
	// Single-use, whatever the outcome — a nonce that survives a failure is a nonce an attacker
	// gets to retry against.
	c.header("Set-Cookie", clearOauthBindCookie(MCP_OAUTH_COOKIE_SCOPE));
	if (!claims) return c.html(resultPage("Could not verify this link", OAUTH_BIND_ERROR), 400);

	const flow = await claimFlow(c.env, claims.flowId, claims.uid);
	if (!flow) return c.html(resultPage("This link has expired", "That authorization was already completed or has timed out. Start the connection again from your console."), 400);
	// The resource pin. The state and the flow row must agree on WHICH server this is for, so a
	// state minted for one server can never complete a flow — or write a credential — for another.
	if (flow.endpoint !== claims.resource) {
		return c.html(resultPage("Could not verify this link", "That authorization was started for a different server. Nothing was stored."), 400);
	}

	try {
		await completeFlow(c.env, flow, code);
	} catch (e) {
		return c.html(resultPage("Authorization failed", e instanceof Error ? e.message : "The token exchange was refused."), 400);
	}
	return c.html(resultPage("Connected", `ProAgentStore is now authorized with ${flow.endpoint}. You can close this tab — the agent still needs you to allow specific tools on that server before it can call anything.`));
});
