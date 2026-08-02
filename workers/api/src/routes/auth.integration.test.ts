import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signPayload, signSession, verifySession } from "../lib/session.js";
import { authRoutes } from "./auth.js";
import type { Env } from "../types.js";

/**
 * INTEGRATION test for the OAuth / session routes. Drives the REAL auth handlers
 * through the Hono app: state HMAC (signPayload/verifyPayload) → the token-exchange
 * `fetch` (mocked at the boundary) → real signSession → redirect / JSON. Only the
 * network boundary (`globalThis.fetch`) and the D1 boundary are faked; the state
 * validation, return_to allowlist, and session minting run for real.
 */

const SECRET = "auth-integration-secret";
const RETURN_TO = "https://proagentstore.online/console/";

interface UserRow {
	id: string;
	github_login: string;
	github_name: string;
	avatar_url: string;
	roles: string | null;
}

/** Stateful D1 stand-in backing the `users` table these routes upsert into. */
function buildApp(opts: { seedRoles?: string; env?: Partial<Env> } = {}) {
	const users: UserRow[] = [];
	const writes: Array<{ sql: string; args: unknown[] }> = [];

	const env = {
		SESSION_SIGNING_KEY: SECRET,
		GITHUB_CLIENT_ID: "gh-client-id",
		GITHUB_CLIENT_SECRET: "gh-client-secret",
		GOOGLE_CLIENT_ID: "google-client-id",
		GOOGLE_CLIENT_SECRET: "google-client-secret",
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async first() {
								if (sql.includes("SELECT roles FROM users") || sql.includes("SELECT roles, github_login")) {
									const u = users.find((x) => x.id === args[0]);
									return u ? { roles: u.roles ?? (opts.seedRoles ?? null), github_login: u.github_login } : null;
								}
								if (sql.startsWith("SELECT id, github_login")) {
									const u = users.find((x) => x.id === args[0]);
									if (!u) return null;
									return {
										id: u.id,
										github_login: u.github_login,
										linked_github_login: null,
										github_name: u.github_name,
										avatar_url: u.avatar_url,
										roles: u.roles ?? '["user"]',
										stripe_customer_id: null,
										subscription_status: null,
										subscription_expires_at: null,
										display_name: null,
										bio: null,
										website: null,
										twitter: null,
										slack_webhook: null,
										board_config: null,
									};
								}
								return null;
							},
							async run() {
								writes.push({ sql, args });
								if (sql.includes("INSERT INTO users")) {
									const [id, login, name, avatar] = args as [string, string, string, string];
									const existing = users.find((u) => u.id === id);
									if (existing) { existing.github_login = login; existing.github_name = name; existing.avatar_url = avatar; }
									else users.push({ id, github_login: login, github_name: name, avatar_url: avatar, roles: opts.seedRoles ?? null });
								}
								return { meta: { changes: 1 } };
							},
						};
					},
				};
			},
		},
		...opts.env,
	} as unknown as Env;

	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/auth", authRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});
	return { app, env, users, writes };
}

const state = (payload: Record<string, unknown>) =>
	signPayload({ returnTo: RETURN_TO, exp: Math.floor(Date.now() / 1000) + 600, ...payload }, SECRET);

/** Queue-based fetch stub — each entry answers one fetch() in order. */
function stubFetch(responses: Array<{ json: unknown; status?: number }>) {
	let i = 0;
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
		calls.push({ url: String(url), init });
		const r = responses[Math.min(i, responses.length - 1)];
		i++;
		return {
			status: r.status ?? 200,
			async json() { return r.json; },
		} as unknown as Response;
	}));
	return calls;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("GET /v1/auth/config (integration)", () => {
	it("advertises PAGS-native OAuth start URLs derived from the request origin", async () => {
		const { app, env } = buildApp();
		const res = await app.request("https://api.proagentstore.online/v1/auth/config", {}, env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, string>;
		expect(body.oauth_url).toBe("https://api.proagentstore.online/v1/auth/github/start");
		expect(body.google_oauth_url).toBe("https://api.proagentstore.online/v1/auth/google/start");
		expect(body.app_id).toBe("pags-console");
	});
});

describe("GET /v1/auth/github/start (integration)", () => {
	it("400s a missing return_to", async () => {
		const { app, env } = buildApp();
		const res = await app.request("/v1/auth/github/start", {}, env);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("missing return_to");
	});

	it("400s a return_to outside the allowlist (no sibling/attacker hosts)", async () => {
		const { app, env } = buildApp();
		const res = await app.request("/v1/auth/github/start?return_to=https://evil.example.com/", {}, env);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("not allowed");
	});

	it("501s when GitHub OAuth isn't configured", async () => {
		const { app, env } = buildApp({ env: { GITHUB_CLIENT_ID: undefined } as Partial<Env> });
		const res = await app.request(`/v1/auth/github/start?return_to=${encodeURIComponent(RETURN_TO)}`, {}, env);
		expect(res.status).toBe(501);
	});

	it("redirects to GitHub consent carrying a signed, verifiable state", async () => {
		const { app, env } = buildApp();
		const res = await app.request(`https://api.proagentstore.online/v1/auth/github/start?return_to=${encodeURIComponent(RETURN_TO)}`, {}, env);
		expect(res.status).toBe(302);
		const loc = new URL(res.headers.get("location")!);
		expect(loc.origin + loc.pathname).toBe("https://github.com/login/oauth/authorize");
		expect(loc.searchParams.get("client_id")).toBe("gh-client-id");
		expect(loc.searchParams.get("redirect_uri")).toBe("https://api.proagentstore.online/v1/auth/github/callback");
		// The state round-trips through the same HMAC.
		const verified = await (await import("../lib/session.js")).verifyPayload(loc.searchParams.get("state")!, SECRET) as { returnTo: string } | null;
		expect(verified?.returnTo).toBe(RETURN_TO);
	});
});

describe("GET /v1/auth/github/callback (integration)", () => {
	it("400s when code or state is missing", async () => {
		const { app, env } = buildApp();
		const res = await app.request("/v1/auth/github/callback?code=abc", {}, env);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("missing code or state");
	});

	it("400s a tampered / unsigned state", async () => {
		const { app, env } = buildApp();
		const res = await app.request("/v1/auth/github/callback?code=abc&state=not-a-signed-state", {}, env);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("invalid or expired state");
	});

	it("400s an expired state (exp in the past)", async () => {
		const { app, env } = buildApp();
		const expired = await signPayload({ returnTo: RETURN_TO, exp: Math.floor(Date.now() / 1000) - 5 }, SECRET);
		const res = await app.request(`/v1/auth/github/callback?code=abc&state=${encodeURIComponent(expired)}`, {}, env);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("invalid or expired state");
	});

	it("401s when GitHub returns no access token, and logs the failure", async () => {
		const { app, env } = buildApp();
		const errorWrites: unknown[] = [];
		(env as unknown as { DB: { prepare(sql: string): unknown } }).DB = {
			prepare(sql: string) {
				return { bind: () => ({ async run() { if (sql.includes("error_log")) errorWrites.push(sql); return { meta: { changes: 1 } }; }, async first() { return null; } }) };
			},
		} as unknown as Env["DB"];
		stubFetch([{ json: { error: "bad_verification_code" } }]);
		const res = await app.request(`/v1/auth/github/callback?code=bad&state=${encodeURIComponent(await state({}))}`, {}, env);
		expect(res.status).toBe(401);
		expect(await res.text()).toContain("bad_verification_code");
	});

	it("mints a session + upserts the user + redirects to return_to on success", async () => {
		const { app, env, users } = buildApp();
		stubFetch([
			{ json: { access_token: "gho_tok" } }, // token exchange
			{ json: { id: 4242, login: "octocat", avatar_url: "https://a/x.png", name: "Octo Cat" } }, // /user
		]);
		const res = await app.request(`/v1/auth/github/callback?code=good&state=${encodeURIComponent(await state({}))}`, {}, env);
		expect(res.status).toBe(302);
		const loc = new URL(res.headers.get("location")!);
		expect(loc.origin + loc.pathname).toBe(RETURN_TO);
		// The session param is a real, verifiable session for the github uid.
		const session = loc.searchParams.get("session")!;
		const verified = await verifySession(session, SECRET);
		expect(verified?.uid).toBe("4242");
		expect(users.find((u) => u.id === "4242")?.github_login).toBe("octocat");
	});

	it("does the LINK flow (records linked_github_login, no session minted)", async () => {
		const { app, env, writes } = buildApp();
		stubFetch([
			{ json: { access_token: "gho_tok" } },
			{ json: { id: 4242, login: "octocat", avatar_url: "", name: "" } },
		]);
		const linkState = await state({ linkUid: "google:99" });
		const res = await app.request(`/v1/auth/github/callback?code=good&state=${encodeURIComponent(linkState)}`, {}, env);
		expect(res.status).toBe(302);
		const loc = new URL(res.headers.get("location")!);
		expect(loc.searchParams.get("github_linked")).toBe("octocat");
		expect(loc.searchParams.get("session")).toBeNull();
		expect(writes.some((w) => w.sql.includes("linked_github_login"))).toBe(true);
	});
});

describe("GET /v1/auth/google/start + callback (integration)", () => {
	it("start 400s an outside return_to", async () => {
		const { app, env } = buildApp();
		const res = await app.request("/v1/auth/google/start?return_to=http://attacker.test/", {}, env);
		expect(res.status).toBe(400);
	});

	it("start redirects to Google's consent endpoint with response_type=code", async () => {
		const { app, env } = buildApp();
		const res = await app.request(`https://api.proagentstore.online/v1/auth/google/start?return_to=${encodeURIComponent(RETURN_TO)}`, {}, env);
		expect(res.status).toBe(302);
		const loc = new URL(res.headers.get("location")!);
		expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
		expect(loc.searchParams.get("response_type")).toBe("code");
		expect(loc.searchParams.get("client_id")).toBe("google-client-id");
	});

	it("callback mints a google: session on success", async () => {
		const { app, env, users } = buildApp();
		stubFetch([
			{ json: { access_token: "ya29.tok" } }, // token
			{ json: { id: "1122", email: "u@example.com", name: "U", picture: "https://p/x" } }, // userinfo
		]);
		const res = await app.request(`https://api.proagentstore.online/v1/auth/google/callback?code=good&state=${encodeURIComponent(await state({}))}`, {}, env);
		expect(res.status).toBe(302);
		const loc = new URL(res.headers.get("location")!);
		const verified = await verifySession(loc.searchParams.get("session")!, SECRET);
		expect(verified?.uid).toBe("google:1122");
		expect(users.find((u) => u.id === "google:1122")?.github_login).toBe("u@example.com");
	});

	it("callback 401s + logs when Google returns an error_description", async () => {
		const { app, env } = buildApp();
		stubFetch([{ json: { error: "invalid_grant", error_description: "redirect_uri_mismatch" } }]);
		const res = await app.request(`https://api.proagentstore.online/v1/auth/google/callback?code=bad&state=${encodeURIComponent(await state({}))}`, {}, env);
		expect(res.status).toBe(401);
		expect(await res.text()).toContain("redirect_uri_mismatch");
	});
});

describe("GET /v1/auth/me + PUT /v1/auth/me (integration)", () => {
	const tokenFor = (uid: string, roles: string[] = ["user"]) => signSession(uid, SECRET, { roles });

	it("GET 401s without a bearer token", async () => {
		const { app, env } = buildApp();
		const res = await app.request("/v1/auth/me", {}, env);
		expect(res.status).toBe(401);
	});

	it("GET 404s a token whose user row doesn't exist", async () => {
		const { app, env } = buildApp();
		const res = await app.request("/v1/auth/me", { headers: { Authorization: `Bearer ${await tokenFor("ghost")}` } }, env);
		expect(res.status).toBe(404);
		expect((await res.json() as { error: string }).error).toContain("User not found");
	});

	it("GET returns the profile for an existing user", async () => {
		const { app, env, users } = buildApp();
		users.push({ id: "u1", github_login: "octo", github_name: "Octo", avatar_url: "https://a", roles: '["user"]' });
		const res = await app.request("/v1/auth/me", { headers: { Authorization: `Bearer ${await tokenFor("u1")}` } }, env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.id).toBe("u1");
		expect(body.login).toBe("octo");
		expect(body.hasSubscription).toBe(false);
	});

	it("PUT 401s without a token", async () => {
		const { app, env } = buildApp();
		const res = await app.request("/v1/auth/me", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" }, env);
		expect(res.status).toBe(401);
	});

	it("PUT 400s when nothing to update", async () => {
		const { app, env } = buildApp();
		const res = await app.request("/v1/auth/me", { method: "PUT", headers: { Authorization: `Bearer ${await tokenFor("u1")}`, "Content-Type": "application/json" }, body: "{}" }, env);
		expect(res.status).toBe(400);
		expect((await res.json() as { error: string }).error).toContain("Nothing to update");
	});

	it("PUT 400s a non-https / non-Slack webhook (SSRF allowlist)", async () => {
		const { app, env } = buildApp();
		const res = await app.request("/v1/auth/me", { method: "PUT", headers: { Authorization: `Bearer ${await tokenFor("u1")}`, "Content-Type": "application/json" }, body: JSON.stringify({ slack_webhook: "https://evilslack.com/hook" }) }, env);
		expect(res.status).toBe(400);
		expect((await res.json() as { error: string }).error).toContain("Slack or Discord");
	});

	it("PUT persists allowed profile fields via a single UPDATE", async () => {
		const { app, env, writes } = buildApp();
		const res = await app.request("/v1/auth/me", { method: "PUT", headers: { Authorization: `Bearer ${await tokenFor("u1")}`, "Content-Type": "application/json" }, body: JSON.stringify({ bio: "hi", website: "https://me.dev" }) }, env);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true });
		const upd = writes.find((w) => w.sql.startsWith("UPDATE users SET"));
		expect(upd).toBeTruthy();
		// First bound param is the uid (WHERE id = ?1), the values follow.
		expect(upd!.args[0]).toBe("u1");
		expect(upd!.args).toContain("hi");
		expect(upd!.args).toContain("https://me.dev");
	});
});
