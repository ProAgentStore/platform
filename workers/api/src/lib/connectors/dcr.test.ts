import { describe, expect, it, vi } from "vitest";
import { clientMetadata, DcrError, parseClientRegistration, registerClient } from "./dcr.js";

const REDIRECT = "https://api.example/v1/mcp/oauth/callback";

const jsonRes = (body: unknown, status = 201) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("client metadata (RFC 7591 request)", () => {
	it("registers as a public client and asks for the refresh grant", () => {
		const md = clientMetadata({ registrationEndpoint: "https://as.example/register", redirectUri: REDIRECT });
		// `none` is what makes this work at all: there is no secret to put in operator env for a
		// server the operator has never heard of, which is the whole reason this flow exists.
		expect(md.token_endpoint_auth_method).toBe("none");
		// Several servers decide at REGISTRATION time whether a client may ever refresh. Omitting
		// it here is how a client silently ends up interactive-only against a server that supports
		// refresh — a 24h credential that dies in every cron-fired chain.
		expect(md.grant_types).toEqual(["authorization_code", "refresh_token"]);
		expect(md.redirect_uris).toEqual([REDIRECT]);
	});

	it("omits scope when none is requested", () => {
		// An empty `scope` is read by some servers as "grant nothing", producing a token that
		// authenticates and authorizes nothing — a failure that only shows up at the first call.
		expect(clientMetadata({ registrationEndpoint: "https://as.example/register", redirectUri: REDIRECT }).scope).toBeUndefined();
		expect(clientMetadata({ registrationEndpoint: "https://as.example/register", redirectUri: REDIRECT, scope: "read" }).scope).toBe("read");
	});
});

describe("parsing a registration response", () => {
	it("keeps a client_secret when the server issues one anyway", () => {
		// We ask to be a public client, but a server may still return a secret. Discarding it would
		// make every later token request fail with `invalid_client` at a server that is behaving
		// correctly.
		expect(parseClientRegistration({ client_id: "cid", client_secret: "sec" }, REDIRECT)).toEqual({ clientId: "cid", clientSecret: "sec", redirectUri: REDIRECT });
	});

	it("treats a response with no client_id as no registration", () => {
		// Otherwise we build an authorize URL with `client_id=undefined` and the user meets an
		// error at the far end about the wrong thing entirely.
		expect(parseClientRegistration({ client_secret: "sec" }, REDIRECT)).toBeNull();
		expect(parseClientRegistration({ client_id: "   " }, REDIRECT)).toBeNull();
		expect(parseClientRegistration(null, REDIRECT)).toBeNull();
		expect(parseClientRegistration([{ client_id: "cid" }], REDIRECT)).toBeNull();
	});
});

describe("registerClient", () => {
	it("posts the metadata and returns the registration", async () => {
		const fetchImpl = vi.fn(async () => jsonRes({ client_id: "cid-1" }));
		const reg = await registerClient({ registrationEndpoint: "https://as.example/register", redirectUri: REDIRECT }, fetchImpl);
		expect(reg).toEqual({ clientId: "cid-1", clientSecret: null, redirectUri: REDIRECT });
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://as.example/register");
		expect(init.method).toBe("POST");
		expect(JSON.parse(String(init.body)).redirect_uris).toEqual([REDIRECT]);
	});

	it("carries the server's own refusal text, not a generic failure", async () => {
		// A registration refusal is the one message that says WHY (unregistered redirect, closed
		// registration, rate limit). Swallowing it leaves the user guessing at a server we cannot
		// see either.
		const fetchImpl = vi.fn(async () => new Response('{"error":"invalid_redirect_uri"}', { status: 400 }));
		await expect(registerClient({ registrationEndpoint: "https://as.example/register", redirectUri: REDIRECT }, fetchImpl)).rejects.toThrow(/invalid_redirect_uri/);
		await expect(registerClient({ registrationEndpoint: "https://as.example/register", redirectUri: REDIRECT }, fetchImpl)).rejects.toBeInstanceOf(DcrError);
	});

	it("rejects a non-JSON body and a JSON body with no client_id", async () => {
		const html = vi.fn(async () => new Response("<html>proxy error</html>", { status: 200 }));
		await expect(registerClient({ registrationEndpoint: "https://as.example/register", redirectUri: REDIRECT }, html)).rejects.toThrow(/not JSON/);
		const empty = vi.fn(async () => jsonRes({ ok: true }));
		await expect(registerClient({ registrationEndpoint: "https://as.example/register", redirectUri: REDIRECT }, empty)).rejects.toThrow(/no client_id/);
	});
});
