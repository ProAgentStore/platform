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

describe("runAnthropic output cap and stop reason (#397)", () => {
	/** Capture the request body and reply with a caller-supplied Anthropic response. */
	async function callWith(reply: Record<string, unknown>, body: Record<string, unknown>) {
		const env = await envWithAnthropicKey();
		let sent: Record<string, unknown> = {};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit) => {
				sent = JSON.parse(init.body as string);
				return Response.json({ usage: { input_tokens: 1, output_tokens: 1 }, ...reply });
			}),
		);
		const result = (await runUserWorkersAi(env, "user-1", "claude-sonnet-4-6", {
			messages: [{ role: "user", content: "hi" }],
			...body,
		})) as Record<string, unknown>;
		return { sent, result };
	}

	it("puts the caller's maxTokens on the wire as max_tokens", async () => {
		const { sent } = await callWith({ content: [{ type: "text", text: "ok" }] }, { maxTokens: 4096 });
		expect(sent.max_tokens).toBe(4096);
	});

	it("surfaces stop_reason so a truncated reply is distinguishable from a finished one", async () => {
		// The whole defect: the fact is in the response body, one key from `content` and `usage`,
		// and nothing read it — so a reply cut at the cap looked exactly like one that ended.
		const cut = await callWith({ content: [{ type: "text", text: "import" }], stop_reason: "max_tokens" }, {});
		expect(cut.result.stopReason).toBe("max_tokens");

		const done = await callWith({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }, {});
		expect(done.result.stopReason).toBe("end_turn");
	});

	it("surfaces it on the TOOL_USE return too", async () => {
		// A round that stops mid-`tool_use` is the same loss with worse consequences: the loop acts
		// on a half-built call. The two returns must not drift apart.
		const { result } = await callWith(
			{
				content: [
					{ type: "text", text: "calling" },
					{ type: "tool_use", name: "repo_tree", input: { path: "." } },
				],
				stop_reason: "max_tokens",
			},
			{},
		);
		expect(result.tool_calls).toEqual([{ name: "repo_tree", arguments: { path: "." } }]);
		expect(result.stopReason).toBe("max_tokens");
	});

	it("leaves stopReason undefined when the provider omits it, rather than inventing one", async () => {
		const { result } = await callWith({ content: [{ type: "text", text: "ok" }] }, {});
		expect(result.stopReason).toBeUndefined();
	});
});

describe("tool rounds reach the provider in its own protocol (#398)", () => {
	/** Send `messages` and return the body that actually went on the wire. */
	async function sent(messages: Array<{ role: string; content: unknown }>) {
		const env = await envWithAnthropicKey();
		let body: { messages: Array<{ role: string; content: unknown }> } = { messages: [] };
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit) => {
				body = JSON.parse(init.body as string);
				return Response.json({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
			}),
		);
		await runUserWorkersAi(env, "user-1", "claude-sonnet-4-6", { messages });
		return body;
	}

	it("hands back the tool_use ids and the assistant turn, so the caller can answer them", async () => {
		// Before this, `runAnthropic` read the tool_use blocks, converted them to a Workers-AI-shaped
		// `tool_calls` array and dropped both the ids and the turn — so nothing could put the model's
		// own request back into the conversation, and the provider saw a request in which it never
		// happened plus an assistant paragraph narrating results.
		const env = await envWithAnthropicKey();
		const blocks = [
			{ type: "text", text: "looking" },
			{ type: "tool_use", id: "tu_1", name: "repo_read_file", input: { path: "a.ts" } },
		];
		vi.stubGlobal("fetch", vi.fn(async () => Response.json({ content: blocks, usage: {} })));
		const result = (await runUserWorkersAi(env, "user-1", "claude-sonnet-4-6", {
			messages: [{ role: "user", content: "read a.ts" }],
		})) as Record<string, unknown>;

		expect(result.tool_calls).toEqual([{ name: "repo_read_file", arguments: { path: "a.ts" }, id: "tu_1" }]);
		expect(result.contentBlocks).toEqual(blocks);
	});

	it("sends the tool_use turn and its tool_result answer through unflattened", async () => {
		const body = await sent([
			{ role: "user", content: "read a.ts" },
			{ role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "repo_read_file", input: { path: "a.ts" } }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "export const x = 1" }] },
		]);
		expect(body.messages).toHaveLength(3);
		expect((body.messages[1].content as Array<{ type: string }>)[0].type).toBe("tool_use");
		expect((body.messages[2].content as Array<{ type: string }>)[0].type).toBe("tool_result");
	});

	it("the merge that follows a round keeps the results at the FRONT of their turn", async () => {
		// The live shape: the tool-result turn, then "Now give your final answer." as a second user
		// message. `normalizeForAnthropic` merges consecutive same-role turns — the operation that
		// used to erase the boundary between a platform result and the model's prose entirely, and
		// which would now put the instruction ahead of the results the provider requires to open the
		// turn.
		const body = await sent([
			{ role: "user", content: "read a.ts" },
			{ role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "repo_read_file", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "x" }, { type: "text", text: "Continue…" }] },
			{ role: "user", content: "Now give your final answer." },
		]);
		const last = body.messages[body.messages.length - 1].content as Array<{ type: string }>;
		expect(last[0].type).toBe("tool_result");
		expect(last.map((b) => b.type)).toEqual(["tool_result", "text", "text"]);
	});

	it("declares the tools without permitting a call when the caller asks for prose only", async () => {
		// The final answer used to discourage another round by sending NO tools. With tool blocks in
		// the transcript that is a 400 on the whole request — "Requests which include tool_use or
		// tool_result blocks must define tools" — so the turn fails outright instead of degrading.
		const env = await envWithAnthropicKey();
		let body: Record<string, unknown> = {};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit) => {
				body = JSON.parse(init.body as string);
				return Response.json({ content: [{ type: "text", text: "ok" }], usage: {} });
			}),
		);
		await runUserWorkersAi(env, "user-1", "claude-sonnet-4-6", {
			messages: [{ role: "user", content: "hi" }],
			tools: [{ type: "function", function: { name: "repo_tree", description: "d", parameters: {} } }],
			toolChoice: "none",
		});
		expect((body.tools as unknown[]).length).toBe(1);
		expect(body.tool_choice).toEqual({ type: "none" });
	});

	it("leaves tool_choice unset for an ordinary tool round", async () => {
		const env = await envWithAnthropicKey();
		let body: Record<string, unknown> = {};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit) => {
				body = JSON.parse(init.body as string);
				return Response.json({ content: [{ type: "text", text: "ok" }], usage: {} });
			}),
		);
		await runUserWorkersAi(env, "user-1", "claude-sonnet-4-6", {
			messages: [{ role: "user", content: "hi" }],
			tools: [{ type: "function", function: { name: "repo_tree", description: "d", parameters: {} } }],
		});
		expect(body.tool_choice).toBeUndefined();
	});

	it("drops a tool_result orphaned by the leading-assistant rule instead of 400ing the chat", async () => {
		// A 10-message context window can start on an assistant turn, which `normalizeForAnthropic`
		// drops. If that turn carried the tool_use, its answer is now an orphan and the provider
		// rejects the ENTIRE request — the chat fails, it does not degrade.
		const body = await sent([
			{ role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "repo_read_file", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "x" }, { type: "text", text: "carry on" }] },
		]);
		expect(JSON.stringify(body.messages)).not.toContain("tool_result");
		expect(body.messages[0].role).toBe("user");
	});
});
