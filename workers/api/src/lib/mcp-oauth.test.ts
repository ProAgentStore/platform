import { describe, expect, it } from "vitest";
import { signConnectorState, verifyConnectorState } from "./connector-oauth.js";
import { getConnector } from "./connectors/registry.js";
import {
	buildAuthorizeUrl,
	codeChallengeS256,
	expiresAtFrom,
	needsRefresh,
	newCodeVerifier,
	parseTokenResponse,
	signMcpOauthState,
	verifyMcpOauthState,
	MCP_OAUTH_STATE_TYPE,
} from "./mcp-oauth.js";

const KEY = "test-signing-key";
const NONCE = "a".repeat(32);
const soon = () => Math.floor(Date.now() / 1000) + 600;

describe("PKCE", () => {
	it("produces the RFC 7636 §B challenge for the RFC's own verifier", async () => {
		// A known-answer test, not a round trip: a challenge computed with the wrong encoding
		// (base64 rather than base64url, or hex) still round-trips against itself and fails only
		// at the far end, as an opaque `invalid_grant` from a server that will not say why.
		expect(await codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
	});

	it("mints verifiers in the RFC's length range, and never the same one twice", () => {
		const a = newCodeVerifier();
		const b = newCodeVerifier();
		// A verifier shorter than 43 chars is rejected outright by conforming servers; a repeated
		// one would mean the whole exchange is protected by a value an earlier flow already leaked.
		expect(a.length).toBeGreaterThanOrEqual(43);
		expect(a.length).toBeLessThanOrEqual(128);
		expect(a).not.toBe(b);
		expect(a).toMatch(/^[A-Za-z0-9\-_]+$/);
	});
});

describe("state pinning — the callback's only evidence", () => {
	it("round-trips the uid, flow id and resource", async () => {
		const state = await signMcpOauthState({ uid: "u1", flowId: "f1", resource: "https://a.example/mcp" }, soon(), KEY, NONCE);
		expect(await verifyMcpOauthState(state, KEY, NONCE)).toEqual({ uid: "u1", flowId: "f1", resource: "https://a.example/mcp" });
	});

	it("refuses when the completing browser has no matching nonce", async () => {
		// Without the browser binding a signed state is bearer-grade: an attacker starts the flow,
		// sends the consent link to a victim, and the VICTIM's grant is filed under the attacker's
		// account. See lib/oauth-nonce.ts for the full shape.
		const state = await signMcpOauthState({ uid: "u1", flowId: "f1", resource: "https://a.example/mcp" }, soon(), KEY, NONCE);
		expect(await verifyMcpOauthState(state, KEY, null)).toBeNull();
		expect(await verifyMcpOauthState(state, KEY, "b".repeat(32))).toBeNull();
	});

	it("refuses a tampered payload, a wrong key and an expired state", async () => {
		const state = await signMcpOauthState({ uid: "u1", flowId: "f1", resource: "https://a.example/mcp" }, soon(), KEY, NONCE);
		const [payload, sig] = state.split(".");
		// Re-signing is impossible without the key, so a swapped uid must fail the signature check
		// rather than quietly credit a different account.
		expect(await verifyMcpOauthState(`${payload}x.${sig}`, KEY, NONCE)).toBeNull();
		expect(await verifyMcpOauthState(state, "other-key", NONCE)).toBeNull();
		const stale = await signMcpOauthState({ uid: "u1", flowId: "f1", resource: "https://a.example/mcp" }, Math.floor(Date.now() / 1000) - 1, KEY, NONCE);
		expect(await verifyMcpOauthState(stale, KEY, NONCE)).toBeNull();
	});

	it("carries the resource, so a state cannot be moved between MCP servers", async () => {
		// THE trap this pin exists for. The operator of any server a user connects sees the state in
		// their own authorize request. A state proving only "u1 started an MCP flow" would let them
		// drive our callback with it; the resource claim is what the route compares against the flow
		// row, so a state minted for server A can never complete — or write a credential for —
		// server B.
		const state = await signMcpOauthState({ uid: "u1", flowId: "f1", resource: "https://evil.example/mcp" }, soon(), KEY, NONCE);
		const claims = await verifyMcpOauthState(state, KEY, NONCE);
		expect(claims?.resource).toBe("https://evil.example/mcp");
		expect(claims?.resource).not.toBe("https://good.example/mcp");
	});

	it("refuses a state that omits the flow or resource pin", async () => {
		// Hand-forge a validly-signed payload missing the pins — i.e. what a state minted before
		// these pins existed looks like. It must fail closed rather than be grandfathered, since
		// honouring it would leave the hole open for the state's whole TTL.
		const forge = async (extra: Record<string, unknown>) => {
			const body = { uid: "u1", exp: soon(), n: NONCE, p: MCP_OAUTH_STATE_TYPE, ...extra };
			const enc = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
			const payload = enc(new TextEncoder().encode(JSON.stringify(body)));
			const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
			const sig = enc(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))));
			return `${payload}.${sig}`;
		};
		expect(await verifyMcpOauthState(await forge({ r: "https://a.example/mcp" }), KEY, NONCE)).toBeNull(); // no flow id
		expect(await verifyMcpOauthState(await forge({ f: "f1" }), KEY, NONCE)).toBeNull(); // no resource
		expect(await verifyMcpOauthState(await forge({ f: "f1", r: "https://a.example/mcp" }), KEY, NONCE)).not.toBeNull();
	});

	it("does not interoperate with connector states signed by the same key", async () => {
		// SESSION_SIGNING_KEY signs account sessions, connector states and these. A payload without
		// a type pin is a payload some other verifier accepts: without `p` a state minted at a
		// Drive/Gmail start would be honoured by this callback and file an MCP credential from a
		// flow that consented to something else entirely.
		const connectorState = await signConnectorState("u1", soon(), KEY, { nonce: NONCE, provider: "drive" });
		expect(await verifyMcpOauthState(connectorState, KEY, NONCE)).toBeNull();

		// The reverse direction: a connector callback keyed on its own id can never see one of ours,
		// because `verifyConnectorState` requires `p === <connector id>` and no connector is named
		// after this flow type. That second half is a fact about the registry, so assert it — if a
		// connector with this id is ever added, the two state families become interchangeable and
		// this test is the thing that says so.
		const mcpState = await signMcpOauthState({ uid: "u1", flowId: "f1", resource: "https://a.example/mcp" }, soon(), KEY, NONCE);
		expect(await verifyConnectorState(mcpState, KEY, { cookieNonce: NONCE, provider: "drive" })).toBeNull();
		expect(getConnector(MCP_OAUTH_STATE_TYPE)).toBeUndefined();
	});
});

describe("authorize URL", () => {
	it("sends S256, the resource indicator and the exact redirect", () => {
		const url = new URL(
			buildAuthorizeUrl({
				authorizationEndpoint: "https://as.example/authorize",
				clientId: "cid",
				redirectUri: "https://api.example/v1/mcp/oauth/callback",
				codeChallenge: "chal",
				state: "st",
				scope: "read",
				resource: "https://a.example/mcp",
			}),
		);
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("code_challenge")).toBe("chal");
		// RFC 8707: without it a server that honours resource indicators cannot bind the token to
		// the MCP endpoint we asked for, which is what stops a token being replayed at another.
		expect(url.searchParams.get("resource")).toBe("https://a.example/mcp");
		expect(url.searchParams.get("redirect_uri")).toBe("https://api.example/v1/mcp/oauth/callback");
		expect(url.searchParams.get("response_type")).toBe("code");
	});

	it("omits scope entirely when none was requested", () => {
		// An empty `scope=` is not the same as no scope: several servers read it as "grant nothing"
		// and issue a token that authenticates but authorizes nothing.
		const url = new URL(
			buildAuthorizeUrl({ authorizationEndpoint: "https://as.example/authorize", clientId: "c", redirectUri: "https://r/cb", codeChallenge: "x", state: "s", resource: "https://a.example/mcp" }),
		);
		expect(url.searchParams.has("scope")).toBe(false);
	});
});

describe("token responses", () => {
	it("keeps the refresh token and converts expires_in to an instant", () => {
		const now = Date.parse("2026-01-01T00:00:00.000Z");
		expect(parseTokenResponse({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "read" }, now)).toEqual({
			accessToken: "at",
			refreshToken: "rt",
			expiresAt: "2026-01-01T01:00:00.000Z",
			scope: "read",
		});
	});

	it("rejects a response with no access token", () => {
		// A 200 with an error body would otherwise be stored as a credential whose token is
		// "undefined", and every later call would fail with a 401 about the wrong thing.
		expect(parseTokenResponse({ error: "invalid_grant" })).toBeNull();
		expect(parseTokenResponse(null)).toBeNull();
		expect(parseTokenResponse("nope")).toBeNull();
	});

	it("drops an unusable expires_in rather than inventing one", () => {
		// A wrong expiry is worse than none: too short refuses a working credential, too long keeps
		// a dead one and turns every call into an unexplained 401.
		expect(expiresAtFrom("not-a-number")).toBeNull();
		expect(expiresAtFrom(0)).toBeNull();
		expect(expiresAtFrom(-5)).toBeNull();
		expect(expiresAtFrom(60 * 60 * 24 * 500)).toBeNull();
		expect(expiresAtFrom("3600", Date.parse("2026-01-01T00:00:00.000Z"))).toBe("2026-01-01T01:00:00.000Z");
	});

	it("renews inside the skew, not at the instant of death", () => {
		const now = Date.parse("2026-01-01T00:00:00.000Z");
		// A token still valid when we read it can be dead by the time the MCP server checks it.
		expect(needsRefresh(new Date(now + 30_000).toISOString(), now)).toBe(true);
		expect(needsRefresh(new Date(now + 600_000).toISOString(), now)).toBe(false);
		// No expiry = a pasted machine token: nothing to renew, and claiming otherwise would send
		// every call through a pointless refresh attempt.
		expect(needsRefresh(null, now)).toBe(false);
		expect(needsRefresh("not-a-date", now)).toBe(false);
	});
});
