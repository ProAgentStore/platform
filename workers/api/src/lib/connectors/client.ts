// connectorClient (issue #86) — the ONE place a connector tool obtains its access
// token and has grant/scope enforced. Handlers no longer import token-minting fns
// directly; they call `ctx.connectorClient(provider)` and get back a small client that
//   • token(opts?)     — mints/reads the provider's access token (dispatched by auth type)
//   • requireGrant(id) — fail-closed grant check for instance-resource connectors (403)
//   • fetch(url, init) — a Bearer-authorized fetch (token minted for you)
// This centralizes auth + enforces scope so a new connector declares {auth, scopes,
// grantModel} once instead of hand-rolling token logic in each tool.
import { HttpError } from "../auth.js";
import type { Env } from "../../types.js";
import { resolveGithubAccess } from "../github-app.js";
import { readConnectorRefreshToken } from "../connector-oauth.js";
import { requireConnectorGrant, type ConnectorGrant } from "../connector-grants.js";
import { safeFetch } from "../ssrf.js";
import { getConnector } from "./registry.js";
import type { Connector, ConnectorClient, ConnectorClientCaller, TokenOpts } from "./types.js";

/** The client's SHAPE lives in the contract leaf (#293) — `RegistryToolCtx.connectorClient`
 *  names it, so declaring it here made the tool contract depend on the auth implementation.
 *  Re-exported: `connectorClient` below is still the one place a token is minted. */
export type { ConnectorClient, ConnectorClientCaller, TokenOpts };

interface OauthClientCreds {
	clientId?: string;
	clientSecret?: string;
	tokenUrl?: string;
}

/** Resolve a connector's OAuth token endpoint + client credentials. Manifest connectors carry
 *  their config on `Connector.oauth` (endpoint + env-var names for the credentials); the hand-
 *  written google_drive connector keeps its hardcoded creds. `resolveOauthConfig` is exported so
 *  the generic authorize/callback route (routes/connectors.ts) resolves the same way. */
export function resolveOauthConfig(env: Env, connectorId: string): OauthClientCreds {
	if (connectorId === "google_drive") {
		return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, tokenUrl: "https://oauth2.googleapis.com/token" };
	}
	const oauth = getConnector(connectorId)?.oauth;
	if (!oauth) return {};
	const e = env as unknown as Record<string, string | undefined>;
	return {
		clientId: oauth.clientIdEnv ? e[oauth.clientIdEnv] : undefined,
		clientSecret: oauth.secretEnv ? e[oauth.secretEnv] : undefined,
		tokenUrl: oauth.tokenUrl,
	};
}

/**
 * Generalized OAuth access-token minter — refreshes a stored refresh token into a short-lived
 * access token, using the connector's manifest-declared token endpoint + client credentials.
 */
async function mintOauthAccessToken(env: Env, connectorId: string, refreshToken: string): Promise<string> {
	const { clientId, clientSecret, tokenUrl: endpoint } = resolveOauthConfig(env, connectorId);
	if (!endpoint || !clientId || !clientSecret) {
		throw new HttpError(500, `OAuth is not configured for the ${connectorId} connector on this deployment`);
	}
	const res = await fetch(endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}),
	});
	if (!res.ok) throw new HttpError(502, `Could not refresh ${connectorId} access (${res.status}). Reconnect it in settings.`);
	const data = (await res.json()) as { access_token?: string };
	if (!data.access_token) throw new HttpError(502, `${connectorId} did not return an access token`);
	return data.access_token;
}

/**
 * connectorClient(env, provider, {userId, instanceId}) — resolves the connector and
 * returns a client that mints its token + enforces grant/scope. Throws HttpError(400)
 * for an unknown provider.
 */
export function connectorClient(env: Env, provider: string, caller: ConnectorClientCaller): ConnectorClient {
	const resolved = getConnector(provider);
	if (!resolved) throw new HttpError(400, `Unknown connector: ${provider}`);
	const connector: Connector = resolved;

	function assertScope(opts?: TokenOpts): void {
		// A read-only connector (no write scope) can never satisfy a write request.
		if (opts?.scope === "write" && !connector.scopes.write) {
			throw new HttpError(403, `The ${connector.id} connector is read-only — writes are not permitted.`);
		}
	}

	async function requireGrant(resourceId: string): Promise<ConnectorGrant> {
		if (connector.grantModel !== "instance-resource") {
			throw new HttpError(500, `The ${connector.id} connector is not resource-granted`);
		}
		if (!caller.instanceId || !caller.userId) {
			throw new HttpError(403, "No instance context — resource access is not granted");
		}
		return requireConnectorGrant(env, caller.instanceId, caller.userId, connector.id, resourceId);
	}

	async function token(opts?: TokenOpts): Promise<string> {
		assertScope(opts);
		// instance-resource connectors: a token is only minted once the resource is granted.
		if (connector.grantModel === "instance-resource" && opts?.resourceId) {
			await requireGrant(opts.resourceId);
		}
		switch (connector.auth) {
			case "none":
				return "";
			case "app": {
				// GitHub-App installation token, scoped to the resource owner.
				const owner = ownerOf(opts?.resourceId ?? "");
				// The failure now carries WHICH of the five conditions stopped it (#321). It used to be
				// ONE sentence — `No github access for "X"` — naming authorization for an owner that had
				// never been resolved, which the connector then wrapped in "this is usually transient".
				// The STATUS encodes the only distinction a caller must not get wrong: 502 is the single
				// retryable state; every other one is permanent until a human does something.
				const access = await resolveGithubAccess(env, caller.userId ?? "", owner, { diagnose: true }).catch(
					() =>
						({ ok: false, state: "transient", retryable: true, message: `GitHub could not be reached for "${owner}" just now.`, remedy: null }) as const,
				);
				if (access.ok) return access.token;
				const status = access.retryable ? 502 : access.state === "owner-unknown" ? 400 : access.state === "app-not-configured" ? 503 : 403;
				throw new HttpError(status, access.remedy ? `${access.message} ${access.remedy}` : access.message);
			}
			case "oauth": {
				const refresh = await readConnectorRefreshToken(env, caller.userId ?? "", connector.id, connector.label);
				return mintOauthAccessToken(env, connector.id, refresh);
			}
			case "token": {
				// A platform-env token (e.g. Meta business token) takes precedence; otherwise
				// the user's stored key from user_api_keys.
				if (connector.tokenEnv) {
					const t = env[connector.tokenEnv]?.trim();
					if (!t) throw new HttpError(400, `${connector.label} is not configured`);
					return t;
				}
				return readConnectorRefreshToken(env, caller.userId ?? "", connector.id, connector.label);
			}
		}
	}

	/**
	 * The URL here is the CALLER's — a connector tool composes it, and a tool's inputs are
	 * data (an instance's config, a pipeline definition, a model's argument). So it goes
	 * through `safeFetch` like every other caller-named destination in this layer: https-only,
	 * every redirect hop re-validated, metadata/RFC1918/CGNAT refused, and — the reason it
	 * matters most here — the `Authorization` header this function just attached is stripped
	 * when a hop crosses an origin. That header carries the owner's minted token.
	 *
	 * `security-invariants.test.ts` (#306) is what keeps this from drifting back.
	 */
	async function authedFetch(url: string, init?: RequestInit, opts?: TokenOpts): Promise<Response> {
		const t = await token(opts);
		const headers = new Headers(init?.headers);
		if (t) headers.set("Authorization", `Bearer ${t}`);
		return safeFetch(url, { ...init, headers });
	}

	return { connector, token, requireGrant, fetch: authedFetch };
}

/** owner from "owner/name" (or a bare "owner"). */
function ownerOf(resource: string): string {
	const s = String(resource || "").trim();
	if (!s) return "";
	return s.includes("/") ? s.split("/")[0] : s;
}
