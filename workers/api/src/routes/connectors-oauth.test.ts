import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// A test oauth connector, returned by the mocked registry for id "slack".
const SLACK_CONNECTOR = {
	id: "slack",
	label: "Slack",
	auth: "oauth" as const,
	scopes: { read: true, write: true },
	grantModel: "user" as const,
	oauth: {
		authUrl: "https://slack.com/oauth/v2/authorize",
		tokenUrl: "https://slack.com/api/oauth.v2.access",
		scopes: ["chat:write", "channels:read"],
		clientIdEnv: "SLACK_CLIENT_ID",
		secretEnv: "SLACK_CLIENT_SECRET",
	},
	tools: [],
};

const { getConnector, saveConnectorRefreshToken } = vi.hoisted(() => ({
	getConnector: vi.fn(),
	saveConnectorRefreshToken: vi.fn(),
}));

vi.mock("../lib/connectors/registry.js", () => ({ getConnector, connectorTools: () => [] }));
vi.mock("../lib/session.js", () => ({ verifySession: async (t: string) => (t ? { uid: "u1", roles: [] } : null) }));
vi.mock("../lib/connector-oauth.js", () => ({
	signConnectorState: async () => "SIGNED_STATE",
	verifyConnectorState: async (s: string) => (s === "SIGNED_STATE" ? "u1" : null),
	saveConnectorRefreshToken,
}));

import { Hono } from "hono";
import { connectorRoutes } from "./connectors.js";
import { resolveOauthConfig } from "../lib/connectors/client.js";
import { HttpError } from "../lib/auth.js";
import type { Env } from "../types.js";

// Mount on an app with the same HttpError→status mapping the real index.ts applies, so a
// thrown HttpError(401/404/503) surfaces as its status instead of an unhandled 500.
const app = new Hono<{ Bindings: Env }>();
app.route("/", connectorRoutes);
app.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message }, err.status as 400) : c.json({ error: "ise" }, 500)));

const env = () =>
	({
		SESSION_SIGNING_KEY: "k",
		KEY_ENCRYPTION_KEY: "kek",
		SLACK_CLIENT_ID: "cid-123",
		SLACK_CLIENT_SECRET: "secret-xyz",
		DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({}) }) }) },
	}) as unknown as Env;

const authed = { headers: { Authorization: "Bearer tok" } };

beforeEach(() => {
	getConnector.mockReset();
	getConnector.mockImplementation((id: string) => (id === "slack" ? SLACK_CONNECTOR : undefined));
	saveConnectorRefreshToken.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("resolveOauthConfig", () => {
	it("reads client id/secret from the manifest-named env vars + tokenUrl", () => {
		expect(resolveOauthConfig(env(), "slack")).toEqual({ clientId: "cid-123", clientSecret: "secret-xyz", tokenUrl: "https://slack.com/api/oauth.v2.access" });
	});
	it("returns {} for an unknown / non-oauth connector", () => {
		expect(resolveOauthConfig(env(), "nope")).toEqual({});
	});
	it("keeps the hardcoded google_drive fallback", () => {
		const e = { GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "gs" } as unknown as Env;
		expect(resolveOauthConfig(e, "google_drive")).toMatchObject({ clientId: "g", clientSecret: "gs", tokenUrl: "https://oauth2.googleapis.com/token" });
	});
});

describe("GET /:id/oauth/start", () => {
	it("builds the provider authorize URL with client_id, redirect, scope, state", async () => {
		const res = await app.request("/slack/oauth/start", authed, env());
		expect(res.status).toBe(200);
		const { url } = (await res.json()) as { url: string };
		const u = new URL(url);
		expect(u.origin + u.pathname).toBe("https://slack.com/oauth/v2/authorize");
		expect(u.searchParams.get("client_id")).toBe("cid-123");
		expect(u.searchParams.get("redirect_uri")).toContain("/v1/connectors/slack/oauth/callback");
		expect(u.searchParams.get("scope")).toBe("chat:write channels:read");
		expect(u.searchParams.get("state")).toBe("SIGNED_STATE");
		expect(u.searchParams.get("response_type")).toBe("code");
	});
	it("401 without a session", async () => {
		const res = await app.request("/slack/oauth/start", {}, env());
		expect(res.status).toBe(401);
	});
	it("404 for a non-oauth / unknown connector", async () => {
		const res = await app.request("/nope/oauth/start", authed, env());
		expect(res.status).toBe(404);
	});
	it("503 when the connector's credentials aren't wired", async () => {
		const e = { ...env(), SLACK_CLIENT_ID: undefined, SLACK_CLIENT_SECRET: undefined } as unknown as Env;
		const res = await app.request("/slack/oauth/start", authed, e);
		expect(res.status).toBe(503);
	});
});

describe("GET /:id/oauth/callback", () => {
	it("exchanges the code and stores the refresh token", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ refresh_token: "RT-1", access_token: "AT" }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const res = await app.request("/slack/oauth/callback?code=CODE&state=SIGNED_STATE", {}, env());
		expect(res.status).toBe(200);
		const [tokenUrl, init] = fetchMock.mock.calls[0];
		expect(tokenUrl).toBe("https://slack.com/api/oauth.v2.access");
		expect(String((init as RequestInit).body)).toContain("grant_type=authorization_code");
		expect(saveConnectorRefreshToken).toHaveBeenCalledWith(expect.anything(), { userId: "u1", provider: "slack", refreshToken: "RT-1" });
	});
	it("400 on missing code/state", async () => {
		const res = await app.request("/slack/oauth/callback?code=CODE", {}, env());
		expect(res.status).toBe(400);
		expect(saveConnectorRefreshToken).not.toHaveBeenCalled();
	});
	it("400 on an invalid/expired state (no token stored)", async () => {
		vi.stubGlobal("fetch", vi.fn());
		const res = await app.request("/slack/oauth/callback?code=CODE&state=BAD", {}, env());
		expect(res.status).toBe(400);
		expect(saveConnectorRefreshToken).not.toHaveBeenCalled();
	});
	it("400 when the provider returns no refresh token", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: "AT" }), { status: 200 })));
		const res = await app.request("/slack/oauth/callback?code=CODE&state=SIGNED_STATE", {}, env());
		expect(res.status).toBe(400);
		expect(saveConnectorRefreshToken).not.toHaveBeenCalled();
	});
});
