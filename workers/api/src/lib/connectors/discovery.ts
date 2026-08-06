/**
 * OAuth discovery for user-named endpoints (#180).
 *
 * The connector auth model assumes the operator knows the remote system at build time: `oauth`
 * needs `clientIdEnv`/`secretEnv` resolved from operator env, i.e. a client pre-registered with a
 * server the operator has heard of. That breaks for the first connector where a SUBSCRIBER names
 * the endpoint at runtime (outbound MCP, `mcp_url` as a per-instance setting) — there is no value
 * that could go in `secretEnv`.
 *
 * What this module ships is the DISCOVERY half of the answer, and it is deliberately the half
 * that is shared:
 *
 *   • #180 needs it to learn where a named server's authorization server is, and whether that
 *     server supports dynamic client registration at all.
 *   • #181 needs exactly the same fetch to learn whether the credential could survive unattended
 *     (`refresh_token` in `grant_types_supported`).
 *
 * What it deliberately does NOT ship is the RFC 7591 registration + PKCE browser flow. See
 * `docs/connector-auth.md` and the note on `discoverAuthServer` for why that was deferred rather
 * than half-built.
 *
 * The chain is two hops of published metadata:
 *
 *   resource URL --RFC 9728--> authorization server --RFC 8414--> endpoints + capabilities
 *
 * Everything crossing the wire goes through the injected fetch, which defaults to `safeFetch`
 * (lib/ssrf.ts): https-only, redirect-revalidated, private/metadata addresses refused. The
 * resource URL here is user-supplied by construction, so the metadata fetches are exactly as
 * attacker-influenceable as the tool call itself and get the same guard.
 */
import { safeFetch } from "../ssrf.js";
import { unattendedFromGrantTypes, type UnattendedClass } from "./unattended.js";

/** RFC 9728 protected-resource metadata, reduced to what we act on. */
export interface ProtectedResourceMetadata {
	resource?: string;
	authorizationServers: string[];
}

/** RFC 8414 authorization-server metadata, reduced to what we act on. */
export interface AuthServerMetadata {
	issuer?: string;
	authorizationEndpoint?: string;
	tokenEndpoint?: string;
	/** RFC 7591 dynamic client registration endpoint. Absent = the client must be pre-registered. */
	registrationEndpoint?: string;
	grantTypes: string[];
	codeChallengeMethods: string[];
	tokenEndpointAuthMethods: string[];
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function strArray(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : [];
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Where a resource's RFC 9728 metadata may live, most-specific first.
 *
 * RFC 9728 inserts the resource's PATH after the well-known segment
 * (`https://h/mcp` → `https://h/.well-known/oauth-protected-resource/mcp`), but servers commonly
 * also answer at the bare root, so both are tried in that order. Returns [] for a non-https or
 * unparseable URL — the caller has nothing to fetch and should not construct one by hand.
 */
export function protectedResourceMetadataUrls(resourceUrl: string): string[] {
	let u: URL;
	try {
		u = new URL(resourceUrl);
	} catch {
		return [];
	}
	if (u.protocol !== "https:") return [];
	const path = u.pathname.replace(/^\/+|\/+$/g, "");
	const root = `${u.origin}/.well-known/oauth-protected-resource`;
	return path ? [`${root}/${path}`, root] : [root];
}

/**
 * Where an issuer's RFC 8414 metadata may live, most-specific first.
 *
 * Same path-insertion rule as above, plus the OpenID Connect discovery document, which many
 * servers serve instead of (or as well as) the OAuth one and which carries the same fields.
 */
export function authServerMetadataUrls(issuer: string): string[] {
	let u: URL;
	try {
		u = new URL(issuer);
	} catch {
		return [];
	}
	if (u.protocol !== "https:") return [];
	const path = u.pathname.replace(/^\/+|\/+$/g, "");
	const urls: string[] = [];
	if (path) {
		urls.push(`${u.origin}/.well-known/oauth-authorization-server/${path}`);
		urls.push(`${u.origin}/${path}/.well-known/openid-configuration`);
	}
	urls.push(`${u.origin}/.well-known/oauth-authorization-server`);
	urls.push(`${u.origin}/.well-known/openid-configuration`);
	return [...new Set(urls)];
}

/** Parse RFC 9728 metadata. Null when it carries no authorization server — the only field we need. */
export function parseProtectedResourceMetadata(raw: unknown): ProtectedResourceMetadata | null {
	if (!isRecord(raw)) return null;
	const authorizationServers = strArray(raw.authorization_servers).filter((s) => /^https:\/\//i.test(s));
	if (!authorizationServers.length) return null;
	return { resource: str(raw.resource), authorizationServers };
}

/** Parse RFC 8414 / OIDC metadata. Null unless it names at least a token endpoint. */
export function parseAuthServerMetadata(raw: unknown): AuthServerMetadata | null {
	if (!isRecord(raw)) return null;
	const tokenEndpoint = str(raw.token_endpoint);
	if (!tokenEndpoint) return null;
	return {
		issuer: str(raw.issuer),
		authorizationEndpoint: str(raw.authorization_endpoint),
		tokenEndpoint,
		registrationEndpoint: str(raw.registration_endpoint),
		// An AS omitting grant_types_supported defaults to ["authorization_code", "implicit"]
		// per RFC 8414 — notably NOT including refresh_token, so the absence is meaningful and
		// must not be read as "unknown, assume fine".
		grantTypes: strArray(raw.grant_types_supported),
		codeChallengeMethods: strArray(raw.code_challenge_methods_supported),
		tokenEndpointAuthMethods: strArray(raw.token_endpoint_auth_methods_supported),
	};
}

/** Whether the server will register a client at runtime (RFC 7591) — the precondition for DCR. */
export function supportsDynamicRegistration(md: Pick<AuthServerMetadata, "registrationEndpoint">): boolean {
	return !!md.registrationEndpoint;
}

/** Whether the server supports PKCE S256, the only challenge method a public client should use. */
export function supportsPkceS256(md: Pick<AuthServerMetadata, "codeChallengeMethods">): boolean {
	return md.codeChallengeMethods.some((m) => m.toUpperCase() === "S256");
}

/** The unattended class implied by a discovered server's advertised grants (#181). */
export function unattendedFromMetadata(md: Pick<AuthServerMetadata, "grantTypes">): UnattendedClass {
	return unattendedFromGrantTypes(md.grantTypes);
}

/** What a discovery attempt learned. `protected:false` means the endpoint published no metadata. */
export type DiscoveryResult =
	| { protected: false }
	| {
			protected: true;
			authorizationServer: string;
			metadata: AuthServerMetadata;
			dcr: boolean;
			pkceS256: boolean;
			unattended: UnattendedClass;
	  };

/** Injected transport, so the whole chain is testable without network or SSRF context. */
export type DiscoveryFetch = (url: string) => Promise<Response>;

const defaultFetch: DiscoveryFetch = (url) => safeFetch(url, { method: "GET", headers: { Accept: "application/json" } });

/** Fetch one JSON document, tolerating every failure — a probe that 404s is information, not an error. */
async function probe(fetchImpl: DiscoveryFetch, url: string): Promise<unknown> {
	try {
		const res = await fetchImpl(url);
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

/**
 * Walk resource → authorization server → capabilities.
 *
 * Returns `{protected:false}` for anything it cannot resolve, so a caller can treat "no metadata"
 * as "the existing vault-bearer path is the right answer here" rather than an error. That is the
 * documented fallback: a server issuing genuine machine tokens has nothing to discover.
 *
 * WHAT THIS DOES NOT DO — and why it stops here (#180 is only partly delivered):
 *
 * Registration (RFC 7591) and the PKCE authorize/callback round trip are NOT implemented. The
 * ticket's acceptance ("a subscriber can connect an arbitrary OAuth-protected MCP server with no
 * pasted token") is therefore NOT met. That is a deliberate stop, not an omission, because of
 * what discovery itself reports about the only verified target: its metadata advertises
 * `grant_types_supported: ["authorization_code"]` with no `refresh_token` and a 24h token. A
 * completed DCR+PKCE flow against it yields an `interactive-only` credential — one that dies
 * daily and needs a human at a browser — which cannot serve the cron-driven pipelines that
 * motivate the connector in the first place. Building the flow now would add a registration
 * cache, a migration, new routes and per-origin grant keying in exchange for a credential the
 * companion ticket (#181) exists to warn people away from wiring up.
 *
 * So this ships the half that is useful and shared today — telling the user precisely what the
 * server wants and whether it could ever run unattended — and the flow waits on a target that
 * issues refresh tokens (freewebstore-online/platform#114).
 */
export async function discoverAuthServer(resourceUrl: string, fetchImpl: DiscoveryFetch = defaultFetch): Promise<DiscoveryResult> {
	let prm: ProtectedResourceMetadata | null = null;
	for (const url of protectedResourceMetadataUrls(resourceUrl)) {
		prm = parseProtectedResourceMetadata(await probe(fetchImpl, url));
		if (prm) break;
	}

	// A server may skip RFC 9728 and serve AS metadata on its own origin; try that before
	// concluding the endpoint is unprotected.
	const issuers = prm?.authorizationServers ?? originOf(resourceUrl);
	for (const issuer of issuers) {
		for (const url of authServerMetadataUrls(issuer)) {
			const md = parseAuthServerMetadata(await probe(fetchImpl, url));
			if (!md) continue;
			return {
				protected: true,
				authorizationServer: issuer,
				metadata: md,
				dcr: supportsDynamicRegistration(md),
				pkceS256: supportsPkceS256(md),
				unattended: unattendedFromMetadata(md),
			};
		}
	}
	return { protected: false };
}

function originOf(raw: string): string[] {
	try {
		const u = new URL(raw);
		return u.protocol === "https:" ? [u.origin] : [];
	} catch {
		return [];
	}
}

/**
 * The message an MCP tool shows when a server rejects its credential. Names what the server
 * actually asked for, which the previous generic "if it requires OAuth, a stored token will not
 * work" could not: the user could not tell a wrong token from an unsupported auth model.
 */
export function authFailureGuidance(status: number, discovery: DiscoveryResult): string {
	if (!discovery.protected) {
		return `MCP server rejected the credential (HTTP ${status}). It publishes no OAuth metadata, so it expects a token you supply — check the token stored for the "mcp" connector.`;
	}
	const parts = [`MCP server rejected the credential (HTTP ${status}). It is OAuth-protected by ${discovery.authorizationServer}.`];
	parts.push(
		discovery.dcr
			? "The server supports dynamic client registration, which ProAgentStore cannot yet complete automatically (#180)."
			: "The server requires a pre-registered OAuth client.",
	);
	if (discovery.unattended === "interactive-only") {
		parts.push("It also issues no refresh token, so any access it grants expires and cannot be renewed unattended.");
	}
	parts.push('For now, store an access token the server accepts under the "mcp" connector, or use auth:"none" if it has an open endpoint.');
	return parts.join(" ");
}
