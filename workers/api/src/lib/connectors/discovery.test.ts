import { describe, it, expect } from "vitest";
import {
	authFailureGuidance,
	authServerMetadataUrls,
	discoverAuthServer,
	parseAuthServerMetadata,
	parseProtectedResourceMetadata,
	protectedResourceMetadataUrls,
	supportsDynamicRegistration,
	supportsPkceS256,
	unattendedFromMetadata,
	type DiscoveryFetch,
} from "./discovery.js";

/**
 * The metadata FreeWebStore actually serves, captured live. This is the concrete case both #180
 * and #181 are about: DCR-capable, PKCE S256, public client — and NO refresh_token grant, which
 * is what makes a completed DCR flow yield an interactive-only credential.
 */
const FWS_PRM = {
	resource: "https://agent.freewebstore.online/mcp",
	authorization_servers: ["https://agent.freewebstore.online"],
};
const FWS_AS = {
	issuer: "https://agent.freewebstore.online",
	authorization_endpoint: "https://agent.freewebstore.online/authorize",
	token_endpoint: "https://agent.freewebstore.online/token",
	registration_endpoint: "https://agent.freewebstore.online/register",
	response_types_supported: ["code"],
	grant_types_supported: ["authorization_code"],
	code_challenge_methods_supported: ["S256"],
	token_endpoint_auth_methods_supported: ["none"],
};

/** A fetch that serves a fixed url→json map and 404s everything else, recording what was asked. */
function fakeFetch(docs: Record<string, unknown>, seen: string[] = []): DiscoveryFetch {
	return async (url: string) => {
		seen.push(url);
		if (!(url in docs)) return new Response("not found", { status: 404 });
		return new Response(JSON.stringify(docs[url]), { status: 200, headers: { "Content-Type": "application/json" } });
	};
}

describe("protectedResourceMetadataUrls — RFC 9728 path insertion", () => {
	it("tries the path-specific location before the origin root", () => {
		expect(protectedResourceMetadataUrls("https://h.example/mcp")).toEqual([
			"https://h.example/.well-known/oauth-protected-resource/mcp",
			"https://h.example/.well-known/oauth-protected-resource",
		]);
	});

	it("has only the root form for a path-less resource", () => {
		expect(protectedResourceMetadataUrls("https://h.example/")).toEqual(["https://h.example/.well-known/oauth-protected-resource"]);
	});

	it("refuses to construct a probe for a non-https or unparseable URL", () => {
		expect(protectedResourceMetadataUrls("http://h.example/mcp")).toEqual([]);
		expect(protectedResourceMetadataUrls("not a url")).toEqual([]);
	});
});

describe("authServerMetadataUrls — RFC 8414 plus the OIDC document", () => {
	it("covers both well-known forms for a path-less issuer", () => {
		expect(authServerMetadataUrls("https://as.example")).toEqual([
			"https://as.example/.well-known/oauth-authorization-server",
			"https://as.example/.well-known/openid-configuration",
		]);
	});

	it("puts the path-specific forms first for an issuer with a path", () => {
		const urls = authServerMetadataUrls("https://as.example/tenant1");
		expect(urls[0]).toBe("https://as.example/.well-known/oauth-authorization-server/tenant1");
		expect(urls).toContain("https://as.example/tenant1/.well-known/openid-configuration");
	});

	it("refuses a non-https issuer", () => {
		expect(authServerMetadataUrls("http://as.example")).toEqual([]);
	});
});

describe("parseProtectedResourceMetadata", () => {
	it("reads the authorization servers", () => {
		expect(parseProtectedResourceMetadata(FWS_PRM)).toEqual({
			resource: "https://agent.freewebstore.online/mcp",
			authorizationServers: ["https://agent.freewebstore.online"],
		});
	});

	it("is null without an authorization server — the only field we act on", () => {
		expect(parseProtectedResourceMetadata({ resource: "https://h/mcp" })).toBeNull();
		expect(parseProtectedResourceMetadata({ authorization_servers: [] })).toBeNull();
		expect(parseProtectedResourceMetadata(null)).toBeNull();
		expect(parseProtectedResourceMetadata("nope")).toBeNull();
	});

	it("drops a non-https authorization server rather than following it", () => {
		expect(parseProtectedResourceMetadata({ authorization_servers: ["http://evil.example"] })).toBeNull();
	});
});

describe("parseAuthServerMetadata", () => {
	it("reads the endpoints and capabilities", () => {
		const md = parseAuthServerMetadata(FWS_AS)!;
		expect(md.tokenEndpoint).toBe("https://agent.freewebstore.online/token");
		expect(md.registrationEndpoint).toBe("https://agent.freewebstore.online/register");
		expect(md.grantTypes).toEqual(["authorization_code"]);
		expect(md.codeChallengeMethods).toEqual(["S256"]);
		expect(md.tokenEndpointAuthMethods).toEqual(["none"]);
	});

	it("is null without a token endpoint", () => {
		expect(parseAuthServerMetadata({ issuer: "https://as.example" })).toBeNull();
		expect(parseAuthServerMetadata(null)).toBeNull();
	});

	it("reports no DCR when the server does not publish a registration endpoint", () => {
		const md = parseAuthServerMetadata({ token_endpoint: "https://as.example/token" })!;
		expect(supportsDynamicRegistration(md)).toBe(false);
		expect(supportsPkceS256(md)).toBe(false);
	});
});

describe("capability + survivability derivation", () => {
	const md = parseAuthServerMetadata(FWS_AS)!;

	it("recognises the DCR + PKCE stack MCP mandates", () => {
		expect(supportsDynamicRegistration(md)).toBe(true);
		expect(supportsPkceS256(md)).toBe(true);
	});

	it("classifies the live FreeWebStore server as interactive-only — the crux of #181", () => {
		expect(unattendedFromMetadata(md)).toBe("interactive-only");
	});

	it("classifies a server that issues refresh tokens as survivable", () => {
		const withRefresh = parseAuthServerMetadata({ ...FWS_AS, grant_types_supported: ["authorization_code", "refresh_token"] })!;
		expect(unattendedFromMetadata(withRefresh)).toBe("refresh");
	});
});

describe("discoverAuthServer — resource → RFC 9728 → RFC 8414", () => {
	it("walks the full chain and reports what the server wants", async () => {
		const fetchImpl = fakeFetch({
			"https://agent.freewebstore.online/.well-known/oauth-protected-resource/mcp": FWS_PRM,
			"https://agent.freewebstore.online/.well-known/oauth-authorization-server": FWS_AS,
		});
		const out = await discoverAuthServer("https://agent.freewebstore.online/mcp", fetchImpl);
		expect(out.protected).toBe(true);
		if (!out.protected) throw new Error("unreachable");
		expect(out.authorizationServer).toBe("https://agent.freewebstore.online");
		expect(out.dcr).toBe(true);
		expect(out.pkceS256).toBe(true);
		expect(out.unattended).toBe("interactive-only");
	});

	it("falls back to the root RFC 9728 location when the path-specific one 404s", async () => {
		const seen: string[] = [];
		const fetchImpl = fakeFetch(
			{
				"https://h.example/.well-known/oauth-protected-resource": { authorization_servers: ["https://as.example"] },
				"https://as.example/.well-known/oauth-authorization-server": { token_endpoint: "https://as.example/token" },
			},
			seen,
		);
		const out = await discoverAuthServer("https://h.example/mcp", fetchImpl);
		expect(out.protected).toBe(true);
		expect(seen[0]).toBe("https://h.example/.well-known/oauth-protected-resource/mcp"); // tried the specific one first
	});

	it("finds an AS that skips RFC 9728 and publishes metadata on its own origin", async () => {
		const fetchImpl = fakeFetch({
			"https://h.example/.well-known/oauth-authorization-server": { token_endpoint: "https://h.example/token", grant_types_supported: ["authorization_code", "refresh_token"] },
		});
		const out = await discoverAuthServer("https://h.example/mcp", fetchImpl);
		expect(out.protected).toBe(true);
		if (!out.protected) throw new Error("unreachable");
		expect(out.unattended).toBe("refresh");
	});

	it("reports 'not protected' when nothing is published — the vault-bearer path stays right", async () => {
		const out = await discoverAuthServer("https://h.example/mcp", fakeFetch({}));
		expect(out).toEqual({ protected: false });
	});

	it("never throws — a probe that errors is information, not a failure", async () => {
		const boom: DiscoveryFetch = async () => {
			throw new Error("network down");
		};
		await expect(discoverAuthServer("https://h.example/mcp", boom)).resolves.toEqual({ protected: false });
	});

	it("builds no probes at all for a non-https resource, so nothing internal can be aimed at", async () => {
		const seen: string[] = [];
		const out = await discoverAuthServer("http://169.254.169.254/mcp", fakeFetch({}, seen));
		expect(out).toEqual({ protected: false });
		expect(seen).toEqual([]);
	});
});

describe("authFailureGuidance — say what the server actually wants", () => {
	const discovered = {
		protected: true as const,
		authorizationServer: "https://agent.freewebstore.online",
		metadata: parseAuthServerMetadata(FWS_AS)!,
		dcr: true,
		pkceS256: true,
		unattended: "interactive-only" as const,
	};

	it("names the authorization server, the one-click remedy, and the missing refresh grant", () => {
		// A DCR+S256 server is now connectable (#180/#258), so the message points at the Connect
		// button rather than describing a gap — but it still warns that this particular server issues
		// no refresh token, because authorizing it does not make it survivable in a cron-fired chain.
		const msg = authFailureGuidance(401, discovered);
		expect(msg).toContain("rejected the credential");
		expect(msg).toContain("https://agent.freewebstore.online");
		expect(msg).toContain("Connect");
		expect(msg).toContain("no refresh token");
	});

	it("says PKCE S256 is the blocker when a DCR server offers only plain", () => {
		// Refusing to authorize as a public client without S256 is deliberate: a `plain` challenge
		// equals its verifier. The user must be told that, not left reading "Connect" on a button
		// the server will not honour.
		const msg = authFailureGuidance(401, { ...discovered, pkceS256: false, unattended: "refresh" });
		expect(msg).toContain("PKCE S256");
		expect(msg).not.toContain("Connect it under");
	});

	it("points at the stored token when the server publishes no OAuth metadata", () => {
		const msg = authFailureGuidance(403, { protected: false });
		expect(msg).toContain("no OAuth metadata");
		expect(msg).toContain("mcp");
	});

	it("says the client must be pre-registered when the server offers no DCR", () => {
		const msg = authFailureGuidance(401, { ...discovered, dcr: false, unattended: "refresh" });
		expect(msg).toContain("pre-registered");
		expect(msg).not.toContain("no refresh token");
	});
});
