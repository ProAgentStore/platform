import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptKey } from "./crypto.js";
import {
	encodeCloudflareAiCredentials,
	parseCloudflareAiCredentials,
	runUserWorkersAi,
	UserAiCredentialsError,
	UserAiProviderError,
} from "./user-ai.js";
import type { Env } from "../types.js";

const TEST_KEK =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function envWithCloudflareKey(row: {
	key_ciphertext: Uint8Array;
	dek_wrapped: Uint8Array;
	iv: Uint8Array;
}) {
	const calls: string[] = [];
	const env = {
		KEY_ENCRYPTION_KEY: TEST_KEK,
		DB: {
			prepare(sql: string) {
				calls.push(sql);
				return {
					bind(...args: unknown[]) {
						return {
							first: async () => {
								if (!sql.includes("SELECT key_ciphertext")) return null;
								// Only return row for cloudflare provider queries
								const provider = args[1];
								if (provider && provider !== "cloudflare") return null;
								return row;
							},
							run: async () => ({ success: true }),
						};
					},
				};
			},
		},
	} as unknown as Env;
	return { env, calls };
}

async function encryptedCloudflareRow(accountId = "acct-123", token = "cf-token") {
	const encrypted = await encryptKey(
		encodeCloudflareAiCredentials(accountId, token),
		TEST_KEK,
	);
	return {
		key_ciphertext: encrypted.ciphertext,
		dek_wrapped: encrypted.dekWrapped,
		iv: encrypted.iv,
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Cloudflare AI credential parsing", () => {
	it("encodes and parses stored JSON credentials", () => {
		const raw = encodeCloudflareAiCredentials(" account ", " token ");
		expect(parseCloudflareAiCredentials(raw)).toEqual({
			accountId: "account",
			token: "token",
		});
	});

	it("parses legacy account:token credentials", () => {
		expect(parseCloudflareAiCredentials("account-id:api-token")).toEqual({
			accountId: "account-id",
			token: "api-token",
		});
	});

	it("rejects malformed credentials", () => {
		expect(parseCloudflareAiCredentials("")).toBeNull();
		expect(parseCloudflareAiCredentials("{}")).toBeNull();
		expect(parseCloudflareAiCredentials("token-without-account")).toBeNull();
	});
});

describe("runUserWorkersAi", () => {
	it("runs against the user's Cloudflare account and unwraps REST result", async () => {
		const { env, calls } = envWithCloudflareKey(
			await encryptedCloudflareRow("acct-abc", "token-xyz"),
		);
		const fetchMock = vi.fn(async () =>
			Response.json({ success: true, result: { response: "hello" } }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await runUserWorkersAi(
			env,
			"user-1",
			"@cf/meta/llama-3.2-3b-instruct",
			{ messages: [] },
		);

		expect(result).toEqual({ response: "hello" });
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.cloudflare.com/client/v4/accounts/acct-abc/ai/run/%40cf/meta/llama-3.2-3b-instruct",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer token-xyz",
				}),
			}),
		);
		expect(calls.some((sql) => sql.includes("UPDATE user_api_keys"))).toBe(true);
	});

	it("throws a credentials error when the user has no Cloudflare key", async () => {
		const env = {
			KEY_ENCRYPTION_KEY: TEST_KEK,
			DB: {
				prepare() {
					return { bind: () => ({ first: async () => null }) };
				},
			},
		} as unknown as Env;

		await expect(
			runUserWorkersAi(env, "user-1", "@cf/meta/llama-3.2-3b-instruct", {}),
		).rejects.toBeInstanceOf(UserAiCredentialsError);
	});

	it("throws a provider error instead of returning an error-shaped success", async () => {
		const { env, calls } = envWithCloudflareKey(await encryptedCloudflareRow());
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ errors: ["bad token"] }, { status: 401 })),
		);

		await expect(
			runUserWorkersAi(env, "user-1", "@cf/meta/llama-3.2-3b-instruct", {}),
		).rejects.toMatchObject({
			name: "UserAiProviderError",
			status: 400,
			upstreamStatus: 401,
		} satisfies Partial<UserAiProviderError>);
		expect(calls.some((sql) => sql.includes("UPDATE user_api_keys"))).toBe(false);
	});
});

async function envWithAnthropicKey(apiKey = "sk-ant-test") {
	const encrypted = await encryptKey(apiKey, TEST_KEK);
	const env = {
		KEY_ENCRYPTION_KEY: TEST_KEK,
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							first: async () => {
								if (!sql.includes("SELECT key_ciphertext")) return null;
								if (args[1] !== "anthropic") return null;
								return {
									key_ciphertext: encrypted.ciphertext,
									dek_wrapped: encrypted.dekWrapped,
									iv: encrypted.iv,
								};
							},
							run: async () => ({ success: true }),
						};
					},
				};
			},
		},
	} as unknown as Env;
	return env;
}

describe("runAnthropic message normalization", () => {
	it("drops leading assistant messages and merges consecutive same-role turns", async () => {
		const env = await envWithAnthropicKey();
		let sentBody: { messages: Array<{ role: string; content: unknown }> } = { messages: [] };
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit) => {
				sentBody = JSON.parse(init.body as string);
				return Response.json({
					content: [{ type: "text", text: "ok" }],
					usage: { input_tokens: 1, output_tokens: 1 },
				});
			}),
		);

		await runUserWorkersAi(env, "user-1", "claude-sonnet-4-6", {
			messages: [
				// system is stripped; leading assistant must be dropped; the two trailing
				// user turns (error-turn + new turn shape) must merge into one.
				{ role: "system", content: "sys" },
				{ role: "assistant", content: "stale leading reply" },
				{ role: "user", content: "first question" },
				{ role: "assistant", content: "answer" },
				{ role: "user", content: "errored turn" },
				{ role: "user", content: "new question" },
			],
		});

		const roles = sentBody.messages.map((m) => m.role);
		expect(roles[0]).toBe("user");
		// strict alternation, no adjacent duplicates
		for (let i = 1; i < roles.length; i++) expect(roles[i]).not.toBe(roles[i - 1]);
		expect(roles).toEqual(["user", "assistant", "user"]);
		// merged content of the two trailing user turns
		expect(sentBody.messages[2].content).toContain("errored turn");
		expect(sentBody.messages[2].content).toContain("new question");
	});
});
