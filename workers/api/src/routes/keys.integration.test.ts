import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { keysRoutes } from "./keys.js";
import type { Env } from "../types.js";

/**
 * INTEGRATION test for the key-vault routes: request → auth (verifySession) → route
 * handler → REAL envelope crypto (encryptKey/decryptKey via WebCrypto) → a stateful
 * in-memory `user_api_keys` table → JSON response. The PUT→reveal round-trip proves the
 * bytes that leave the browser can only be recovered by the same owner, decrypted by the
 * real AES-256-GCM path — not a stub. Only the D1 boundary is faked (with real state).
 */

const SECRET = "keys-integration-secret";
// 32-byte (256-bit) KEK as 64 hex chars — the format importKek() expects for AES-KW.
const KEK_HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

interface KeyRow { user_id: string; provider: string; key_ciphertext: Uint8Array; dek_wrapped: Uint8Array; iv: Uint8Array; created_at: string; last_used_at: string | null }

/** A tiny stateful D1 stand-in backing only the tables these routes touch. */
function buildApp() {
	const keys: KeyRow[] = [];
	const find = (uid: string, provider: string) => keys.find((k) => k.user_id === uid && k.provider === provider);

	const env = {
		SESSION_SIGNING_KEY: SECRET,
		KEY_ENCRYPTION_KEY: KEK_HEX,
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async all() {
								if (sql.includes("FROM user_api_keys") && sql.includes("SELECT provider")) {
									const uid = args[0] as string;
									return { results: keys.filter((k) => k.user_id === uid).map((k) => ({ provider: k.provider, created_at: k.created_at, last_used_at: k.last_used_at })) };
								}
								return { results: [] };
							},
							async first() {
								if (sql.includes("SELECT key_ciphertext")) {
									const [uid, provider] = args as [string, string];
									const row = find(uid, provider);
									return row ? { key_ciphertext: row.key_ciphertext, dek_wrapped: row.dek_wrapped, iv: row.iv } : null;
								}
								return null;
							},
							async run() {
								if (sql.includes("INSERT INTO user_api_keys")) {
									const [uid, provider, ct, dw, iv] = args as [string, string, Uint8Array, Uint8Array, Uint8Array];
									const existing = find(uid, provider);
									if (existing) { existing.key_ciphertext = ct; existing.dek_wrapped = dw; existing.iv = iv; }
									else keys.push({ user_id: uid, provider, key_ciphertext: ct, dek_wrapped: dw, iv, created_at: "2026-08-01", last_used_at: null });
								} else if (sql.includes("DELETE FROM user_api_keys")) {
									const [uid, provider] = args as [string, string];
									const i = keys.findIndex((k) => k.user_id === uid && k.provider === provider);
									if (i >= 0) keys.splice(i, 1);
								} else if (sql.includes("UPDATE user_api_keys SET last_used_at")) {
									const [uid, provider] = args as [string, string];
									const row = find(uid, provider);
									if (row) row.last_used_at = "2026-08-02";
								}
								return { meta: { changes: 1 } };
							},
						};
					},
				};
			},
		},
	} as unknown as Env;

	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/keys", keysRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});
	return { app, env, keys };
}

const tokenFor = (uid: string) => signSession(uid, SECRET, { roles: ["user"] });

function json(app: Hono, env: unknown, method: string, path: string, body: unknown, tok: string) {
	return app.request(path, { method, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
}

describe("GET /v1/keys/providers (integration, no auth)", () => {
	it("lists the provider catalog without a token", async () => {
		const { app, env } = buildApp();
		const res = await app.request("/v1/keys/providers", {}, env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { providers: Array<{ id: string; name: string }> };
		expect(body.providers.map((p) => p.id)).toEqual(expect.arrayContaining(["openai", "anthropic"]));
	});
});

describe("PUT /v1/keys/:provider (integration)", () => {
	it("401s without a token", async () => {
		const { app, env } = buildApp();
		const res = await app.request("/v1/keys/openai", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "sk-abc" }) }, env);
		expect(res.status).toBe(401);
	});

	it("400s an unknown provider", async () => {
		const { app, env } = buildApp();
		const res = await json(app, env, "PUT", "/v1/keys/madeup", { key: "x" }, await tokenFor("u1"));
		expect(res.status).toBe(400);
		expect((await res.json() as any).error).toContain("Unknown provider");
	});

	it("400s a key whose prefix doesn't match the provider (real validation)", async () => {
		const { app, env } = buildApp();
		const res = await json(app, env, "PUT", "/v1/keys/anthropic", { key: "sk-not-anthropic" }, await tokenFor("u1"));
		expect(res.status).toBe(400);
		expect((await res.json() as any).error).toContain("sk-ant-");
	});

	it("stores an encrypted key (ciphertext is NOT the plaintext)", async () => {
		const { app, env, keys } = buildApp();
		const res = await json(app, env, "PUT", "/v1/keys/openai", { key: "sk-secret-plaintext-value" }, await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true, provider: "openai" });
		expect(keys).toHaveLength(1);
		// The stored bytes are ciphertext, never the plaintext.
		const asText = new TextDecoder().decode(keys[0].key_ciphertext);
		expect(asText).not.toContain("sk-secret-plaintext-value");
		expect(keys[0].dek_wrapped.byteLength).toBeGreaterThan(0);
	});
});

describe("PUT → reveal round-trip (integration, real AES-256-GCM)", () => {
	it("reveals exactly the plaintext the owner stored", async () => {
		const { app, env } = buildApp();
		const tok = await tokenFor("owner-1");
		await json(app, env, "PUT", "/v1/keys/openai", { key: "sk-round-trip-1234567890" }, tok);
		const res = await app.request("/v1/keys/openai/reveal", { headers: { Authorization: `Bearer ${tok}` } }, env);
		expect(res.status).toBe(200);
		expect((await res.json() as any).key).toBe("sk-round-trip-1234567890");
	});

	it("404s reveal for a different user (owner scoping — can't read another's key)", async () => {
		const { app, env } = buildApp();
		await json(app, env, "PUT", "/v1/keys/openai", { key: "sk-owner-only-000000" }, await tokenFor("owner-1"));
		const other = await tokenFor("attacker-2");
		const res = await app.request("/v1/keys/openai/reveal", { headers: { Authorization: `Bearer ${other}` } }, env);
		expect(res.status).toBe(404);
	});
});

describe("GET /v1/keys/status + DELETE (integration)", () => {
	it("reflects stored keys, then clears them on delete", async () => {
		const { app, env } = buildApp();
		const tok = await tokenFor("u1");
		await json(app, env, "PUT", "/v1/keys/openai", { key: "sk-x1234567890abc" }, tok);

		const before = await (await app.request("/v1/keys/status", { headers: { Authorization: `Bearer ${tok}` } }, env)).json() as any;
		expect(before.providers.find((p: any) => p.id === "openai").hasKey).toBe(true);
		expect(before.providers.find((p: any) => p.id === "anthropic").hasKey).toBe(false);

		const del = await json(app, env, "DELETE", "/v1/keys/openai", undefined, tok);
		expect(del.status).toBe(200);

		const after = await (await app.request("/v1/keys/status", { headers: { Authorization: `Bearer ${tok}` } }, env)).json() as any;
		expect(after.providers.find((p: any) => p.id === "openai").hasKey).toBe(false);
	});
});
