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

const { getConnector, saveConnectorRefreshToken, CONNECTORS } = vi.hoisted(() => ({
	getConnector: vi.fn(),
	saveConnectorRefreshToken: vi.fn(),
	// Mutable so a test can decide what the catalog holds; GET /v1/connectors reads it.
	CONNECTORS: [] as Array<Record<string, unknown>>,
}));

vi.mock("../lib/connectors/registry.js", () => ({ getConnector, connectorTools: () => [], CONNECTORS }));
vi.mock("../lib/session.js", () => ({ verifySession: async (t: string) => (t ? { uid: "u1", roles: [] } : null) }));
vi.mock("../lib/connector-oauth.js", () => ({
	signConnectorState: async () => "SIGNED_STATE",
	verifyConnectorState: async (s: string) => (s === "SIGNED_STATE" ? "u1" : null),
	saveConnectorRefreshToken,
}));

import { Hono } from "hono";
import { connectorRoutes } from "./connectors.js";
import { resolveOauthConfig } from "../lib/connectors/client.js";
// The REAL declarations (#352 Stage 1) — not a fixture. Their whole claim is that a hand-written
// flow and the generic one resolve the same credentials, which a copied fixture could not test.
import { GOOGLE_DRIVE_CONNECTOR, ZOHO_WORKDRIVE_CONNECTOR } from "../lib/connectors/connected-accounts.js";
import { GMAIL_CONNECTOR } from "../lib/connectors/gmail.js";
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

const DECLARED = [SLACK_CONNECTOR, GOOGLE_DRIVE_CONNECTOR, ZOHO_WORKDRIVE_CONNECTOR, GMAIL_CONNECTOR];

beforeEach(() => {
	getConnector.mockReset();
	getConnector.mockImplementation((id: string) => DECLARED.find((c) => c.id === id));
	saveConnectorRefreshToken.mockReset();
	CONNECTORS.length = 0;
	CONNECTORS.push(...(DECLARED as unknown as Array<Record<string, unknown>>));
});
afterEach(() => vi.unstubAllGlobals());

describe("resolveOauthConfig", () => {
	it("reads client id/secret from the manifest-named env vars + tokenUrl", () => {
		expect(resolveOauthConfig(env(), "slack")).toEqual({ clientId: "cid-123", clientSecret: "secret-xyz", tokenUrl: "https://slack.com/api/oauth.v2.access" });
	});
	it("returns {} for an unknown / non-oauth connector", () => {
		expect(resolveOauthConfig(env(), "nope")).toEqual({});
	});
	// google_drive used to be resolved by a hardcoded branch in client.ts — the one OAuth
	// connector outside the registry. It is declared now (#352 Stage 1) and resolves through the
	// same path as any other, from its own `oauth` block. The branch was deleted rather than kept
	// as a fallback: two answers for one connector is what the declaration exists to remove.
	it("resolves google_drive from its declaration, with no special case left", () => {
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

// #352 Stage 1. Before this there was no way to ask the platform which connectors exist — the
// registry has been the single source of truth since #86 but only from inside the Worker, so five
// consumers each kept their own list. This is the answer they can derive from.
describe("GET /v1/connectors — the catalog, resolved for the caller", () => {
	/**
	 * A DB whose user_api_keys holds a row for each named provider, and whose
	 * instance_connector_grants answers the grant roll-up.
	 *
	 * SQL-aware on purpose: the route now makes two different reads, and a stub that answers both
	 * with the same rows would let a mistake in either one pass.
	 */
	const envWithKeys = (providers: string[], grants: Array<{ provider: string; grants: number; instances: number }> = []) =>
		({
			...env(),
			DB: {
				prepare: (sql: string) => ({
					bind: () => ({
						first: async () => null,
						run: async () => ({}),
						all: async () => ({
							results: sql.includes("instance_connector_grants")
								? grants
								: providers.map((p) => ({ provider: p, created_at: "2026-08-07T00:00:00Z", account_label: `${p}@example.com` })),
						}),
					}),
				}),
			},
		}) as unknown as Env;

	const list = async (e: Env) => {
		const res = await app.request("/", authed, e);
		expect(res.status).toBe(200);
		const { connectors } = (await res.json()) as { connectors: Array<Record<string, unknown>> };
		return new Map(connectors.map((c) => [c.id as string, c]));
	};

	it("returns every declared connector, not a hand-kept subset", async () => {
		const by = await list(envWithKeys([]));
		expect([...by.keys()].sort()).toEqual(["gmail", "google_drive", "slack", "zoho_workdrive"]);
	});

	it("reports the caller's connection from the same vault row the token mint reads", async () => {
		const by = await list(envWithKeys(["google_drive"]));
		expect(by.get("google_drive")).toMatchObject({ connected: true, account: "google_drive@example.com" });
		expect(by.get("zoho_workdrive")).toMatchObject({ connected: false, account: null });
	});

	it("separates 'this deployment cannot' from 'you have not' — the #353 distinction", async () => {
		// Slack's client id/secret ARE wired in env(); Google's are not.
		const by = await list(envWithKeys([]));
		expect(by.get("slack")).toMatchObject({ configured: true, connected: false });
		expect(by.get("gmail")).toMatchObject({ configured: false, connected: false });
	});

	it("carries the reach model, so a consumer knows Drive is grant-scoped and Gmail is not", async () => {
		const by = await list(envWithKeys([]));
		expect(by.get("google_drive")).toMatchObject({ grantModel: "instance-resource", scopes: { read: true, write: false } });
		expect(by.get("gmail")).toMatchObject({ grantModel: "user" });
	});

	it("reports the file accounts as tool-less — declaring them grants no agent anything", async () => {
		const by = await list(envWithKeys([]));
		for (const id of ["google_drive", "zoho_workdrive"]) expect(by.get(id)).toMatchObject({ tools: [] });
	});

	// Gmail was in the list above until #711. The catalog is where an owner reads what a
	// connector can do, so the moment it gained tools this assertion had to say so out loud
	// rather than be dropped for being inconvenient.
	it("reports Gmail's declared read tools in the catalog (#711)", async () => {
		const by = await list(envWithKeys([]));
		expect(by.get("gmail")).toMatchObject({
			tools: ["gmail_search", "gmail_read_message", "gmail_download_attachment"],
		});
	});

	// #355: the account page shows connect/disconnect for every connector at once, so what a
	// disconnect destroys has to arrive with the list rather than one confirmation at a time.
	it("carries what a disconnect would revoke, per grant-holding connector", async () => {
		const by = await list(envWithKeys(["google_drive"], [{ provider: "google_drive", grants: 5, instances: 2 }]));
		expect(by.get("google_drive")).toMatchObject({ reach: { grants: 5, instances: 2 } });
		// Declared and grant-scoped, just not granted anywhere — zero, not absent.
		expect(by.get("zoho_workdrive")).toMatchObject({ reach: { grants: 0, instances: 0 } });
	});

	it("reports no reach for a connector whose reach is not grants", async () => {
		const by = await list(envWithKeys([], [{ provider: "google_drive", grants: 5, instances: 2 }]));
		// Gmail's reach is the per-agent permission flag, not a grant row. `{grants:0}` would be a
		// lie shaped like a fact.
		expect(by.get("gmail")).toMatchObject({ reach: null });
		expect(by.get("slack")).toMatchObject({ reach: null });
	});

	// The console renders connect/disconnect from this, so a connector whose flow is not named
	// here has no buttons — which is the honest outcome for one that cannot be connected.
	it("names the LIVE connect/disconnect flow, dedicated or generic", async () => {
		const by = await list(envWithKeys([]));
		expect(by.get("google_drive")).toMatchObject({ flow: { start: "/v1/drive/google/start", disconnect: "/v1/drive/google" } });
		expect(by.get("gmail")).toMatchObject({ flow: { start: "/v1/email/google/start", disconnect: "/v1/email/google" } });
		expect(by.get("zoho_workdrive")).toMatchObject({ flow: { start: "/v1/workdrive/zoho/start", disconnect: "/v1/workdrive/zoho" } });
		// Nothing dedicated: the generic routes, which its manifest CAN drive.
		expect(by.get("slack")).toMatchObject({ flow: { start: "/v1/connectors/slack/oauth/start", disconnect: "/v1/connectors/slack/oauth" } });
	});

	// WorkDrive declares no `oauth` block (its endpoints are per data-centre), so the manifest
	// route could not tell whether the deployment can connect it — and said "no" while
	// /v1/workdrive/status said "yes". Two answers to one question is the bug the catalog exists
	// to remove.
	it("judges a connector on its declared credential env when the manifest cannot say", async () => {
		const by = await list(envWithKeys([]));
		expect(by.get("zoho_workdrive")).toMatchObject({ configured: false });
		const wired = { ...envWithKeys([]), ZOHO_CLIENT_ID: "zid", ZOHO_CLIENT_SECRET: "zsec" } as unknown as Env;
		const byWired = await list(wired);
		expect(byWired.get("zoho_workdrive")).toMatchObject({ configured: true });
	});
});
