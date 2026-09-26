/**
 * A PDF résumé on the Cloudflare path is refused, not flattened (#853 finding 2).
 *
 * `toWorkersAiBody` used to keep only the text parts, so the model received "Extract this
 * candidate's details…" with no document and was asked to call `save_resume` — which could invent
 * profile fields that were then written into the owner's empty Profile. Driven through the REAL
 * `runUserWorkersAi` → `runCloudflareAi` for an owner with Cloudflare credentials and no Anthropic
 * key; only the credential decrypt, Cloudflare's endpoint and the Profile/notify writes are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./crypto.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./crypto.js")>()),
	decryptKey: async () => JSON.stringify({ accountId: "acct", token: "cf-token" }),
}));
const upsertProfile = vi.fn(async () => undefined);
vi.mock("./profile.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./profile.js")>()),
	getProfile: async () => ({}),
	upsertProfile: (...a: unknown[]) => upsertProfile(...(a as [])),
}));
const notifyUser = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("../routes/push.js", () => ({ notifyUser: (...a: unknown[]) => notifyUser(...a) }));
const logError = vi.fn(async () => undefined);
vi.mock("./error-log.js", () => ({ logError: (...a: unknown[]) => logError(...(a as [])) }));

const { parseResumeIntoProfile } = await import("./resume-parse.js");
const { runUserWorkersAi, UserAiUnsupportedInputError } = await import("./user-ai.js");

/** Cloudflare credentials stored, no Anthropic key — the only path that reaches Workers AI. */
const env = {
	KEY_ENCRYPTION_KEY: "k",
	DB: {
		prepare(sql: string) {
			const result = {
				async first() {
					return /FROM user_api_keys/.test(sql) && /provider = 'cloudflare'/.test(sql)
						? { key_ciphertext: new ArrayBuffer(1), dek_wrapped: new ArrayBuffer(1), iv: new ArrayBuffer(1), account_id: "acct", key_hint: "oken" }
						: null;
				},
				async all() {
					return { results: [] };
				},
				async run() {
					return { success: true };
				},
			};
			return { bind: () => result, ...result };
		},
	},
	AGENT: { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response("{}") }) },
} as never;

const requests: Array<{ url: string; body: { messages: Array<{ content: unknown }> } }> = [];
beforeEach(() => {
	requests.length = 0;
	upsertProfile.mockClear();
	notifyUser.mockClear();
	logError.mockClear();
	vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
		requests.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
		// What a model given no document might do: invent a candidate.
		return new Response(JSON.stringify({ success: true, result: { response: "", tool_calls: [{ name: "save_resume", arguments: { firstName: "Invented", email: "made@up.test" } }] } }));
	});
});
afterEach(() => vi.unstubAllGlobals());

const PDF_BLOCK = { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0x" } };

describe("the Cloudflare path and a PDF (#853)", () => {
	it("refuses a request carrying a document block — no request is made", async () => {
		const call = runUserWorkersAi(env, "u1", "claude-sonnet-4-6", {
			messages: [{ role: "user", content: [PDF_BLOCK, { type: "text", text: "Extract this." }] }],
		}, { kind: "resume" });
		await expect(call).rejects.toBeInstanceOf(UserAiUnsupportedInputError);
		await expect(call).rejects.toThrow(/PDF input requires an Anthropic key/);
		expect(requests).toEqual([]);
	});

	it("still runs a text-only request unchanged", async () => {
		await runUserWorkersAi(env, "u1", "@cf/meta/llama-4-scout-17b-16e-instruct", {
			messages: [{ role: "user", content: [{ type: "text", text: "Summarise this." }] }],
		}, { kind: "chat" });
		expect(requests).toHaveLength(1);
		expect(requests[0].body.messages).toEqual([{ role: "user", content: "Summarise this." }]);
	});

	it("résumé parsing surfaces the refusal and writes NO profile fields", async () => {
		await parseResumeIntoProfile(env, "inst-1", "u1", new Uint8Array([37, 80, 68, 70]), "application/pdf");
		// The model was never asked, so nothing it could invent was written.
		expect(requests).toEqual([]);
		expect(upsertProfile).not.toHaveBeenCalled();
		// The owner is told what to add, and it is not logged as a failure.
		expect(notifyUser).toHaveBeenCalledTimes(1);
		const [, , , title, body] = notifyUser.mock.calls[0] as string[];
		expect(title).toBe("Résumé saved (not auto-filled)");
		expect(body).toMatch(/PDF input requires an Anthropic key/);
		expect(body).toMatch(/unchanged/);
		expect(logError).not.toHaveBeenCalled();
	});
});
