import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { keysRoutes } from "./keys.js";
import type { Env } from "../types.js";

/**
 * Readers for JSON that came back from a route, for use in assertions.
 *
 * Every field is `unknown`, not `any`. These response shapes are not declared types anywhere in
 * the worker, so an interface written here would be a second source of truth that nothing keeps
 * in step — and the compiler would then vouch for it. `unknown` leaves the `expect` below as the
 * only thing making a claim about the shape, which is what a test is for.
 */
const jsonBody = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;
const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v : []);

/**
 * INTEGRATION test for the key-vault routes: request → auth (verifySession) → route
 * handler → REAL envelope crypto (encryptKey/decryptKey via WebCrypto) → a stateful
 * in-memory `user_api_keys` table → JSON response. The PUT→reveal round-trip proves the
 * bytes that leave the browser can only be recovered by the same owner, decrypted by the
 * real AES-256-GCM path — not a stub. Only the D1 boundary is faked (with real state).
 *
 * Fixture keys keep the `sk-` prefix, because provider-shape validation is genuinely under
 * test here ("`sk-…` without `sk-ant-` is an OpenAI-shaped key in the Anthropic slot"), and
 * are otherwise deliberately low-entropy and self-labelling (#295). The previous ones ended in
 * long digit runs, which was enough for gitleaks to report them as real keys — in a file whose
 * whole subject is key handling, which is the worst possible place for a scanner to be crying
 * wolf. They are not reproduced here, because a comment quoting the value it removed is scanned
 * exactly like the value was. Nothing asserts on entropy or length; the round-trip only needs
 * the string that went in to come back out.
 */

const SECRET = "keys-integration-secret";
// 32-byte (256-bit) KEK as 64 hex chars — the format importKek() expects for AES-KW.
const KEK_HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

interface KeyRow { user_id: string; provider: string; account_id: string; key_ciphertext: Uint8Array; dek_wrapped: Uint8Array; iv: Uint8Array; created_at: string; last_used_at: string | null; key_hint: string | null }

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
									// `key_hint` mirrors the route's `MAX(CASE WHEN account_id = '' …)`: only the
									// unnamed default slot contributes one (#780).
									return { results: keys.filter((k) => k.user_id === uid).map((k) => ({ provider: k.provider, created_at: k.created_at, last_used_at: k.last_used_at, key_hint: k.account_id === "" ? k.key_hint : null })) };
								}
								return { results: [] };
							},
							async first() {
								if (sql.includes("SELECT key_ciphertext")) {
									// The Cloudflare read names its provider in the SQL and binds only the user.
									const uid = args[0] as string;
									const provider = sql.includes("provider = 'cloudflare'") ? "cloudflare" : (args[1] as string);
									const row = find(uid, provider);
									return row ? { key_ciphertext: row.key_ciphertext, dek_wrapped: row.dek_wrapped, iv: row.iv, account_id: row.account_id, key_hint: row.key_hint } : null;
								}
								return null;
							},
							async run() {
								if (sql.includes("INSERT INTO user_api_keys")) {
									const [uid, provider, ct, dw, iv, hint] = args as [string, string, Uint8Array, Uint8Array, Uint8Array, string | null];
									const existing = find(uid, provider);
									// `key_hint = excluded.key_hint` in the route, not a COALESCE: a replaced key
									// replaces which key this is, so a stale hint would name the one just removed.
									if (existing) { existing.key_ciphertext = ct; existing.dek_wrapped = dw; existing.iv = iv; existing.key_hint = hint; }
									else keys.push({ user_id: uid, provider, account_id: "", key_ciphertext: ct, dek_wrapped: dw, iv, created_at: "2026-08-01", last_used_at: null, key_hint: hint });
								} else if (sql.includes("DELETE FROM user_api_keys")) {
									const [uid, provider] = args as [string, string];
									const i = keys.findIndex((k) => k.user_id === uid && k.provider === provider);
									if (i >= 0) keys.splice(i, 1);
								} else if (sql.includes("UPDATE user_api_keys SET last_used_at")) {
									const [uid, provider] = args as [string, string];
									const row = find(uid, provider);
									if (row) row.last_used_at = "2026-08-02";
								} else if (sql.includes("UPDATE user_api_keys SET key_hint")) {
									// The lazy backfill (#780). `AND key_hint IS NULL` is modelled, because the
									// one-shot property is the point — a second call must not rewrite the row.
									const [hint, uid, provider, accountId] = args as [string, string, string, string];
									const row = keys.find((k) => k.user_id === uid && k.provider === provider && k.account_id === accountId && k.key_hint === null);
									if (row) row.key_hint = hint;
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

function json(app: Hono<{ Bindings: Env }>, env: Env, method: string, path: string, body: unknown, tok: string) {
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
		expect((await jsonBody(res)).error).toContain("Unknown provider");
	});

	it("400s a key that clearly belongs to ANOTHER provider (real validation)", async () => {
		// `sk-…` without `sk-ant-` is an OpenAI-shaped key in the Anthropic slot.
		const { app, env } = buildApp();
		const res = await json(app, env, "PUT", "/v1/keys/anthropic", { key: "sk-not-anthropic" }, await tokenFor("u1"));
		expect(res.status).toBe(400);
		expect((await jsonBody(res)).error).toContain("OpenAI");
	});

	it("ACCEPTS a shape we don't recognise — a provider changing format must not lock users out", async () => {
		// The regression this replaced: AI Studio started issuing `AQ.…` keys while the check
		// still demanded `AIza…`, so a working key could not be saved at all.
		const { app, env } = buildApp();
		const res = await json(app, env, "PUT", "/v1/keys/google", { key: "AQ.Ab8RN6-new-format" }, await tokenFor("u1"));
		expect(res.status).toBe(200);
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
		await json(app, env, "PUT", "/v1/keys/openai", { key: "sk-example-roundtrip-not-a-real-key" }, tok);
		const res = await app.request("/v1/keys/openai/reveal", { headers: { Authorization: `Bearer ${tok}` } }, env);
		expect(res.status).toBe(200);
		expect((await jsonBody(res)).key).toBe("sk-example-roundtrip-not-a-real-key");
	});

	it("404s reveal for a different user (owner scoping — can't read another's key)", async () => {
		const { app, env } = buildApp();
		await json(app, env, "PUT", "/v1/keys/openai", { key: "sk-example-owner-scoped-not-a-real-key" }, await tokenFor("owner-1"));
		const other = await tokenFor("attacker-2");
		const res = await app.request("/v1/keys/openai/reveal", { headers: { Authorization: `Bearer ${other}` } }, env);
		expect(res.status).toBe(404);
	});
});

describe("GET /v1/keys/status + DELETE (integration)", () => {
	it("reflects stored keys, then clears them on delete", async () => {
		const { app, env } = buildApp();
		const tok = await tokenFor("u1");
		await json(app, env, "PUT", "/v1/keys/openai", { key: "sk-status-example-not-a-real-key" }, tok);

		const before = await jsonBody(await app.request("/v1/keys/status", { headers: { Authorization: `Bearer ${tok}` } }, env));
		expect(rows(before.providers).find((p) => p.id === "openai")?.hasKey).toBe(true);
		expect(rows(before.providers).find((p) => p.id === "anthropic")?.hasKey).toBe(false);

		const del = await json(app, env, "DELETE", "/v1/keys/openai", undefined, tok);
		expect(del.status).toBe(200);

		const after = await jsonBody(await app.request("/v1/keys/status", { headers: { Authorization: `Bearer ${tok}` } }, env));
		expect(rows(after.providers).find((p) => p.id === "openai")?.hasKey).toBe(false);
	});
});

/**
 * The non-secret last-4 hint (#780, migration 0146).
 *
 * The panel could say "Stored" but not WHICH key was stored, so an owner with several Anthropic
 * keys could not tell whether the one being spent elsewhere was the one PAGS holds. The hint is
 * four characters, in the clear, and — critically — reachable WITHOUT `/reveal`: decrypting a
 * whole secret to render four characters would turn a deliberate, rate-limited, audited action
 * into an automatic one on every page load.
 */
describe("key hint on /v1/keys/status (integration)", () => {
	const KEY = "sk-hint-example-not-a-real-key-4f2a";

	it("returns the last 4 characters of a newly stored key, and never more", async () => {
		const { app, env } = buildApp();
		const tok = await tokenFor("u1");
		await json(app, env, "PUT", "/v1/keys/openai", { key: KEY }, tok);

		const body = await jsonBody(await app.request("/v1/keys/status", { headers: { Authorization: `Bearer ${tok}` } }, env));
		const openai = rows(body.providers).find((p) => p.id === "openai");
		expect(openai?.keyHint).toBe("4f2a");
		expect(KEY.endsWith(openai?.keyHint as string)).toBe(true);
	});

	it("leaks no more of the key than the hint, anywhere in the response", async () => {
		// The bound asserted on the SERIALISED body, not on one field: a future addition that put
		// a longer slice on some other field would pass a per-field check and fail this one.
		const { app, env } = buildApp();
		const tok = await tokenFor("u1");
		await json(app, env, "PUT", "/v1/keys/openai", { key: KEY }, tok);

		const raw = await (await app.request("/v1/keys/status", { headers: { Authorization: `Bearer ${tok}` } }, env)).text();
		expect(raw).toContain("4f2a");
		// Five characters of the tail, and the whole key, must both be absent.
		expect(raw).not.toContain(KEY.slice(-5));
		expect(raw).not.toContain(KEY);
		// Nor any interior run of the key — the middle is never stored and never returned.
		expect(raw).not.toContain("example-not-a-real");
	});

	it("does NOT come from /reveal — the status route decrypts nothing", async () => {
		// Modelled by removing the KEK: /reveal 500s without it, while status still answers with
		// the hint. If the hint were sourced from a decrypt, this would fail.
		const { app, env, keys } = buildApp();
		const tok = await tokenFor("u1");
		await json(app, env, "PUT", "/v1/keys/openai", { key: KEY }, tok);
		expect(keys[0].key_hint).toBe("4f2a");

		const noKek = { ...env, KEY_ENCRYPTION_KEY: undefined } as unknown as typeof env;
		const reveal = await app.request("/v1/keys/openai/reveal", { headers: { Authorization: `Bearer ${tok}` } }, noKek);
		expect(reveal.status).toBe(500);

		const body = await jsonBody(await app.request("/v1/keys/status", { headers: { Authorization: `Bearer ${tok}` } }, noKek));
		expect(rows(body.providers).find((p) => p.id === "openai")?.keyHint).toBe("4f2a");
	});

	it("is scoped to the owner — a second account sees its own hint, never the first's", async () => {
		const { app, env } = buildApp();
		const owner = await tokenFor("owner-1");
		const other = await tokenFor("attacker-2");
		await json(app, env, "PUT", "/v1/keys/openai", { key: KEY }, owner);

		const seen = await (await app.request("/v1/keys/status", { headers: { Authorization: `Bearer ${other}` } }, env)).text();
		expect(seen).not.toContain("4f2a");
		expect(rows(((await jsonBody(await app.request("/v1/keys/status", { headers: { Authorization: `Bearer ${other}` } }, env))).providers)).find((p) => p.id === "openai")?.keyHint).toBeNull();

		// And the second account's own key gets its own hint, not the first's.
		await json(app, env, "PUT", "/v1/keys/openai", { key: "sk-second-account-not-a-real-key-9b71" }, other);
		const mine = await jsonBody(await app.request("/v1/keys/status", { headers: { Authorization: `Bearer ${other}` } }, env));
		expect(rows(mine.providers).find((p) => p.id === "openai")?.keyHint).toBe("9b71");
		const theirs = await jsonBody(await app.request("/v1/keys/status", { headers: { Authorization: `Bearer ${owner}` } }, env));
		expect(rows(theirs.providers).find((p) => p.id === "openai")?.keyHint).toBe("4f2a");
	});

	it("names the NEW key after a replacement, not the one taken out of the slot", async () => {
		const { app, env } = buildApp();
		const tok = await tokenFor("u1");
		await json(app, env, "PUT", "/v1/keys/openai", { key: KEY }, tok);
		await json(app, env, "PUT", "/v1/keys/openai", { key: "sk-rotated-example-not-a-real-key-c07e" }, tok);

		const body = await jsonBody(await app.request("/v1/keys/status", { headers: { Authorization: `Bearer ${tok}` } }, env));
		expect(rows(body.providers).find((p) => p.id === "openai")?.keyHint).toBe("c07e");
	});

	it("a key stored before the column existed gains its hint on the next USE, with no re-entry", async () => {
		// The migration is an ALTER TABLE, so every pre-existing row starts null. The owner must
		// not have to re-paste a key the platform already holds — the same lazy backfill
		// 0035_gmail_account_label.sql established on this table.
		const { app, env, keys } = buildApp();
		const tok = await tokenFor("u1");
		await json(app, env, "PUT", "/v1/keys/openai", { key: KEY }, tok);
		keys[0].key_hint = null; // as an ALTER TABLE leaves it

		const before = await jsonBody(await app.request("/v1/keys/status", { headers: { Authorization: `Bearer ${tok}` } }, env));
		expect(rows(before.providers).find((p) => p.id === "openai")?.keyHint).toBeNull();

		// A use that already decrypts. /reveal is one of them; it is NOT how the panel reads the
		// hint (the test above pins that), only one of the paths that happens to hold plaintext.
		expect((await app.request("/v1/keys/openai/reveal", { headers: { Authorization: `Bearer ${tok}` } }, env)).status).toBe(200);

		const after = await jsonBody(await app.request("/v1/keys/status", { headers: { Authorization: `Bearer ${tok}` } }, env));
		expect(rows(after.providers).find((p) => p.id === "openai")?.keyHint).toBe("4f2a");
	});
});

// Self-labelling fixtures: a Cloudflare account ID is 32 hex characters, the token anything else.
const CF_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const CF_TOKEN = "cf-token-fixture-not-a-real-token-000000";
const ANTHROPIC_KEY = "sk-ant-integration-fixture-anthropic";

describe("PUT /v1/keys/cloudflare — account-ID shape (#893)", () => {
	it("400s a swapped token/account-ID pair, stores nothing, and quotes neither value", async () => {
		const { app, env, keys } = buildApp();
		const res = await json(app, env, "PUT", "/v1/keys/cloudflare", { accountId: CF_TOKEN, key: CF_ACCOUNT_ID }, await tokenFor("u1"));
		expect(res.status).toBe(400);
		const text = await res.text();
		expect(text).toMatch(/swapped/);
		expect(text).not.toContain(CF_TOKEN);
		expect(text).not.toContain(CF_ACCOUNT_ID);
		expect(keys).toHaveLength(0);
	});

	it("stores a well-formed pair", async () => {
		const { app, env, keys } = buildApp();
		const res = await json(app, env, "PUT", "/v1/keys/cloudflare", { accountId: CF_ACCOUNT_ID, key: CF_TOKEN }, await tokenFor("u1"));
		expect(res.status).toBe(200);
		expect(keys).toHaveLength(1);
	});
});

describe("POST /v1/keys/cloudflare/verify probes Cloudflare, not Anthropic (#892)", () => {
	afterEach(() => vi.unstubAllGlobals());

	/** Every outbound request, so a test can say which provider was asked. */
	function stubUpstreams(cloudflare: () => Response) {
		const calls: string[] = [];
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			calls.push(url);
			if (url.startsWith("https://api.cloudflare.com/")) return cloudflare();
			// Anything reaching Anthropic is the defect; answer as a working key would, so the old
			// code path reports "ok" and the test fails on the assertion rather than on a crash.
			return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
		}));
		return calls;
	}

	async function withBothKeys(accountId: string) {
		const { app, env } = buildApp();
		const tok = await tokenFor("u1");
		expect((await json(app, env, "PUT", "/v1/keys/anthropic", { key: ANTHROPIC_KEY }, tok)).status).toBe(200);
		expect((await json(app, env, "PUT", "/v1/keys/cloudflare", { accountId, key: CF_TOKEN }, tok)).status).toBe(200);
		return { app, env, tok };
	}

	it("reports bad Cloudflare credentials as NOT ok, with an Anthropic key also stored, and never calls Anthropic", async () => {
		const { app, env, tok } = await withBothKeys(CF_ACCOUNT_ID);
		const calls = stubUpstreams(() => new Response(JSON.stringify({
			success: false,
			errors: [{ code: 7003, message: `Could not route to /client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/meta/llama-3.2-3b-instruct, perhaps your object identifier is invalid?` }],
		}), { status: 404 }));

		const res = await json(app, env, "POST", "/v1/keys/cloudflare/verify", undefined, tok);
		const text = await res.text();
		const body = JSON.parse(text) as Record<string, unknown>;
		expect(body.ok).toBe(false);
		expect(body.upstreamStatus).toBe(404);
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.every((u) => u.startsWith(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/`))).toBe(true);
		// Cloudflare's own error text comes back in `details`, with the account path masked.
		expect(text).toContain("/accounts/••••/");
		expect(text).not.toContain(CF_ACCOUNT_ID);
		expect(text).not.toContain(CF_TOKEN);
	});

	it("reports good Cloudflare credentials as ok, from Cloudflare's answer", async () => {
		const { app, env, tok } = await withBothKeys(CF_ACCOUNT_ID);
		const calls = stubUpstreams(() => new Response(JSON.stringify({ success: true, result: { response: "ok" } }), { status: 200 }));
		const res = await json(app, env, "POST", "/v1/keys/cloudflare/verify", undefined, tok);
		expect(((await res.json()) as Record<string, unknown>).ok).toBe(true);
		expect(calls.every((u) => u.startsWith("https://api.cloudflare.com/"))).toBe(true);
	});

	it("404s plainly when no Cloudflare credentials are stored, rather than verifying the Anthropic key", async () => {
		const { app, env } = buildApp();
		const tok = await tokenFor("u1");
		await json(app, env, "PUT", "/v1/keys/anthropic", { key: ANTHROPIC_KEY }, tok);
		const calls = stubUpstreams(() => new Response("{}", { status: 500 }));
		const res = await json(app, env, "POST", "/v1/keys/cloudflare/verify", undefined, tok);
		expect(res.status).toBe(404);
		expect(calls).toHaveLength(0);
	});
});
