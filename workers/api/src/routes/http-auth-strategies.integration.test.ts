/**
 * #1124 — HTTP auth strategies rendered from a bound credential profile, end to end.
 *
 * Real schema, real routes: profiles are created and bound through `/v1/http-profiles` and
 * `/v1/instances/:id/http-bindings` (#1123), and `http_request` is invoked through
 * `POST /v1/instances/:id/tools/http_request` — the route an MCP `call_instance_tool` uses, which also
 * writes the `tool.invoked` audit row. Only the network is faked: the API being called and the OAuth2
 * token endpoint answer from `fetch`, and every request is recorded with its headers.
 *
 * The acceptance case is Discord `GET /api/v10/users/@me` with exactly `Authorization: Bot <secret>`,
 * and neither the token nor that header in any response or stored record.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async (c: { req: { header(n: string): string | undefined } }) => ({ uid: c.req.header("x-test-uid") ?? "u1", roles: [] }) };
});
const { httpBindingRoutes, httpProfileRoutes } = await import("./http-profiles.js");
const { toolRoutes } = await import("./tools.js");

const DISCORD_TOKEN = "MTA5ODc2NTQzMjE.Gx_bot.secret_never_leaks_zzz";
const INSTANCE = "inst-1124";
const OTHER = "inst-unbound";
const TOKEN_URL = "https://auth.example.com/oauth/token";

let d1: RealSchemaD1;
let env: Env;
/** Every outbound request: url, method, headers (lower-cased) and body. */
let sent: Array<{ url: string; method: string; headers: Record<string, string>; body: string }>;
/** How the faked network answers. */
let answer: (url: string, headers: Record<string, string>, body: string) => Response;

const app = new Hono<{ Bindings: Env }>();
app.route("/v1/http-profiles", httpProfileRoutes);
app.route("/v1/instances", httpBindingRoutes);
app.route("/v1/instances", toolRoutes);
app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec("INSERT INTO users (id, github_login) VALUES ('u1', 'u1')");
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('ag', 'u1', 't1124', 'HTTP agent', '${JSON.stringify({ capabilities: { surfaces: [], runtime: null, tools: ["http_request"] } })}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('${INSTANCE}', 'ag', 'u1', 'active', '{}'), ('${OTHER}', 'ag', 'u1', 'active', '{}')`);
	env = { DB: d1.DB, KEY_ENCRYPTION_KEY: "a".repeat(64), SESSION_SIGNING_KEY: "s".repeat(64) } as unknown as Env;
	sent = [];
	answer = () => json({ ok: true });
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		const headers: Record<string, string> = {};
		new Headers(init?.headers).forEach((v, k) => {
			headers[k] = v;
		});
		const body = typeof init?.body === "string" ? init.body : "";
		sent.push({ url, method: init?.method ?? "GET", headers, body });
		return answer(url, headers, body);
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	d1.close();
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
	const res = await app.request(path, { method, headers: { "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env, { waitUntil: () => {}, passThroughOnException: () => {}, props: {} });
	const raw = await res.text();
	// biome-ignore lint/suspicious/noExplicitAny: read field by field
	return { status: res.status, raw, json: (raw.startsWith("{") ? JSON.parse(raw) : {}) as Record<string, any>, headers: res.headers };
}

/** Create a profile with a strategy and bind it to the instance under `binding`. */
async function profile(name: string, secret: string, strategy: string, strategyConfig: unknown, binding = name) {
	// The hosts these tests call (#1125 sends a credential only to a listed origin).
	const created = await call("POST", "/v1/http-profiles", { name, secret, strategy, strategyConfig, allowedOrigins: ["https://discord.com", "https://api.example.com"] });
	expect(created.status, created.raw).toBe(201);
	const bound = await call("PUT", `/v1/instances/${INSTANCE}/http-bindings/${binding}`, { profileId: created.json.profile.id });
	expect(bound.status, bound.raw).toBe(200);
	return created.json.profile as { id: string; renders: { headers: string[]; query: string[] } };
}
const request = (args: Record<string, unknown>, instance = INSTANCE) => call("POST", `/v1/instances/${instance}/tools/http_request`, args);
const apiCalls = () => sent.filter((s) => !s.url.startsWith(TOKEN_URL));

/** Every text and blob cell in the database — where a leaked secret would sit. */
function everyStoredValue(): string {
	const tables = (d1.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name);
	const out: string[] = [];
	for (const t of tables) for (const row of d1.sqlite.prepare(`SELECT * FROM "${t}"`).all() as Array<Record<string, unknown>>) for (const v of Object.values(row)) out.push(v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : String(v));
	return out.join("\n");
}

describe("Discord: `Authorization: Bot <secret>` — and the token nowhere else (#1124 acceptance)", () => {
	it("GET /api/v10/users/@me carries exactly that header; the reply and every stored record carry neither the token nor the header", async () => {
		const p = await profile("discord", DISCORD_TOKEN, "header_template", { header: { name: "Authorization", template: "Bot {{secret}}" } });
		expect(p.renders).toEqual({ headers: ["Authorization"], query: [] });
		answer = () => json({ id: "80351110224678912", username: "pags-bot", bot: true });

		const r = await request({ method: "GET", url: "https://discord.com/api/v10/users/@me", profile: "discord" });
		expect(r.status).toBe(200);
		expect(r.json.success).toBe(true);
		expect(r.raw).toContain("pags-bot");

		const [out] = apiCalls();
		expect(out.url).toBe("https://discord.com/api/v10/users/@me");
		expect(out.headers.authorization).toBe(`Bot ${DISCORD_TOKEN}`);
		expect(Object.entries(out.headers).filter(([, v]) => v.includes(DISCORD_TOKEN))).toEqual([["authorization", `Bot ${DISCORD_TOKEN}`]]);

		for (const where of [r.raw, everyStoredValue()]) {
			expect(where).not.toContain(DISCORD_TOKEN);
			expect(where).not.toContain(`Bot ${DISCORD_TOKEN}`);
		}
		// The audit row exists, and says what was called with — argument NAMES, never values.
		const audit = d1.sqlite.prepare("SELECT message, context FROM agent_events WHERE event = 'tool.invoked'").all() as Array<{ message: string; context: string }>;
		expect(audit).toHaveLength(1);
		expect(JSON.parse(audit[0].context)).toMatchObject({ tool: "http_request", argKeys: ["method", "url", "profile"] });
	});

	it("an API that ECHOES the request back cannot hand the token to the agent: every secret-derived value is redacted", async () => {
		await profile("discord", DISCORD_TOKEN, "header_template", { header: { name: "Authorization", template: "Bot {{secret}}" } });
		answer = (_u, h) => json({ message: "401: Unauthorized", you_sent: h.authorization, token: DISCORD_TOKEN }, 401);
		const r = await request({ method: "GET", url: "https://discord.com/api/v10/users/@me", profile: "discord" });
		expect(r.json.success).toBe(false);
		expect(r.raw).not.toContain(DISCORD_TOKEN);
		expect(r.raw).toContain("[redacted]");
		expect(everyStoredValue()).not.toContain(DISCORD_TOKEN);
	});
});

describe("every strategy renders from the profile, never from the agent (#1124)", () => {
	const secret = "s3cr3t-value_ABC123";

	it("bearer → `Authorization: Bearer <secret>`", async () => {
		await profile("bear", secret, "bearer", {});
		await request({ url: "https://api.example.com/x", profile: "bear" });
		expect(apiCalls()[0].headers.authorization).toBe(`Bearer ${secret}`);
	});

	it("api_key in a header, and in the query string — where the URL echoed back is redacted too", async () => {
		await profile("hkey", secret, "api_key", { in: "header", name: "X-Api-Key" });
		await request({ url: "https://api.example.com/x", profile: "hkey" });
		expect(apiCalls()[0].headers["x-api-key"]).toBe(secret);

		await profile("qkey", secret, "api_key", { in: "query", name: "key" });
		answer = (u) => json({ requested: u });
		const r = await request({ url: "https://api.example.com/y?a=1", profile: "qkey" });
		expect(new URL(apiCalls()[1].url).searchParams.get("key")).toBe(secret);
		expect(r.raw).not.toContain(secret);
	});

	it("basic → `Authorization: Basic base64(username:secret)`; the base64 token is redacted from an echo", async () => {
		await profile("basic", secret, "basic", { username: "svc-user" });
		const token = Buffer.from(`svc-user:${secret}`).toString("base64");
		answer = (_u, h) => json({ got: h.authorization });
		const r = await request({ url: "https://api.example.com/x", profile: "basic" });
		expect(apiCalls()[0].headers.authorization).toBe(`Basic ${token}`);
		expect(r.raw).not.toContain(token);
	});

	it("multi_header → an API key plus a static header; staticHeaders ride along with any strategy", async () => {
		await profile("multi", secret, "multi_header", { headers: [{ name: "X-Key", template: "{{secret}}" }, { name: "X-Version", template: "2024-01" }] });
		await request({ url: "https://api.example.com/x", profile: "multi" });
		expect(apiCalls()[0].headers).toMatchObject({ "x-key": secret, "x-version": "2024-01" });

		await profile("bearstatic", secret, "bearer", { staticHeaders: { "Notion-Version": "2022-06-28" } });
		await request({ url: "https://api.example.com/x", profile: "bearstatic" });
		expect(apiCalls()[1].headers).toMatchObject({ authorization: `Bearer ${secret}`, "notion-version": "2022-06-28" });
	});

	it("none → no credential at all", async () => {
		await profile("open", secret, "none", { staticHeaders: { Accept: "application/json" } });
		await request({ url: "https://api.example.com/x", profile: "open" });
		expect(apiCalls()[0].headers.authorization).toBeUndefined();
		expect(Object.values(apiCalls()[0].headers).join()).not.toContain(secret);
	});

	it("the agent cannot shadow the credential header, cannot send `profile` and `auth` together, and an unbound instance gets nothing", async () => {
		await profile("bear", secret, "bearer", {});
		await request({ url: "https://api.example.com/x", profile: "bear", headers: { Authorization: "Bearer agent-chosen" } });
		expect(apiCalls()[0].headers.authorization).toBe(`Bearer ${secret}`);

		const both = await request({ url: "https://api.example.com/x", profile: "bear", auth: { mode: "bearer" } });
		expect(both.json).toMatchObject({ success: false });
		expect(both.json.content).toMatch(/either `profile`/);

		const unbound = await request({ url: "https://api.example.com/x", profile: "bear" }, OTHER);
		expect(unbound.json.success).toBe(false);
		expect(unbound.json.content).toMatch(/No credential profile is bound to this instance as "bear"/);
		expect(apiCalls()).toHaveLength(1);
	});

	it("a profile with no strategy renders nothing and says how to fix it", async () => {
		const created = await call("POST", "/v1/http-profiles", { name: "bare", secret, allowedOrigins: ["https://api.example.com"] });
		await call("PUT", `/v1/instances/${INSTANCE}/http-bindings/bare`, { profileId: created.json.profile.id });
		const r = await request({ url: "https://api.example.com/x", profile: "bare" });
		expect(r.json.content).toMatch(/has no auth strategy yet/);
		expect(apiCalls()).toHaveLength(0);
	});
});

describe("custom header templating admits only literals around ONE secret reference (#1124)", () => {
	it.each([
		[{ header: { name: "Authorization", template: "Bot {{input}}" } }, /printable ASCII, no \{ or \}/],
		[{ header: { name: "Authorization", template: "{{secret}} {{secret}}" } }, /only once/],
		[{ header: { name: "Authorization", template: "Bot {{secret}}\r\nX-Evil: 1" } }, /no line breaks/],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a would-be interpolation, sent literally, is what this case proves is refused
		[{ header: { name: "Authorization", template: "Bot ${env.KEY}{{secret}}" } }, /no \{ or \}/],
		[{ header: { name: "Host", template: "{{secret}}" } }, /platform sets that header/],
		[{ header: { name: "Bad Name", template: "{{secret}}" } }, /header name/],
		[{ header: { name: "Authorization", template: "Bot fixed" } }, /must contain \{\{secret\}\}/],
	])("refuses %j", async (cfg, why) => {
		const r = await call("POST", "/v1/http-profiles", { name: "t", secret: "x-secret-1", strategy: "header_template", strategyConfig: cfg });
		expect(r.status).toBe(400);
		expect(r.json.error).toMatch(why);
		expect(r.raw).not.toContain("x-secret-1");
	});

	it("a staticHeader can never carry the secret, and a Basic username cannot hold a ':'", async () => {
		expect((await call("POST", "/v1/http-profiles", { name: "t", secret: "x-secret-1", strategy: "bearer", strategyConfig: { staticHeaders: { "X-Copy": "{{secret}}" } } })).status).toBe(400);
		expect((await call("POST", "/v1/http-profiles", { name: "t", secret: "x-secret-1", strategy: "basic", strategyConfig: { username: "a:b" } })).status).toBe(400);
	});
});

describe("OAuth2 client credentials: minted, stored encrypted, reused, refreshed on expiry (#1124)", () => {
	it("mints on first use, reuses while valid, mints again past expiry minus the skew — the client secret goes only to the token endpoint", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-17T00:00:00Z"));
		let minted = 0;
		answer = (u, _h, body) => {
			if (u === TOKEN_URL) {
				expect(new URLSearchParams(body).get("grant_type")).toBe("client_credentials");
				return json({ access_token: `cc-token-${++minted}`, expires_in: 3600, token_type: "bearer" });
			}
			return json({ ok: true });
		};
		await profile("cc", "client-secret-xyz", "oauth2_client_credentials", { tokenUrl: TOKEN_URL, clientId: "client-1", scope: "read" });

		await request({ url: "https://api.example.com/a", profile: "cc" });
		await request({ url: "https://api.example.com/b", profile: "cc" });
		expect(minted).toBe(1);
		expect(apiCalls().map((c) => c.headers.authorization)).toEqual(["Bearer cc-token-1", "Bearer cc-token-1"]);
		const tokenCall = sent.find((s) => s.url === TOKEN_URL);
		expect(new URLSearchParams(tokenCall?.body)).toEqual(new URLSearchParams({ grant_type: "client_credentials", scope: "read", client_id: "client-1", client_secret: "client-secret-xyz" }));
		expect(apiCalls().some((c) => JSON.stringify(c).includes("client-secret-xyz"))).toBe(false);
		// Stored ENCRYPTED: neither the access token nor the client secret is in any cell.
		expect(everyStoredValue()).not.toContain("cc-token-1");
		expect(everyStoredValue()).not.toContain("client-secret-xyz");

		vi.setSystemTime(new Date(Date.now() + 3600_000 - 30_000)); // inside the 60s skew
		await request({ url: "https://api.example.com/c", profile: "cc" });
		expect(minted).toBe(2);
		expect(apiCalls().at(-1)?.headers.authorization).toBe("Bearer cc-token-2");
	});

	it("`clientAuth: basic` authenticates the client with Basic at the token endpoint, not in the body", async () => {
		answer = (u) => (u === TOKEN_URL ? json({ access_token: "cc-b", expires_in: 3600 }) : json({ ok: true }));
		await profile("ccb", "client-secret-xyz", "oauth2_client_credentials", { tokenUrl: TOKEN_URL, clientId: "client-1", clientAuth: "basic" });
		await request({ url: "https://api.example.com/a", profile: "ccb" });
		const t = sent.find((s) => s.url === TOKEN_URL);
		expect(t?.headers.authorization).toBe(`Basic ${btoa("client-1:client-secret-xyz")}`);
		expect(new URLSearchParams(t?.body).get("client_secret")).toBeNull();
	});
});

describe("OAuth2 authorization code: browser-bound consent, then silent refresh (#1124)", () => {
	const cfg = { tokenUrl: TOKEN_URL, clientId: "client-ac", authorizeUrl: "https://auth.example.com/authorize", scope: "identify" };

	/** Run the consent leg as the owner's browser would; returns the profile id. */
	async function authorize(): Promise<string> {
		const p = await profile("ac", "ac-client-secret", "oauth2_authorization_code", cfg);
		const started = await call("POST", `/v1/http-profiles/${p.id}/oauth/start`);
		expect(started.status, started.raw).toBe(200);
		const url = new URL(started.json.url);
		expect(url.origin + url.pathname).toBe("https://auth.example.com/authorize");
		expect(url.searchParams.get("client_id")).toBe("client-ac");
		const cookie = (started.headers.get("set-cookie") ?? "").split(";")[0];
		const done = await call("GET", `/v1/http-profiles/oauth/callback?code=code-1&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}`, undefined, { cookie });
		expect(done.status, done.raw).toBe(200);
		return p.id;
	}

	it("consent stores the grant; expiry spends the refresh token and stores the rotated one; tokens never stored in the clear", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-17T00:00:00Z"));
		const grants: string[] = [];
		let n = 0;
		answer = (u, _h, body) => {
			if (u !== TOKEN_URL) return json({ ok: true });
			const p = new URLSearchParams(body);
			grants.push(`${p.get("grant_type")}:${p.get("code") ?? p.get("refresh_token")}`);
			n++;
			return json({ access_token: `ac-access-${n}`, refresh_token: `ac-refresh-${n}`, expires_in: 3600 });
		};
		await authorize();
		await request({ url: "https://api.example.com/me", profile: "ac" });
		expect(apiCalls().at(-1)?.headers.authorization).toBe("Bearer ac-access-1");

		vi.setSystemTime(new Date(Date.now() + 3600_000));
		await request({ url: "https://api.example.com/me", profile: "ac" });
		vi.setSystemTime(new Date(Date.now() + 3600_000));
		await request({ url: "https://api.example.com/me", profile: "ac" });
		expect(grants).toEqual(["authorization_code:code-1", "refresh_token:ac-refresh-1", "refresh_token:ac-refresh-2"]);
		expect(apiCalls().map((c) => c.headers.authorization)).toEqual(["Bearer ac-access-1", "Bearer ac-access-2", "Bearer ac-access-3"]);
		for (const t of ["ac-access-3", "ac-refresh-3", "ac-client-secret"]) expect(everyStoredValue()).not.toContain(t);
	});

	it("a 401 on a token inside its lifetime forces ONE refresh and one retry", async () => {
		let n = 0;
		answer = (u, h) => {
			if (u === TOKEN_URL) {
				n++;
				return json({ access_token: `tok-${n}`, refresh_token: `ref-${n}`, expires_in: 3600 });
			}
			return h.authorization === "Bearer tok-1" ? json({ error: "token revoked" }, 401) : json({ ok: true });
		};
		await authorize();
		const r = await request({ url: "https://api.example.com/me", profile: "ac" });
		expect(r.json.success).toBe(true);
		expect(apiCalls().map((c) => c.headers.authorization)).toEqual(["Bearer tok-1", "Bearer tok-2"]);
	});

	it("an invalid_grant refresh clears the grant and says to authorize again — it is not retried forever", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-17T00:00:00Z"));
		let first = true;
		answer = (u) => {
			if (u !== TOKEN_URL) return json({ ok: true });
			if (first) {
				first = false;
				return json({ access_token: "a-1", refresh_token: "r-1", expires_in: 3600 });
			}
			return json({ error: "invalid_grant", error_description: "refresh token r-1 revoked" }, 400);
		};
		await authorize();
		vi.setSystemTime(new Date(Date.now() + 7200_000));
		const r = await request({ url: "https://api.example.com/me", profile: "ac" });
		expect(r.json.success).toBe(false);
		expect(r.json.content).toMatch(/expired or was revoked \(invalid_grant\).*authorize the profile again/);
		expect(r.raw).not.toContain("r-1");
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM http_credential_oauth_tokens").get()).toEqual({ n: 0 });
		expect(apiCalls()).toHaveLength(0);
	});

	it("a callback without the starting browser's cookie, or for an unauthorized profile, files nothing", async () => {
		const p = await profile("ac", "ac-client-secret", "oauth2_authorization_code", cfg);
		const started = await call("POST", `/v1/http-profiles/${p.id}/oauth/start`);
		const state = new URL(started.json.url).searchParams.get("state") ?? "";
		const foreign = await call("GET", `/v1/http-profiles/oauth/callback?code=c&state=${encodeURIComponent(state)}`);
		expect(foreign.status).toBe(400);
		expect(sent.filter((s) => s.url === TOKEN_URL)).toHaveLength(0);
		const r = await request({ url: "https://api.example.com/me", profile: "ac" });
		expect(r.json.content).toMatch(/has not been authorized yet/);
	});
});
