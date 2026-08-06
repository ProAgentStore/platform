/**
 * RFC 7591 dynamic client registration — the half of #180 that `discovery.ts` deliberately
 * stopped short of.
 *
 * WHY THIS IS THE UNLOCK. Every other connector's OAuth config names a client the OPERATOR
 * pre-registered, with its secret in operator env. That model has no expression for the case this
 * connector exists to serve: a subscriber types an MCP endpoint we have never heard of. There is
 * no value that could go in `secretRef`, because nobody registered anything. RFC 7591 inverts it —
 * the client registers ITSELF, at runtime, for its own callback, with no secret and no operator
 * involvement. Discovery (RFC 9728 → RFC 8414) says where the registration endpoint is; this says
 * what to send it and how to read the answer.
 *
 * WE REGISTER AS A PUBLIC CLIENT (`token_endpoint_auth_method: "none"`) and rely on PKCE. That is
 * what MCP servers implement, and it is also the safer request: a secret we asked for is a secret
 * we then have to store, rotate and leak. When a server insists on issuing one anyway we keep it
 * (envelope-encrypted, like every other credential) and use it at the token endpoint — refusing
 * would break an otherwise-conforming server for no gain.
 *
 * The registration request crosses the wire to a URL discovered from user-supplied config, so it
 * goes through `safeFetch` (https-only, redirect-revalidated, private/metadata addresses refused)
 * exactly like discovery does. Nothing secret is SENT — the body is our name, our callback and the
 * grants we want — but the request is still an attacker-influenceable outbound fetch, and those
 * get one guard, not one per caller.
 */
import { safeFetch } from "../ssrf.js";

/** What a completed registration gives us. `clientSecret` is null for the public-client case. */
export interface ClientRegistration {
	clientId: string;
	clientSecret: string | null;
	/** Echoed back by the server; we keep OUR value, since that is what the token exchange repeats. */
	redirectUri: string;
}

export interface RegisterClientInput {
	registrationEndpoint: string;
	redirectUri: string;
	/** Advertised to the server's consent screen. Deliberately constant — it identifies PAGS, not a user. */
	clientName?: string;
	/** Requested up front so a server that gates refresh on registration issues one. */
	grantTypes?: string[];
	scope?: string | null;
}

/** Injected transport, so the round trip is testable without network or SSRF context. */
export type DcrFetch = (url: string, init: RequestInit) => Promise<Response>;

const defaultFetch: DcrFetch = (url, init) => safeFetch(url, init);

export const CLIENT_NAME = "ProAgentStore";

/**
 * The RFC 7591 client metadata document.
 *
 * `refresh_token` is requested EVEN THOUGH the authorization request cannot ask for it: several
 * servers decide at registration time whether a client may ever refresh, so omitting it here is
 * how a client silently ends up interactive-only despite the server supporting refresh. Asking
 * costs nothing at a server that ignores it.
 */
export function clientMetadata(input: RegisterClientInput): Record<string, unknown> {
	const body: Record<string, unknown> = {
		client_name: input.clientName ?? CLIENT_NAME,
		redirect_uris: [input.redirectUri],
		grant_types: input.grantTypes ?? ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
	};
	if (input.scope) body.scope = input.scope;
	return body;
}

/**
 * Parse a registration response. Null unless it carries a usable `client_id` — a 201 with no
 * client id is not a registration, and treating it as one would produce an authorize URL with
 * `client_id=undefined` that fails at the far end with a message about the wrong thing.
 */
export function parseClientRegistration(raw: unknown, redirectUri: string): ClientRegistration | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const clientId = typeof r.client_id === "string" ? r.client_id.trim() : "";
	if (!clientId) return null;
	const secret = typeof r.client_secret === "string" && r.client_secret.trim() ? r.client_secret.trim() : null;
	return { clientId, clientSecret: secret, redirectUri };
}

/** Thrown so the route can report the server's own words rather than a generic failure. */
export class DcrError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "DcrError";
	}
}

/** Perform the registration. Throws `DcrError` with the server's status/body excerpt on failure. */
export async function registerClient(input: RegisterClientInput, fetchImpl: DcrFetch = defaultFetch): Promise<ClientRegistration> {
	const res = await fetchImpl(input.registrationEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify(clientMetadata(input)),
	});
	const text = await res.text();
	if (!res.ok) {
		throw new DcrError(`Client registration was refused (HTTP ${res.status}): ${text.slice(0, 200)}`, res.status);
	}
	let parsed: unknown = null;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new DcrError("Client registration returned a body that is not JSON.", res.status);
	}
	const reg = parseClientRegistration(parsed, input.redirectUri);
	if (!reg) throw new DcrError("Client registration returned no client_id.", res.status);
	return reg;
}
