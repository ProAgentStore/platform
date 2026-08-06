import { describe, expect, it, vi, beforeEach } from "vitest";

const { discoverAuthServer, safeFetch } = vi.hoisted(() => ({ discoverAuthServer: vi.fn(), safeFetch: vi.fn() }));
vi.mock("../lib/connectors/discovery.js", () => ({ discoverAuthServer }));
vi.mock("../lib/ssrf.js", () => ({ safeFetch, SsrfError: class SsrfError extends Error {} }));
vi.mock("../lib/session.js", () => ({ verifySession: async (t: string) => (t ? { uid: "u1", roles: [] } : null) }));
vi.mock("../lib/connectors/dcr.js", () => ({
	registerClient: vi.fn(async (input: { redirectUri: string }) => ({ clientId: "cid-1", clientSecret: null, redirectUri: input.redirectUri })),
	DcrError: class DcrError extends Error {},
}));

import { Hono } from "hono";
import { mcpRoutes } from "./mcp.js";
import { HttpError } from "../lib/auth.js";
import { signMcpOauthState } from "../lib/mcp-oauth.js";
import type { Env } from "../types.js";

const app = new Hono<{ Bindings: Env }>();
app.route("/v1/mcp", mcpRoutes);
app.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message }, err.status as 400) : c.json({ error: String(err) }, 500)));

const KEK = "1".repeat(64);
const ENDPOINT = "https://a.example/mcp";
const authed = { headers: { Authorization: "Bearer tok" } };

/** Minimal in-memory D1 for the three tables the flow touches. */
function fakeDb() {
	const tables = { clients: new Map<string, Record<string, unknown>>(), flows: new Map<string, Record<string, unknown>>(), creds: new Map<string, Record<string, unknown>>() };
	const k = (a: unknown, b: unknown) => `${String(a)} ${String(b)}`;
	const prepare = (sql: string) => {
		let a: unknown[] = [];
		const stmt = {
			bind(...args: unknown[]) {
				a = args;
				return stmt;
			},
			async run() {
				if (sql.includes("INSERT INTO mcp_oauth_clients")) tables.clients.set(k(a[0], a[1]), { user_id: a[0], issuer: a[1], client_id: a[2], redirect_uri: a[3], secret_ciphertext: null, secret_dek_wrapped: null, secret_iv: null });
				else if (sql.includes("INSERT INTO mcp_oauth_flows"))
					tables.flows.set(String(a[0]), {
						id: a[0], user_id: a[1], endpoint: a[2], issuer: a[3], token_endpoint: a[4], client_id: a[5], redirect_uri: a[6], scope: a[7],
						verifier_ciphertext: a[8], verifier_dek_wrapped: a[9], verifier_iv: a[10], expires_at: a[11],
					});
				else if (sql.includes("INSERT INTO mcp_credentials")) tables.creds.set(k(a[0], a[1]), { user_id: a[0], endpoint: a[1], auth_mode: a[2], issuer: a[3] });
				return {};
			},
			async first<T>(): Promise<T | null> {
				if (sql.includes("FROM mcp_oauth_clients")) return (tables.clients.get(k(a[0], a[1])) ?? null) as T | null;
				if (sql.includes("DELETE FROM mcp_oauth_flows") && sql.includes("RETURNING")) {
					const f = tables.flows.get(String(a[0]));
					if (!f || f.user_id !== a[1] || Date.parse(String(f.expires_at)) <= Date.now()) return null;
					tables.flows.delete(String(a[0]));
					return f as T;
				}
				return null;
			},
			async all<T>() {
				return { results: [] as T[] };
			},
		};
		return stmt;
	};
	return { db: { prepare } as unknown as Env["DB"], tables };
}

let db = fakeDb();
const env = (extra: Partial<Env> = {}) => ({ DB: db.db, KEY_ENCRYPTION_KEY: KEK, SESSION_SIGNING_KEY: "sign-key", ...extra }) as Env;

const PROTECTED = {
	protected: true,
	authorizationServer: "https://as.example",
	metadata: { issuer: "https://as.example", authorizationEndpoint: "https://as.example/authorize", tokenEndpoint: "https://as.example/token", registrationEndpoint: "https://as.example/register", grantTypes: ["authorization_code", "refresh_token"], codeChallengeMethods: ["S256"], tokenEndpointAuthMethods: ["none"] },
	dcr: true,
	pkceS256: true,
	unattended: "refresh",
};

beforeEach(() => {
	db = fakeDb();
	discoverAuthServer.mockReset();
	discoverAuthServer.mockResolvedValue(PROTECTED);
	safeFetch.mockReset();
	safeFetch.mockResolvedValue(new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }), { status: 200, headers: { "Content-Type": "application/json" } }));
});

/** Run a start, returning the authorize URL, the state it carries and the bind cookie. */
async function start(url = ENDPOINT) {
	const res = await app.request("/v1/mcp/oauth/start", { method: "POST", body: JSON.stringify({ url }), ...authed }, env());
	const body = (await res.json()) as { url?: string; error?: string };
	const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0];
	const state = body.url ? new URL(body.url).searchParams.get("state") : null;
	return { res, body, cookie, state };
}

describe("POST /v1/mcp/oauth/start", () => {
	it("returns a PKCE S256 authorize URL and binds it to this browser", async () => {
		const { res, body, cookie, state } = await start();
		expect(res.status).toBe(200);
		const u = new URL(body.url!);
		expect(u.origin + u.pathname).toBe("https://as.example/authorize");
		expect(u.searchParams.get("code_challenge_method")).toBe("S256");
		expect(u.searchParams.get("client_id")).toBe("cid-1");
		expect(u.searchParams.get("resource")).toBe(ENDPOINT);
		expect(state).toBeTruthy();
		// The nonce cookie is what stops an attacker's consent link, clicked by a victim, filing the
		// victim's grant under the attacker's account.
		expect(cookie).toMatch(/^pags_oauth_bind_mcp_oauth=/);
		expect(res.headers.get("Set-Cookie")).toContain("HttpOnly");
	});

	it("refuses a server that publishes no OAuth metadata", async () => {
		// There is nothing to authorize against; the honest remedy is a stored token, and pretending
		// otherwise would send the user to a flow that cannot start.
		discoverAuthServer.mockResolvedValue({ protected: false });
		const { res } = await start();
		expect(res.status).toBe(400);
	});

	it("refuses a server that will not register clients dynamically", async () => {
		discoverAuthServer.mockResolvedValue({ ...PROTECTED, dcr: true, metadata: { ...PROTECTED.metadata, registrationEndpoint: undefined } });
		const { res, body } = await start();
		expect(res.status).toBe(400);
		expect(body.error).toMatch(/dynamic client registration/i);
	});

	it("refuses a server without PKCE S256 rather than falling back to plain", async () => {
		// A `plain` challenge equals its verifier, so anyone who sees the authorize request has
		// both — it protects nothing, and accepting it would silently weaken every connection.
		discoverAuthServer.mockResolvedValue({ ...PROTECTED, pkceS256: false, metadata: { ...PROTECTED.metadata, codeChallengeMethods: ["plain"] } });
		const { res, body } = await start();
		expect(res.status).toBe(400);
		expect(body.error).toMatch(/S256/);
	});

	it("refuses metadata whose issuer is not the server that published it", async () => {
		// The RFC 8414 mix-up: a resource points our authorize and token requests at a third party
		// while the user believes they are connecting the server they named.
		discoverAuthServer.mockResolvedValue({ ...PROTECTED, metadata: { ...PROTECTED.metadata, issuer: "https://someone-else.example" } });
		const { res, body } = await start();
		expect(res.status).toBe(400);
		expect(body.error).toMatch(/different issuer/i);
	});

	it("refuses anything that is not an https MCP endpoint", async () => {
		expect((await start("http://a.example/mcp")).res.status).toBe(400);
		expect((await start("not a url")).res.status).toBe(400);
	});
});

describe("GET /v1/mcp/oauth/callback", () => {
	const complete = (state: string, cookie: string, code = "the-code") =>
		app.request(`/v1/mcp/oauth/callback?code=${code}&state=${encodeURIComponent(state)}`, { headers: { cookie } }, env());

	it("completes the flow and stores the credential under that endpoint", async () => {
		const { state, cookie } = await start();
		const res = await complete(state!, cookie);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("Connected");
		expect(db.tables.creds.get(`u1 ${ENDPOINT}`)).toMatchObject({ auth_mode: "oauth" });
	});

	it("refuses a state minted for a DIFFERENT server — the replay this pin exists for", async () => {
		// The operator of any server a user connects sees the state in their own authorize request.
		// If it proved only "u1 started an MCP flow", they could drive this callback with it and have
		// their code exchanged — or their token stored — against someone else's endpoint. The state
		// names the resource, and it must agree with the flow row.
		const { state, cookie } = await start();
		const flowId = [...db.tables.flows.keys()][0] ?? "unknown";
		const nonce = cookie.split("=")[1];
		const forged = await signMcpOauthState({ uid: "u1", flowId, resource: "https://evil.example/mcp" }, Math.floor(Date.now() / 1000) + 600, "sign-key", nonce);
		const res = await complete(forged, cookie);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("started for a different server");
		expect(db.tables.creds.size).toBe(0);
		expect(safeFetch).not.toHaveBeenCalled(); // nothing was exchanged anywhere
		expect(state).toBeTruthy();
	});

	it("refuses when the completing browser holds no bind cookie", async () => {
		const { state } = await start();
		const res = await complete(state!, "");
		expect(res.status).toBe(400);
		expect(db.tables.creds.size).toBe(0);
	});

	it("is single-use — a replayed callback cannot mint a second credential", async () => {
		// An authorization code is single-use at the server too; the flow row is claimed atomically
		// so a replay loses the race here instead of reaching the token endpoint twice.
		const { state, cookie } = await start();
		expect((await complete(state!, cookie)).status).toBe(200);
		const second = await complete(state!, cookie);
		expect(second.status).toBe(400);
		expect(await second.text()).toContain("expired");
	});

	it("reports a provider error without storing anything", async () => {
		const res = await app.request("/v1/mcp/oauth/callback?error=access_denied", {}, env());
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("cancelled");
		expect(db.tables.creds.size).toBe(0);
	});

	it("surfaces a refused token exchange instead of claiming success", async () => {
		const { state, cookie } = await start();
		safeFetch.mockResolvedValue(new Response('{"error":"invalid_grant"}', { status: 400 }));
		const res = await complete(state!, cookie);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("invalid_grant");
		expect(db.tables.creds.size).toBe(0);
	});
});

describe("GET /v1/mcp/presets", () => {
	it("offers this deployment's own MCP server when it is configured", async () => {
		const res = await app.request("/v1/mcp/presets", authed, env({ MCP_SELF_URL: "https://mcp.example.online/mcp" }));
		const body = (await res.json()) as { presets: Array<{ id: string; url: string; scope: string; smokeTool: string }> };
		expect(body.presets).toHaveLength(1);
		expect(body.presets[0]).toMatchObject({ id: "proagentstore", url: "https://mcp.example.online/mcp", scope: "read", smokeTool: "list_agents" });
	});

	it("offers nothing when the deployment names no MCP server", async () => {
		// An unset var is the normal state of a local build. Falling back to a hardcoded production
		// host would put production into a developer's console — and put a server host into a
		// connector that deliberately contains none.
		const res = await app.request("/v1/mcp/presets", authed, env());
		expect(((await res.json()) as { presets: unknown[] }).presets).toEqual([]);
	});

	it("requires a session", async () => {
		expect((await app.request("/v1/mcp/presets", {}, env({ MCP_SELF_URL: "https://mcp.example.online/mcp" }))).status).toBe(401);
	});
});
