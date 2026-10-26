/** #1314: the actual provider wire and real verify route establish/clear holds, on the real schema. */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { encryptKey } from "./crypto.js";
import { automaticProviderHold, observeProviderAccount, providerCredentialId } from "./provider-account-hold.js";
import { runUserWorkersAi } from "./user-ai.js";
import { probeProviderKey } from "./provider-hold-probe.js";
import { keysRoutes } from "../routes/keys.js";
import { HttpError } from "./auth.js";
import { signSession } from "./session.js";
import type { Env } from "../types.js";
const KEK = "37".repeat(32), KEY = "not-a-real-provider-key", REPLACEMENT = "not-a-real-replacement-key";
const CF = { accountId: "audit-account", token: "not-a-real-cloudflare-token" };
let d1: RealSchemaD1, env: Env;
const body = { messages: [{ role: "user", content: "verify" }], maxTokens: 4 };
async function storeKey(provider: string, credential: string) {
	const e = await encryptKey(credential, KEK);
	await d1.DB.prepare("INSERT INTO user_api_keys(user_id,provider,account_id,key_ciphertext,dek_wrapped,iv) VALUES('u1',?1,'',?2,?3,?4) ON CONFLICT(user_id,provider,account_id) DO UPDATE SET key_ciphertext=excluded.key_ciphertext,dek_wrapped=excluded.dek_wrapped,iv=excluded.iv")
		.bind(provider, e.ciphertext, e.dekWrapped, e.iv).run();
}
const holds = () => d1.sqlite.prepare("SELECT provider,credential_id,failure_class,cleared_at FROM provider_account_holds").all() as Array<{ provider: string; credential_id: string; failure_class: string; cleared_at: number | null }>;
function success() {
	const events = [{ type: "message_start", message: { usage: { input_tokens: 1 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, { type: "message_stop" }];
	return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}
beforeEach(async () => {
	d1 = realSchemaD1(); seedTenant(d1, { userId: "u1", instanceIds: ["coder"] });
	env = { DB: d1.DB, KEY_ENCRYPTION_KEY: KEK, SESSION_SIGNING_KEY: "audit-session" } as unknown as Env;
	await storeKey("anthropic", KEY);
});
afterEach(() => { d1.close(); vi.unstubAllGlobals(); });

describe("the exact credential observed on the wire", () => {
	it("probes the held Haiku model: its 403 stays held until that same model succeeds", async () => {
		const model = "claude-haiku-5-5";
		const requested: string[] = [];
		let allowHaiku = false;
		vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
			const sent = JSON.parse(init?.body as string) as { model: string };
			requested.push(sent.model);
			return sent.model === model && !allowHaiku
				? Response.json({ error: { type: "permission_error", message: "Request not allowed for this model" } }, { status: 403 })
				: success();
		}));
		await expect(runUserWorkersAi(env, "u1", model, body, undefined, { anthropicModel: model })).rejects.toThrow("Request not allowed for this model");
		expect(holds()).toMatchObject([{ failure_class: "provider_credentials", cleared_at: null }]);
		expect(await probeProviderKey(env, "u1", "anthropic", model)).toMatchObject({ ok: false, error: expect.stringContaining("Request not allowed for this model") });
		expect(requested).toEqual([model, model]);
		expect(holds()[0].cleared_at).toBeNull();
		allowHaiku = true;
		expect(await probeProviderKey(env, "u1", "anthropic", model)).toEqual({ ok: true });
		expect(requested).toEqual([model, model, model]);
		expect(holds()[0].cleared_at).toEqual(expect.any(Number));
	});

	it.each([[400, "Your credit balance is too low to access the Anthropic API.", "provider_credit"], [401, "invalid x-api-key", "provider_credentials"]] as const)("Anthropic %i persists the hold; the owner can explicitly verify that same key to recover", async (status, message, failureClass) => {
		const fetch = vi.fn(async () => Response.json({ error: { message } }, { status })); vi.stubGlobal("fetch", fetch);
		await expect(runUserWorkersAi(env, "u1", "claude-sonnet-4-6", body, undefined, { provider: "anthropic" })).rejects.toThrow(message);
		expect(holds()).toMatchObject([{ provider: "anthropic", credential_id: await providerCredentialId("anthropic", KEY), failure_class: failureClass, cleared_at: null }]);
		fetch.mockImplementation(async () => success());
		const app = new Hono<{ Bindings: Env }>(); app.route("/v1/keys", keysRoutes);
		app.onError((e, c) => { if (e instanceof HttpError) return c.json({ error: e.message }, e.status as 400); throw e; });
		const session = await signSession("u1", "audit-session");
		const response = await app.request("/v1/keys/anthropic/verify", { method: "POST", headers: { Authorization: `Bearer ${session}` } }, env);
		expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ ok: true, provider: "anthropic" });
		expect(holds()[0].cleared_at).toEqual(expect.any(Number));
	});

	it("Cloudflare auth uses account+token identity, including legacy serialized credentials, and success clears only that provider", async () => {
		await storeKey("cloudflare", `${CF.accountId}:${CF.token}`);
		await observeProviderAccount(env, "u1", "anthropic", KEY, "provider_credit");
		const fetch = vi.fn(async () => Response.json({ errors: [{ message: "not authorized" }] }, { status: 403 })); vi.stubGlobal("fetch", fetch);
		await expect(runUserWorkersAi(env, "u1", "@cf/meta/llama-4-scout-17b-16e-instruct", body, undefined, { provider: "cloudflare" })).rejects.toThrow("HTTP 403");
		expect(holds().find((h) => h.provider === "cloudflare")).toMatchObject({ credential_id: await providerCredentialId("cloudflare", CF), failure_class: "provider_credentials", cleared_at: null });
		fetch.mockImplementation(async () => Response.json({ success: true, result: { response: "ok" } }));
		await runUserWorkersAi(env, "u1", "@cf/meta/llama-4-scout-17b-16e-instruct", body, undefined, { provider: "cloudflare" });
		expect(holds().find((h) => h.provider === "cloudflare")?.cleared_at).toEqual(expect.any(Number));
		expect(holds().find((h) => h.provider === "anthropic")?.cleared_at).toBeNull();
	});

	it("an in-flight old-key rejection cannot bind the key the owner replaced while it was running", async () => {
		let request!: () => void, answer!: (r: Response) => void;
		const sent = new Promise<void>((resolve) => { request = resolve; });
		vi.stubGlobal("fetch", vi.fn(() => { request(); return new Promise<Response>((resolve) => { answer = resolve; }); }));
		const failed = expect(runUserWorkersAi(env, "u1", "claude-sonnet-4-6", body, undefined, { provider: "anthropic" })).rejects.toThrow("invalid x-api-key");
		await sent; await storeKey("anthropic", REPLACEMENT);
		answer(Response.json({ error: { message: "invalid x-api-key" } }, { status: 401 })); await failed;
		expect(holds()[0]).toMatchObject({ credential_id: await providerCredentialId("anthropic", KEY), cleared_at: null });
		expect(await automaticProviderHold(env, "coder", "u1")).toBeNull();
	});

	it.each([400, 429, 500])("an unrelated provider HTTP %i does not invent an account hold", async (status) => {
		vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "Unrelated request failure" } }, { status })));
		await expect(runUserWorkersAi(env, "u1", "claude-sonnet-4-6", body, undefined, { provider: "anthropic" })).rejects.toThrow("Unrelated request failure");
		expect(holds()).toEqual([]);
	});
});
