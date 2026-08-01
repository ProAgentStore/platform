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
import { installationTokenForOwner } from "../github-app.js";
import { readConnectorRefreshToken } from "../connector-oauth.js";
import { requireConnectorGrant, type ConnectorGrant } from "../connector-grants.js";
import { getConnector, type Connector } from "./registry.js";

export interface ConnectorClientCaller {
	userId?: string;
	instanceId?: string;
}

export interface TokenOpts {
	/** For app-auth connectors (github): the resource whose owner the token is minted for (e.g. "owner/name" or "owner"). For instance-resource grants: the granted resourceId. */
	resourceId?: string;
	/** The scope the caller intends. A "write" against a read-only connector is rejected. */
	scope?: "read" | "write";
}

export interface ConnectorClient {
	/** The resolved connector definition. */
	readonly connector: Connector;
	/** Mint/read the access token for this connector. Returns "" for auth:"none". */
	token(opts?: TokenOpts): Promise<string>;
	/** Fail-closed grant check (instance-resource connectors only). Throws HttpError(403) if not granted. */
	requireGrant(resourceId: string): Promise<ConnectorGrant>;
	/** A Bearer-authorized fetch — the access token is minted and attached for you. */
	fetch(url: string, init?: RequestInit, opts?: TokenOpts): Promise<Response>;
}

// OAuth token endpoints per provider, so the generalized minter (extracted from
// mintDriveAccessToken) can refresh any oauth connector. Keyed by connector id.
const OAUTH_TOKEN_ENDPOINTS: Record<string, string> = {
	google_drive: "https://oauth2.googleapis.com/token",
};

interface OauthClientCreds {
	clientId?: string;
	clientSecret?: string;
}

function oauthCreds(env: Env, connectorId: string): OauthClientCreds {
	switch (connectorId) {
		case "google_drive":
			return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
		default:
			return {};
	}
}

/**
 * Generalized OAuth access-token minter — the mintDriveAccessToken pattern, switched on
 * the provider's token endpoint + client credentials. Refreshes a stored refresh token
 * into a short-lived access token.
 */
async function mintOauthAccessToken(env: Env, connectorId: string, refreshToken: string): Promise<string> {
	const endpoint = OAUTH_TOKEN_ENDPOINTS[connectorId];
	const { clientId, clientSecret } = oauthCreds(env, connectorId);
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
				const t = await installationTokenForOwner(env, caller.userId ?? "", owner).catch(() => null);
				if (!t) throw new HttpError(403, `No ${connector.id} access for "${owner}".`);
				return t;
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

	async function authedFetch(url: string, init?: RequestInit, opts?: TokenOpts): Promise<Response> {
		const t = await token(opts);
		const headers = new Headers(init?.headers);
		if (t) headers.set("Authorization", `Bearer ${t}`);
		return fetch(url, { ...init, headers });
	}

	return { connector, token, requireGrant, fetch: authedFetch };
}

/** owner from "owner/name" (or a bare "owner"). */
function ownerOf(resource: string): string {
	const s = String(resource || "").trim();
	if (!s) return "";
	return s.includes("/") ? s.split("/")[0] : s;
}
