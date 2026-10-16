/**
 * #1123 — named HTTP credential profiles + per-instance bindings, against the real migrated schema.
 *
 * The three properties the issue names, each held by a test that would fail if it broke:
 *   - REDACTION: the plaintext secret appears in no response body, no error body, no D1 row (audit
 *     events included) and no console output — on create, read, update, rotate, test, bind, delete,
 *     and on every refusal.
 *   - OWNERSHIP ISOLATION: another owner cannot read, change, rotate, test, delete or bind a profile;
 *     every one of those reads 404, exactly like a missing profile.
 *   - BINDING ISOLATION: an instance reaches a profile only through its own binding — an unbound
 *     instance, another owner's instance, the wrong connector or binding name all resolve to nothing.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentDeleteStatements } from "../lib/agent-cascade.js";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1, seedTenant } from "../lib/d1-sqlite.js";
import { resolveBoundSecret } from "../lib/http-profiles.js";
import type { Env } from "../types.js";
import { httpBindingRoutes, httpProfileRoutes } from "./http-profiles.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async (c: { req: { header: (n: string) => string | undefined } }) => ({ uid: c.req.header("x-test-uid") ?? "alice", roles: [] }) };
});

const SECRET = "sk_live_PLAINTEXT_never_leaks_0123456789";
const ROTATED = "sk_live_ROTATED_never_leaks_9876543210";
const KEK = "a".repeat(64);
const A1 = "inst-alice-1";
const A2 = "inst-alice-2";
const B1 = "inst-bob-1";

let d1: RealSchemaD1;
let env: Env;
let logged: string[];
const app = new Hono<{ Bindings: Env }>();
app.route("/v1/http-profiles", httpProfileRoutes);
app.route("/v1/instances", httpBindingRoutes);
app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));

async function call(method: string, path: string, opts: { uid?: string; body?: unknown } = {}) {
	const res = await app.request(
		path,
		{ method, headers: { "content-type": "application/json", "x-test-uid": opts.uid ?? "alice" }, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) },
		env,
	);
	const raw = await res.text();
	// biome-ignore lint/suspicious/noExplicitAny: response bodies are read field by field in assertions
	return { status: res.status, raw, json: JSON.parse(raw) as Record<string, any> };
}

/** Every text and blob cell in the database, decoded — where a leaked secret would sit. */
function everyStoredValue(): string {
	const tables = (d1.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name);
	const out: string[] = [];
	for (const t of tables) {
		for (const row of d1.sqlite.prepare(`SELECT * FROM "${t}"`).all() as Array<Record<string, unknown>>) {
			for (const v of Object.values(row)) out.push(v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : String(v));
		}
	}
	return out.join("\n");
}

const expectNoSecret = (s: string) => {
	expect(s).not.toContain(SECRET);
	expect(s).not.toContain(ROTATED);
	expect(s).not.toContain("never_leaks");
};

async function createProfile(name = "discord-bot", uid = "alice") {
	const r = await call("POST", "/v1/http-profiles", { uid, body: { name, secret: SECRET, description: "Discord bot token", allowedOrigins: ["https://discord.com/"] } });
	expect(r.status).toBe(201);
	return r.json.profile as { id: string };
}

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "alice", instanceIds: [A1, A2] });
	d1.exec("INSERT INTO users (id, github_login) VALUES ('bob', 'bob')");
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id) VALUES ('${B1}', 'agent-1', 'bob')`);
	env = { DB: d1.DB, KEY_ENCRYPTION_KEY: KEK } as unknown as Env;
	logged = [];
	for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
});
afterEach(() => {
	vi.restoreAllMocks();
	d1.close();
});

describe("redaction — the secret goes in and never comes out (#1123)", () => {
	it("no response, no stored row, no audit event and no log line carries the secret, across the whole lifecycle", async () => {
		const bodies: string[] = [];
		const create = await call("POST", "/v1/http-profiles", { body: { name: "discord-bot", secret: SECRET, allowedOrigins: ["https://discord.com"] } });
		bodies.push(create.raw);
		const id = create.json.profile.id as string;
		expect(create.json.profile).toMatchObject({ name: "discord-bot", strategy: "unspecified", allowedOrigins: ["https://discord.com"], secret: { set: true, version: 1, rotatedAt: null } });
		expect(Object.keys(create.json.profile).sort()).toEqual(["allowedOrigins", "bindings", "createdAt", "description", "id", "name", "secret", "strategy", "updatedAt"]);

		for (const [m, p, b] of [
			["GET", "/v1/http-profiles", undefined],
			["GET", `/v1/http-profiles/${id}`, undefined],
			["PATCH", `/v1/http-profiles/${id}`, { description: "rotated weekly" }],
			["GET", `/v1/http-profiles/${id}/test`, undefined],
			["PUT", `/v1/instances/${A1}/http-bindings/discord`, { profileId: id }],
			["GET", `/v1/instances/${A1}/http-bindings`, undefined],
			["POST", `/v1/http-profiles/${id}/rotate`, { secret: ROTATED }],
			["GET", `/v1/http-profiles/${id}`, undefined],
		] as const) {
			const r = await call(m, p, { body: b });
			expect(r.status, `${m} ${p}`).toBe(200);
			bodies.push(r.raw);
		}
		const del = await call("DELETE", `/v1/http-profiles/${id}`);
		bodies.push(del.raw);

		for (const b of bodies) expectNoSecret(b);
		expectNoSecret(everyStoredValue());
		expectNoSecret(logged.join("\n"));
		// The audit trail exists — it records WHAT happened, never the value.
		const events = d1.sqlite.prepare("SELECT event FROM agent_events WHERE source = 'http-profiles' ORDER BY ts").all() as Array<{ event: string }>;
		expect(events.map((e) => e.event)).toEqual(["http_profile.create", "http_profile.update", "http_profile.bind", "http_profile.rotate", "http_profile.delete"]);
	});

	it("the secret is stored as ciphertext, and rotation replaces it and bumps the version", async () => {
		const { id } = await createProfile();
		const before = d1.sqlite.prepare("SELECT secret_ciphertext, secret_version FROM http_credential_profiles WHERE id = ?").get(id) as { secret_ciphertext: Uint8Array; secret_version: number };
		expect(Buffer.from(before.secret_ciphertext).toString("latin1")).not.toContain(SECRET);
		const r = await call("POST", `/v1/http-profiles/${id}/rotate`, { body: { secret: ROTATED } });
		expect(r.json.profile.secret).toMatchObject({ set: true, version: 2 });
		expect(r.json.profile.secret.rotatedAt).toEqual(expect.any(String));
		const after = d1.sqlite.prepare("SELECT secret_ciphertext FROM http_credential_profiles WHERE id = ?").get(id) as { secret_ciphertext: Uint8Array };
		expect(Buffer.from(after.secret_ciphertext).equals(Buffer.from(before.secret_ciphertext))).toBe(false);
		await call("PUT", `/v1/instances/${A1}/http-bindings/discord`, { body: { profileId: id } });
		expect((await resolveBoundSecret(env, { userId: "alice", instanceId: A1, connector: "http", bindingName: "discord" }))?.secret).toBe(ROTATED);
	});

	it("refusals never quote the secret — and update will not take one", async () => {
		const bad = [
			await call("POST", "/v1/http-profiles", { body: { name: "Bad Name!", secret: SECRET } }),
			await call("POST", "/v1/http-profiles", { body: { name: "ok", secret: `${SECRET}\r\nX-Injected: 1` } }),
			await call("POST", "/v1/http-profiles", { body: { name: "ok", secret: SECRET.repeat(400) } }),
			await call("POST", "/v1/http-profiles", { body: { name: "ok", secret: SECRET, allowedOrigins: ["https://discord.com/api?k=v"] } }),
		];
		for (const r of bad) {
			expect(r.status).toBe(400);
			expectNoSecret(r.raw);
		}
		const { id } = await createProfile();
		const dup = await call("POST", "/v1/http-profiles", { body: { name: "discord-bot", secret: SECRET } });
		expect(dup.status).toBe(409);
		expectNoSecret(dup.raw);
		const upd = await call("PATCH", `/v1/http-profiles/${id}`, { body: { secret: ROTATED } });
		expect(upd.status).toBe(400);
		expect(upd.json.error).toMatch(/rotate/);
		expectNoSecret(upd.raw);
		expectNoSecret(everyStoredValue());
	});

	it("refuses to store a secret it cannot encrypt", async () => {
		env = { DB: d1.DB } as unknown as Env;
		const r = await call("POST", "/v1/http-profiles", { body: { name: "discord-bot", secret: SECRET } });
		expect(r.status).toBe(503);
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM http_credential_profiles").get()).toEqual({ n: 0 });
	});

	it("the storage test reports facts about the secret and says it sent nothing", async () => {
		const { id } = await createProfile();
		const r = await call("GET", `/v1/http-profiles/${id}/test`);
		expect(r.json).toMatchObject({ profileId: id, ok: true });
		expect(r.json.checks.map((c: { check: string }) => c.check)).toEqual(["secret_decrypts", "allowed_origins", "bindings"]);
		expect(r.json.scope).toMatch(/nothing was sent/);
		// The wrong platform key: the test fails honestly, still without the value.
		env = { DB: d1.DB, KEY_ENCRYPTION_KEY: "b".repeat(64) } as unknown as Env;
		const wrong = await call("GET", `/v1/http-profiles/${id}/test`);
		expect(wrong.json.ok).toBe(false);
		expectNoSecret(wrong.raw);
	});
});

describe("ownership isolation — another owner sees nothing (#1123)", () => {
	it("every profile route reads 404 for a profile that is not yours, and changes nothing", async () => {
		const { id } = await createProfile();
		expect((await call("GET", "/v1/http-profiles", { uid: "bob" })).json.profiles).toEqual([]);
		for (const [m, p, b] of [
			["GET", `/v1/http-profiles/${id}`, undefined],
			["PATCH", `/v1/http-profiles/${id}`, { description: "mine now" }],
			["POST", `/v1/http-profiles/${id}/rotate`, { secret: ROTATED }],
			["GET", `/v1/http-profiles/${id}/test`, undefined],
			["DELETE", `/v1/http-profiles/${id}`, undefined],
		] as const) {
			const r = await call(m, p, { uid: "bob", body: b });
			expect(r.status, `${m} ${p}`).toBe(404);
			expectNoSecret(r.raw);
		}
		const row = d1.sqlite.prepare("SELECT description, secret_version FROM http_credential_profiles WHERE id = ?").get(id);
		expect(row).toEqual({ description: "Discord bot token", secret_version: 1 });
	});

	it("names are per owner: bob may hold a profile with alice's name", async () => {
		await createProfile("shared-name", "alice");
		await createProfile("shared-name", "bob");
		expect((await call("GET", "/v1/http-profiles", { uid: "bob" })).json.profiles).toHaveLength(1);
	});

	it("bob cannot bind alice's profile to his instance, nor his profile to alice's instance", async () => {
		const alice = await createProfile("a", "alice");
		const bob = await createProfile("b", "bob");
		expect((await call("PUT", `/v1/instances/${B1}/http-bindings/stolen`, { uid: "bob", body: { profileId: alice.id } })).status).toBe(404);
		expect((await call("PUT", `/v1/instances/${A1}/http-bindings/planted`, { uid: "bob", body: { profileId: bob.id } })).status).toBe(404);
		expect((await call("GET", `/v1/instances/${A1}/http-bindings`, { uid: "bob" })).status).toBe(404);
		expect((await call("DELETE", `/v1/instances/${A1}/http-bindings/x`, { uid: "bob" })).status).toBe(404);
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM http_credential_bindings").get()).toEqual({ n: 0 });
	});
});

describe("binding isolation — an instance reaches a profile only through its own binding (#1123)", () => {
	it("resolves for the bound instance only, and for no other instance, owner, connector or name", async () => {
		const { id } = await createProfile();
		const bind = await call("PUT", `/v1/instances/${A1}/http-bindings/discord`, { body: { profileId: id } });
		expect(bind.json.binding).toMatchObject({ bindingName: "discord", connector: "http", profileId: id, profileName: "discord-bot", allowedOrigins: ["https://discord.com"], secretVersion: 1 });
		const q = { userId: "alice", instanceId: A1, connector: "http", bindingName: "discord" };
		expect((await resolveBoundSecret(env, q))?.secret).toBe(SECRET);
		expect(await resolveBoundSecret(env, { ...q, instanceId: A2 })).toBeNull(); // same owner, unbound instance
		expect(await resolveBoundSecret(env, { ...q, userId: "bob" })).toBeNull(); // another owner naming alice's instance
		expect(await resolveBoundSecret(env, { ...q, userId: "bob", instanceId: B1 })).toBeNull();
		expect(await resolveBoundSecret(env, { ...q, connector: "discord" })).toBeNull();
		expect(await resolveBoundSecret(env, { ...q, bindingName: "other" })).toBeNull();
		expect((await call("GET", `/v1/instances/${A2}/http-bindings`)).json.bindings).toEqual([]);
		expect((await call("GET", `/v1/instances/${A1}/http-bindings`)).json.bindings).toHaveLength(1);
		// A planted row that crosses owners — instance bob's, profile alice's — still resolves to nothing.
		d1.exec(`INSERT INTO http_credential_bindings (id, profile_id, instance_id, user_id, binding_name) VALUES ('hcb_x', '${id}', '${B1}', 'bob', 'discord')`);
		expect(await resolveBoundSecret(env, { ...q, userId: "bob", instanceId: B1 })).toBeNull();
		expect((await call("GET", `/v1/instances/${B1}/http-bindings`, { uid: "bob" })).json.bindings).toEqual([]);
	});

	it("unbinding and deleting the profile both end access; the profile's bindings are listed on it", async () => {
		const { id } = await createProfile();
		await call("PUT", `/v1/instances/${A1}/http-bindings/discord`, { body: { profileId: id } });
		await call("PUT", `/v1/instances/${A2}/http-bindings/discord`, { body: { profileId: id } });
		expect((await call("GET", `/v1/http-profiles/${id}`)).json.profile.bindings).toHaveLength(2);
		expect((await call("DELETE", `/v1/instances/${A2}/http-bindings/discord`)).json).toEqual({ unbound: true });
		expect((await call("DELETE", `/v1/instances/${A2}/http-bindings/discord`)).status).toBe(404);
		expect(await resolveBoundSecret(env, { userId: "alice", instanceId: A2, connector: "http", bindingName: "discord" })).toBeNull();
		const del = await call("DELETE", `/v1/http-profiles/${id}`);
		expect(del.json).toEqual({ deleted: true, id, unbound: 1 });
		expect(await resolveBoundSecret(env, { userId: "alice", instanceId: A1, connector: "http", bindingName: "discord" })).toBeNull();
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM http_credential_bindings").get()).toEqual({ n: 0 });
	});

	it("deleting the agent cascades its instances' bindings and leaves the owner's profile", async () => {
		const { id } = await createProfile();
		await call("PUT", `/v1/instances/${A1}/http-bindings/discord`, { body: { profileId: id } });
		d1.sqlite.exec("PRAGMA foreign_keys = ON");
		await d1.DB.batch(agentDeleteStatements(d1.DB as unknown as D1Database, "agent-1", { cascadeSubscribers: true }));
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM http_credential_bindings").get()).toEqual({ n: 0 });
		expect((await call("GET", `/v1/http-profiles/${id}`)).json.profile.bindings).toEqual([]);
	});
});
