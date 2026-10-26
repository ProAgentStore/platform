/**
 * #1356 — the shared driver, over the real schema, for BOTH providers: a refusal's kind decides the account's hold, a success records the key's
 * use and clears a hold in one round trip, and neither provider's adapter has a private way of doing either.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptKey } from "./crypto.js";
import { classifyCodingFailure } from "./coding-failure.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { providerCredentialId, observeProviderAccount, LAST_USED_GRANULARITY_SECONDS } from "./provider-account-observation.js";
import { providerErrorKind } from "./provider-error-kind.js";
import { runUserWorkersAi, UserAiProviderError, UserAiUnsupportedInputError, encodeCloudflareAiCredentials } from "./user-ai.js";
import type { Env } from "../types.js";

const KEK = "29".repeat(32);
const ANTHROPIC_KEY = "sk-ant-not-a-real-key-1234";
const CF = { accountId: "acct-1", token: "cf-not-a-real-token" };
let d1: RealSchemaD1;
let env: Env;
let batches: number;
let failBatch: boolean;

async function store(provider: "anthropic" | "cloudflare", value: string) {
	const e = await encryptKey(value, KEK);
	await d1.DB.prepare("INSERT INTO user_api_keys(user_id,provider,account_id,key_ciphertext,dek_wrapped,iv) VALUES('u1',?1,?2,?3,?4,?5)").bind(provider, provider === "cloudflare" ? CF.accountId : "", e.ciphertext, e.dekWrapped, e.iv).run();
}

beforeEach(async () => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	batches = 0;
	failBatch = false;
	const DB = new Proxy(d1.DB, {
		get(target, prop) {
			if (prop === "batch") {
				return (stmts: unknown[]) => {
					batches++;
					return failBatch ? Promise.reject(new Error("d1 blip")) : target.batch(stmts as never);
				};
			}
			const v = Reflect.get(target, prop);
			return typeof v === "function" ? v.bind(target) : v;
		},
	});
	env = { DB, KEY_ENCRYPTION_KEY: KEK } as unknown as Env;
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
	d1.close();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const anthropicOk = () => {
	const frame = (e: Record<string, unknown>) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
	const body = [
		frame({ type: "message_start", message: { usage: { input_tokens: 5 } } }),
		frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
		frame({ type: "content_block_stop", index: 0 }),
		frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }),
		frame({ type: "message_stop" }),
	].join("");
	return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
};
const anthropicRefusal = (status: number, message: string, type = "invalid_request_error") => Response.json({ type: "error", error: { type, message } }, { status, headers: { "request-id": "req_1" } });
const cloudflareRefusal = (status: number) => Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status, headers: { "cf-ray": "ray1" } });
const call = (model = "claude-sonnet-4-6") => runUserWorkersAi(env, "u1", model, { messages: [{ role: "user", content: "hi" }] });
const lastUsed = (provider: string) => (d1.sqlite.prepare("SELECT last_used_at AS at FROM user_api_keys WHERE user_id = 'u1' AND provider = ?").get(provider) as { at: string | null }).at;
const holds = () => d1.sqlite.prepare("SELECT provider, failure_class AS cls, cleared_at AS cleared FROM provider_account_holds ORDER BY provider").all() as Array<{ provider: string; cls: string; cleared: number | null }>;

describe("a refusal's kind decides the account's hold, for both providers", () => {
	it.each([
		["a balance failure on a 400", () => anthropicRefusal(400, "Your credit balance is too low to access the Anthropic API."), "credit", "provider_credit"],
		["a balance failure that arrives on a 401", () => anthropicRefusal(401, "Your credit balance is too low", "authentication_error"), "credit", "provider_credit"],
		["a refused key", () => anthropicRefusal(401, "invalid x-api-key", "authentication_error"), "credentials", "provider_credentials"],
		["a 403 the platform re-checks", () => anthropicRefusal(403, "Request not allowed", "permission_error"), "credentials", "provider_credentials"],
	] as const)("Anthropic, %s → kind %s, hold %s", async (_name, reply, kind, holdClass) => {
		await store("anthropic", ANTHROPIC_KEY);
		vi.stubGlobal("fetch", async () => reply());
		const err = (await call().catch((e) => e)) as UserAiProviderError;
		expect(err).toBeInstanceOf(UserAiProviderError);
		expect(err.kind).toBe(kind);
		expect(providerErrorKind(new Error(err.message))).toBe(kind); // survives a step boundary
		expect(holds()).toEqual([{ provider: "anthropic", cls: holdClass, cleared: null }]);
	});

	it("a refusal that is neither credit nor credentials opens no hold: a throttle, a provider failure, a malformed request", async () => {
		await store("anthropic", ANTHROPIC_KEY);
		for (const [status, message, kind] of [[429, "rate limited", "rate_limit"], [529, "overloaded", "server"], [400, "messages: roles must alternate", "other"], [404, "model: nope", "model_access"]] as const) {
			vi.stubGlobal("fetch", async () => anthropicRefusal(status, message));
			const err = (await call().catch((e) => e)) as UserAiProviderError;
			expect(err.kind, String(status)).toBe(kind);
		}
		expect(holds()).toEqual([]);
	});

	it("Cloudflare: a refused credential opens a credentials hold; its kind is the same vocabulary", async () => {
		await store("cloudflare", encodeCloudflareAiCredentials(CF.accountId, CF.token));
		vi.stubGlobal("fetch", async () => cloudflareRefusal(403));
		const err = (await call("@cf/meta/llama-3.2-3b-instruct").catch((e) => e)) as UserAiProviderError;
		expect(err.kind).toBe("credentials");
		expect(err.message).toMatch(/HTTP 403: Authentication error/);
		expect(classifyCodingFailure(new Error(err.message)).class).toBe("provider_credentials");
		expect(holds()).toEqual([{ provider: "cloudflare", cls: "provider_credentials", cleared: null }]);
	});

	it("the owner-facing remedy follows the kind: a 401 names the key page, a balance failure names the billing page", async () => {
		await store("anthropic", ANTHROPIC_KEY);
		vi.stubGlobal("fetch", async () => anthropicRefusal(401, "invalid x-api-key", "authentication_error"));
		expect(((await call().catch((e) => e)) as Error).message).toContain("Invalid API key. Update it in Profile → API Keys → Anthropic");
		vi.stubGlobal("fetch", async () => anthropicRefusal(400, "Your credit balance is too low"));
		const credit = ((await call().catch((e) => e)) as Error).message;
		expect(credit).toContain("has insufficient balance");
		expect(credit).toContain(`ending in ${ANTHROPIC_KEY.slice(-4)}`);
	});
});

describe("a success is recorded once, in one round trip (#1356)", () => {
	it.each([
		["Anthropic", "anthropic", () => store("anthropic", ANTHROPIC_KEY), () => anthropicOk(), "claude-sonnet-4-6"],
		["Cloudflare", "cloudflare", () => store("cloudflare", encodeCloudflareAiCredentials(CF.accountId, CF.token)), () => Response.json({ success: true, result: { response: "hi" } }), "@cf/meta/llama-3.2-3b-instruct"],
	] as const)("%s: one batch, last_used_at set", async (_n, provider, setup, reply, model) => {
		await setup();
		vi.stubGlobal("fetch", async () => reply());
		await call(model);
		expect(batches).toBe(1);
		expect(lastUsed(provider)).not.toBeNull();
	});

	it("clears an open hold on THIS credential in the same round trip, and leaves another credential's hold alone", async () => {
		await store("anthropic", ANTHROPIC_KEY);
		await observeProviderAccount(env, "u1", "anthropic", ANTHROPIC_KEY, "provider_credentials", Date.now() - 5_000, "claude-sonnet-4-6");
		await observeProviderAccount(env, "u1", "anthropic", "sk-ant-some-OTHER-key", "provider_credit", Date.now() - 5_000, "claude-sonnet-4-6");
		expect(holds().filter((h) => h.cleared === null)).toHaveLength(2);
		vi.stubGlobal("fetch", async () => anthropicOk());
		batches = 0;
		await call();
		expect(batches).toBe(1);
		const open = d1.sqlite.prepare("SELECT credential_id AS id FROM provider_account_holds WHERE cleared_at IS NULL").all() as Array<{ id: string }>;
		expect(open).toHaveLength(1);
		expect(open[0].id).toBe(await providerCredentialId("anthropic", "sk-ant-some-OTHER-key"));
	});

	it(`moves last_used_at at most once per ${LAST_USED_GRANULARITY_SECONDS}s: inside the window a call writes no row for it`, async () => {
		await store("anthropic", ANTHROPIC_KEY);
		vi.stubGlobal("fetch", async () => anthropicOk());
		d1.exec("UPDATE user_api_keys SET last_used_at = datetime('now', '-30 seconds')");
		const recent = lastUsed("anthropic");
		await call();
		expect(lastUsed("anthropic")).toBe(recent); // inside the window: untouched
		d1.exec("UPDATE user_api_keys SET last_used_at = datetime('now', '-5 minutes')");
		const stale = lastUsed("anthropic");
		await call();
		expect(lastUsed("anthropic")).not.toBe(stale); // outside it: moved
	});

	it("a bookkeeping failure never fails the call that succeeded", async () => {
		await store("anthropic", ANTHROPIC_KEY);
		vi.stubGlobal("fetch", async () => anthropicOk());
		failBatch = true;
		const out = (await call()) as { response: string };
		expect(out.response).toBe("hi");
	});
});

describe("a request a provider cannot carry is refused before any network call", () => {
	it("Cloudflare, handed a content block it cannot read", async () => {
		await store("cloudflare", encodeCloudflareAiCredentials(CF.accountId, CF.token));
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const doc = { role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "AAAA" } }] };
		const err = await runUserWorkersAi(env, "u1", "@cf/meta/llama-3.2-3b-instruct", { messages: [doc] }).catch((e) => e);
		expect(err).toBeInstanceOf(UserAiUnsupportedInputError);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(batches).toBe(0);
	});
});
