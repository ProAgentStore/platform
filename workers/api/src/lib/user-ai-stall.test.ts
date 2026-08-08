import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptKey } from "./crypto.js";
import { runUserWorkersAi } from "./user-ai.js";
import type { Env } from "../types.js";

/**
 * The two deadlines that only fire on the clock (#427), in their own file.
 *
 * They cannot live beside the rest of `user-ai.test.ts`: the stall budget is 20s and the total
 * ceiling is 180s, and neither is worth waiting for. Fake timers were tried first and deadlock —
 * `decryptKey` is real WebCrypto and its resolution does not run under a faked clock, so the request
 * never reaches the read loop that would arm the timer. So the CONSTANTS are shrunk instead, with
 * the module mocked here and nowhere else. That keeps real timers, real streams and a real reader,
 * and tests the arithmetic that actually ships — only the two numbers change.
 */
vi.mock("./ai-deadlines.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./ai-deadlines.js")>();
	return { ...actual, AI_FIRST_TOKEN_TIMEOUT_MS: 400, AI_STALL_TIMEOUT_MS: 60, AI_TOTAL_TIMEOUT_MS: 300 };
});

const TEST_KEK = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async function envWithAnthropicKey(): Promise<Env> {
	const encrypted = await encryptKey("sk-ant-test", TEST_KEK);
	return {
		KEY_ENCRYPTION_KEY: TEST_KEK,
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							first: async () =>
								sql.includes("SELECT key_ciphertext") && args[1] === "anthropic"
									? { key_ciphertext: encrypted.ciphertext, dek_wrapped: encrypted.dekWrapped, iv: encrypted.iv }
									: null,
							run: async () => ({ success: true }),
						};
					},
				};
			},
		},
	} as unknown as Env;
}

const PING = 'event: ping\ndata: {"type":"ping"}\n\n';

/**
 * A live body: one frame every `everyMs`, forever, never closing.
 *
 * The `cancelled` latch matters — `readAnthropicStream` cancels the reader in its `finally`, and a
 * pending timer that then enqueues throws "Controller is already closed" into the process, which
 * vitest reports as an unhandled error and which would be a real leak in the Worker too.
 */
function endlessPings(everyMs: number): Response {
	const bytes = new TextEncoder().encode(PING);
	let cancelled = false;
	return new Response(
		new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
			pull(controller) {
				return new Promise<void>((resolve) => {
					setTimeout(() => {
						if (!cancelled) controller.enqueue(bytes);
						resolve();
					}, everyMs);
				});
			},
		}),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("a stream that goes quiet, and one that never ends (#427)", () => {
	it("ends a stalled stream on the stall deadline, well short of the total ceiling", async () => {
		// The reply started, so the first-token budget no longer applies; what ends it is SILENCE.
		// Anthropic pings during a long generation, so silence this long is a dead socket rather than
		// a thinking model — which is exactly the distinction the old single 25s number could not make.
		const env = await envWithAnthropicKey();
		let sent = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							pull(controller) {
								if (sent) return new Promise<void>(() => undefined);
								sent = true;
								controller.enqueue(new TextEncoder().encode(PING));
							},
						}),
					),
			),
		);
		const started = Date.now();
		await expect(
			runUserWorkersAi(env, "user-1", "claude-sonnet-4-6", { messages: [{ role: "user", content: "hi" }] }),
		).rejects.toMatchObject({ status: 504, message: expect.stringMatching(/stopped sending mid-reply/) });
		expect(Date.now() - started).toBeLessThan(250);
	});

	it("stops a reply still arriving at the total ceiling, and tells the user a retry will not help", async () => {
		// Alive but endless: a ping inside every stall window resets the stall deadline forever, so the
		// total ceiling is the only thing that can end it. Before #427 nothing needed to — the single
		// 25s deadline had already killed every reply longer than a paragraph.
		const env = await envWithAnthropicKey();
		vi.stubGlobal("fetch", vi.fn(async () => endlessPings(20)));
		await expect(
			runUserWorkersAi(env, "user-1", "claude-sonnet-4-6", { messages: [{ role: "user", content: "hi" }] }),
		).rejects.toMatchObject({ status: 504, message: expect.stringMatching(/will fail the same way/) });
	});

	it("a steady stream that finishes inside the ceiling is not a timeout", async () => {
		// The other half of the fix, and the half the acceptance criteria are about: a reply that takes
		// LONGER than the old ceiling now completes, because the deadline no longer measures length.
		const env = await envWithAnthropicKey();
		const frames = [
			'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\n',
			'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
			...Array.from(
				{ length: 8 },
				(_, i) => `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"part ${i} "}}\n\n`,
			),
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":80}}\n\n',
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		];
		vi.stubGlobal("fetch", vi.fn(async () => {
			let i = 0;
			return new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						return new Promise<void>((resolve) => {
							setTimeout(() => {
								if (i >= frames.length) controller.close();
								else controller.enqueue(new TextEncoder().encode(frames[i++]));
								resolve();
							}, 20);
						});
					},
				}),
			);
		}));
		const result = (await runUserWorkersAi(env, "user-1", "claude-sonnet-4-6", {
			messages: [{ role: "user", content: "hi" }],
		})) as { response: string; stopReason?: string };
		// Total elapsed (~13 frames x 20ms = 260ms) exceeds the mocked 60ms stall budget several times
		// over: progress, not duration, is what keeps the call alive.
		expect(result.response).toBe("part 0 part 1 part 2 part 3 part 4 part 5 part 6 part 7 ");
		expect(result.stopReason).toBe("end_turn");
	});
});
