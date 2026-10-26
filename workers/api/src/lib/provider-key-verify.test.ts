/** #1356 — the one verify, from the hold's side: which model it names, what "nothing was sent" means, and the probe built on top of it. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptKey } from "./crypto.js";
import { probeProviderKey } from "./credit-auto-resume.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { isVerifiableProvider, VERIFY_MODEL, verifyProviderKey } from "./provider-key-verify.js";
import { encodeCloudflareAiCredentials } from "./user-ai.js";
import type { Env } from "../types.js";

const KEK = "31".repeat(32);
let d1: RealSchemaD1;
let env: Env;
let requests: Array<{ url: string; body: Record<string, unknown> }>;

async function store(provider: "anthropic" | "cloudflare", value: string, accountId = "") {
	const e = await encryptKey(value, KEK);
	await d1.DB.prepare("INSERT INTO user_api_keys(user_id,provider,account_id,key_ciphertext,dek_wrapped,iv) VALUES('u1',?1,?2,?3,?4,?5)").bind(provider, accountId, e.ciphertext, e.dekWrapped, e.iv).run();
}
const ok = () => {
	const f = (e: Record<string, unknown>) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
	return new Response(
		[f({ type: "message_start", message: { usage: {} } }), f({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }), f({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }), f({ type: "content_block_stop", index: 0 }), f({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }), f({ type: "message_stop" })].join(""),
		{ headers: { "Content-Type": "text/event-stream" } },
	);
};

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	env = { DB: d1.DB, KEY_ENCRYPTION_KEY: KEK } as unknown as Env;
	requests = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		requests.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
		return url.includes("anthropic.com") ? ok() : Response.json({ success: true, result: { response: "ok" } });
	});
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
	d1.close();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("verifyProviderKey", () => {
	it("knows which providers can be verified", () => {
		expect(isVerifiableProvider("anthropic")).toBe(true);
		expect(isVerifiableProvider("cloudflare")).toBe(true);
		expect(isVerifiableProvider("openai")).toBe(false);
	});

	it("says nothing was sent — and sends nothing — when no key is stored, with the status an HTTP caller should answer", async () => {
		expect(await verifyProviderKey(env, "u1", "anthropic")).toMatchObject({ ok: false, reason: "unavailable", status: 404, message: expect.stringContaining("No Anthropic key stored") });
		expect(await verifyProviderKey(env, "u1", "cloudflare")).toMatchObject({ ok: false, reason: "unavailable", status: 404, message: expect.stringContaining("No Cloudflare Workers AI credentials stored") });
		expect(requests).toEqual([]);
	});

	it("a Cloudflare credential that is stored but unreadable is a 400 that names it, not a 404", async () => {
		await store("cloudflare", "no-colon-and-not-json", "acct-1");
		expect(await verifyProviderKey(env, "u1", "cloudflare")).toMatchObject({ ok: false, reason: "unavailable", status: 400, message: expect.stringContaining("invalid") });
		expect(requests).toEqual([]);
	});

	it("is pinned to the provider asked about, with both keys stored", async () => {
		await store("anthropic", "sk-ant-not-real-0001");
		await store("cloudflare", encodeCloudflareAiCredentials("acct-1", "tok"), "acct-1");
		expect(await verifyProviderKey(env, "u1", "cloudflare")).toEqual({ ok: true });
		expect(requests.map((r) => r.url).every((u) => u.startsWith("https://api.cloudflare.com/"))).toBe(true);
		requests.length = 0;
		expect(await verifyProviderKey(env, "u1", "anthropic")).toEqual({ ok: true });
		expect(requests.map((r) => r.url)).toEqual(["https://api.anthropic.com/v1/messages"]);
	});

	it("names the model the refused request named, where the provider accepts one, and the default otherwise (#1344)", async () => {
		await store("anthropic", "sk-ant-not-real-0001");
		await verifyProviderKey(env, "u1", "anthropic", { model: "claude-haiku-5-5" });
		expect(requests[0].body.model).toBe("claude-haiku-5-5");
		requests.length = 0;
		await verifyProviderKey(env, "u1", "anthropic", { model: "not-a-model" });
		expect(requests[0].body.model).toBe(VERIFY_MODEL.anthropic);
		requests.length = 0;
		await verifyProviderKey(env, "u1", "anthropic"); // no model recorded
		expect(requests[0].body.model).toBe(VERIFY_MODEL.anthropic);

		await store("cloudflare", encodeCloudflareAiCredentials("acct-1", "tok"), "acct-1");
		requests.length = 0;
		await verifyProviderKey(env, "u1", "cloudflare", { model: "@cf/meta/llama-4-scout-17b-16e-instruct" });
		expect(decodeURIComponent(requests[0].url)).toContain("/ai/run/@cf/meta/llama-4-scout-17b-16e-instruct");
	});

	it("a refusal carries the adapter's error, with its kind", async () => {
		await store("anthropic", "sk-ant-not-real-0001");
		vi.stubGlobal("fetch", async () => Response.json({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }, { status: 400 }));
		const out = await verifyProviderKey(env, "u1", "anthropic");
		expect(out).toMatchObject({ ok: false, reason: "refused" });
		expect((out as { error: { kind: string } }).error.kind).toBe("credit");
	});
});

describe("probeProviderKey is the same verify, shaped for a hold's backoff", () => {
	it("ok on a working key; a bounded message on a refusal; the unavailable message when nothing could be sent", async () => {
		await store("anthropic", "sk-ant-not-real-0001");
		expect(await probeProviderKey(env, "u1", "anthropic")).toEqual({ ok: true });
		vi.stubGlobal("fetch", async () => Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 }));
		const refused = await probeProviderKey(env, "u1", "anthropic");
		expect(refused.ok).toBe(false);
		expect(refused.error).toContain("invalid x-api-key");
		expect(await probeProviderKey(env, "u1", "cloudflare")).toEqual({ ok: false, error: expect.stringContaining("No Cloudflare Workers AI credentials stored") });
	});

	it("never throws: an unreadable vault is 'not yet'", async () => {
		await store("anthropic", "sk-ant-not-real-0001");
		const broken = { ...env, KEY_ENCRYPTION_KEY: "ff".repeat(32) } as Env;
		const out = await probeProviderKey(broken, "u1", "anthropic");
		expect(out.ok).toBe(false);
	});
});
