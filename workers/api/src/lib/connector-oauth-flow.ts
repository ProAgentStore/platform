/**
 * The ONE connector OAuth flow (#147, completed by #352 Stage 2).
 *
 * Google Drive, Zoho WorkDrive and Gmail each had a dedicated start/callback pair that was the
 * generic flow copied by hand, plus the few things the generic one lacked. Those things are now
 * DECLARED on the connector (`Connector.oauth` — `redirectPath`, `endpointsFromEnv`, `identity`,
 * `optionalGrants`) and done here, once:
 *
 *   - the account's IDENTITY — the Google address read from userinfo, or a fixed label — and whether
 *     each account is its own row (Gmail's mailboxes, #715) or the connection is the single row;
 *   - the owner's CHOSEN powers (#718): `?grant=` adds a declared optional grant, an undeclared one
 *     is refused, `include_granted_scopes` keeps what the client already held, `?account=` becomes
 *     `login_hint`, and the recorded grant is MERGED, never narrowed;
 *   - per-deployment ENDPOINTS (Zoho's data-centre);
 *   - the REGISTERED redirect: the authorize URL, the token exchange and the route that receives the
 *     browser all name the connector's declared `redirectPath`, so a connector whose OAuth app has a
 *     legacy path registered keeps working with no provider-dashboard change.
 *
 * Security is unchanged and in one place: the state is signed, expires, is pinned to the connector
 * it was minted for, and is bound to the browser that started the flow by a single-use cookie nonce
 * (lib/oauth-nonce.ts) — the three properties each dedicated copy re-implemented.
 */
import type { Context } from "hono";
import { HttpError, requireUser } from "./auth.js";
import { signConnectorState, verifyConnectorState, saveConnectorRefreshToken } from "./connector-oauth.js";
import { getConnector } from "./connectors/registry.js";
import { SAFE_FETCH_TIMEOUT_MS } from "./ssrf.js";
import type { Connector } from "./connectors/types.js";
import { clearOauthBindCookie, newOauthNonce, oauthBindCookie, readOauthBindCookie, OAUTH_BIND_ERROR } from "./oauth-nonce.js";
import type { Env } from "../types.js";

export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

type Ctx = Context<{ Bindings: Env }>;

/** The authorize/token URLs for this deployment — per-env when the connector says they are. */
export function oauthEndpoints(env: Env, connector: Connector): { authUrl: string; tokenUrl: string } {
	const oauth = connector.oauth!;
	return oauth.endpointsFromEnv ? oauth.endpointsFromEnv(env) : { authUrl: oauth.authUrl, tokenUrl: oauth.tokenUrl };
}

/** The redirect URI the provider has registered for this connector, on this origin. */
export function oauthRedirectUri(reqUrl: string, connector: Connector): string {
	const path = connector.oauth?.redirectPath ?? `/v1/connectors/${encodeURIComponent(connector.id)}/oauth/callback`;
	return new URL(path, reqUrl).toString();
}

/**
 * The scopes one start asks for: the baseline plus the optional grants named (#718). A grant the
 * connector does not declare is refused rather than ignored or passed through — the provider is
 * never asked for a scope the connector does not describe.
 */
export function requestScopesFor(connector: Connector, grants: readonly string[]): { scopes: string[] } | { error: string } {
	const offered = connector.oauth?.optionalGrants ?? [];
	const scopes = [...(connector.oauth?.scopes ?? [])];
	for (const id of new Set(grants)) {
		const grant = offered.find((g) => g.id === id);
		if (!grant) {
			return {
				error: offered.length
					? `Unknown ${connector.label} permission "${id}" — choose from: ${offered.map((g) => g.id).join(", ")}.`
					: `${connector.label} has no optional permissions to choose.`,
			};
		}
		scopes.push(...grant.scopes);
	}
	return { scopes };
}

/** The union of two space-separated scope strings, order kept; null only when both are empty (#718). */
export function mergeScopes(held: string | null | undefined, returned: string | null | undefined): string | null {
	const all = [...new Set(`${held ?? ""} ${returned ?? ""}`.split(/\s+/).filter(Boolean))];
	return all.length ? all.join(" ") : null;
}

/** An oauth connector with credentials wired on this deployment, or a clear error. */
function requireOauthConnector(env: Env, id: string): { connector: Connector; clientId: string; clientSecret: string } {
	const connector = getConnector(id);
	if (connector?.auth !== "oauth" || !connector.oauth) throw new HttpError(404, `No OAuth connector "${id}".`);
	const e = env as unknown as Record<string, string | undefined>;
	const clientId = connector.oauth.clientIdEnv ? e[connector.oauth.clientIdEnv] : undefined;
	const clientSecret = connector.oauth.secretEnv ? e[connector.oauth.secretEnv] : undefined;
	if (!clientId || !clientSecret) throw new HttpError(503, `${connector.label} connection is not configured on this deployment.`);
	return { connector, clientId, clientSecret };
}

/**
 * Begin a connect: returns `{ url }`, the provider's consent page. `?grant=` (repeated or
 * comma-separated) adds declared optional powers; `?account=` pre-selects an account at a provider
 * that honours `login_hint`.
 */
export async function startConnectorOauth(c: Ctx, id: string): Promise<Response> {
	const session = await requireUser(c);
	const { connector, clientId } = requireOauthConnector(c.env, id);
	const oauth = connector.oauth!;
	const grants = c.req.queries("grant")?.flatMap((g) => g.split(",")).map((g) => g.trim()).filter(Boolean) ?? [];
	const requested = requestScopesFor(connector, grants);
	if ("error" in requested) throw new HttpError(400, requested.error);

	// Bind the state to THIS browser and to THIS connector — a signed state is otherwise
	// bearer-grade, so an attacker's link completed by a victim stores the VICTIM's refresh
	// token under the ATTACKER's account. See lib/oauth-nonce.ts.
	const bindNonce = newOauthNonce();
	const state = await signConnectorState(session.uid, Math.floor(Date.now() / 1000) + OAUTH_STATE_TTL_SECONDS, c.env.SESSION_SIGNING_KEY, {
		nonce: bindNonce,
		provider: id,
	});
	c.header("Set-Cookie", oauthBindCookie(bindNonce, id));
	const url = new URL(oauthEndpoints(c.env, connector).authUrl);
	url.searchParams.set("client_id", clientId);
	url.searchParams.set("redirect_uri", oauthRedirectUri(c.req.url, connector));
	url.searchParams.set("response_type", "code");
	if (requested.scopes.length) url.searchParams.set("scope", requested.scopes.join(" "));
	url.searchParams.set("access_type", "offline");
	if (oauth.optionalGrants?.length) {
		// Only where the owner chooses powers (#718): the grant then covers what this client already
		// held for the account, so an elevate for one power never drops another. Not for a connector
		// without choices — on a shared Google client it would widen that connector's token to every
		// scope granted to its siblings.
		url.searchParams.set("include_granted_scopes", "true");
		const account = c.req.query("account")?.trim();
		if (account && account.length <= 320) url.searchParams.set("login_hint", account);
	}
	// A refresh token every time — and what re-prompts an already connected owner for a new power.
	url.searchParams.set("prompt", "consent");
	url.searchParams.set("state", state);
	return c.json({ url: url.toString() });
}

/** Finish a connect: verify the state, exchange the code, store the credential. */
export async function completeConnectorOauth(c: Ctx, id: string): Promise<Response> {
	const code = c.req.query("code");
	const stateRaw = c.req.query("state");
	if (!code || !stateRaw) return c.text("missing code or state", 400);
	let resolved: ReturnType<typeof requireOauthConnector>;
	try {
		resolved = requireOauthConnector(c.env, id);
	} catch (e) {
		return c.text(e instanceof HttpError ? e.message : "connection is not configured", e instanceof HttpError ? (e.status as 404 | 503) : 503);
	}
	const { connector, clientId, clientSecret } = resolved;
	if (!c.env.KEY_ENCRYPTION_KEY) return c.text("Key encryption not configured", 500);

	const uid = await verifyConnectorState(stateRaw, c.env.SESSION_SIGNING_KEY, {
		cookieNonce: readOauthBindCookie(c.req.header("cookie"), id),
		provider: id,
	});
	c.header("Set-Cookie", clearOauthBindCookie(id)); // single-use, whatever the outcome
	if (!uid) return c.text(OAUTH_BIND_ERROR, 400);

	const tokenRes = await fetch(oauthEndpoints(c.env, connector).tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: oauthRedirectUri(c.req.url, connector), grant_type: "authorization_code" }),
		signal: AbortSignal.timeout(SAFE_FETCH_TIMEOUT_MS),
	});
	if (!tokenRes.ok) return c.text(`${connector.label} token exchange failed (${tokenRes.status})`, 400);
	const tok = (await tokenRes.json()) as { refresh_token?: string; access_token?: string; scope?: string };
	if (!tok.refresh_token) {
		return c.text(`${connector.label} did not return a refresh token — remove this app's access at the provider and reconnect.`, 400);
	}

	const identity = connector.oauth!.identity;
	let accountLabel: string | null = null;
	if (identity?.label === "userinfo-email") {
		if (tok.access_token) {
			try {
				const ui = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(SAFE_FETCH_TIMEOUT_MS) });
				if (ui.ok) accountLabel = ((await ui.json()) as { email?: string }).email ?? null;
			} catch {
				/* non-fatal — the connection works without the label */
			}
		}
	} else if (identity?.label) {
		accountLabel = identity.label;
	}
	// Per-account connectors key the row by the account (#715); an unreadable address falls back to
	// '', the unnamed row — what the connection meant before accounts existed. Everything else is
	// the single row every existing connection already is.
	const accountId = identity?.perAccount ? (accountLabel ?? "") : "";
	// What the provider ACTUALLY granted, merged with what this account already held (#718) — an
	// elevate or a reconnect that comes back narrower must not narrow the record.
	const prior = await c.env.DB.prepare("SELECT granted_scopes FROM user_api_keys WHERE user_id = ?1 AND provider = ?2 AND account_id = ?3")
		.bind(uid, id, accountId)
		.first<{ granted_scopes: string | null }>()
		.catch(() => null);
	await saveConnectorRefreshToken(c.env, {
		userId: uid,
		provider: id,
		refreshToken: tok.refresh_token,
		accountLabel,
		accountId,
		grantedScopes: mergeScopes(prior?.granted_scopes, tok.scope ?? null),
	});

	const label = connector.label.replace(/[<>&"']/g, "");
	return c.html(
		`<!doctype html><title>${label} connected</title><body style='font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0'><div style='text-align:center'><h1>${label} connected</h1><p>You can close this tab and return to ProAgentStore.</p></div></body>`,
	);
}
