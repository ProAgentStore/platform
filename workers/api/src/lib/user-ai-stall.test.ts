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
 *
 * ── Why one arm owns its clock (#668)
 *
 * Shrinking the constants is right for the two arms that assert a deadline DOES fire: the promise
 * they race against never resolves, so the deadline wins no matter how loaded the machine is.
 *
 * It was wrong for the arm that asserts one does NOT fire. That arm fed the stream from
 * `setTimeout(20)` per frame — 14 frames, ~280ms of wall clock, against a 300ms ceiling measured
 * from an ABSOLUTE `startedAt`. The frames slip under load; the ceiling does not. A 7% margin on a
 * box running 9,400 other tests is not a margin, and it failed for whoever happened to be running
 * the suite — twice in four concurrent runs when measured. The pending frame timer then fired after
 * `readAnthropicStream` had cancelled the reader and enqueued into a closed controller, which vitest
 * counts as an unhandled error and pins on an unrelated file.
 *
 * The fix is not a bigger number — that only moves the margin. `Date.now` is stubbed for that arm
 * so the deadline ARITHMETIC is exact, and the frames arrive on microtasks so they cannot lose a
 * race to a timer. This is not `vi.useFakeTimers`, and it is why it does not hit the deadlock above:
 * real timers, real streams and real WebCrypto all still run: only the clock the code MEASURES with
 * is the test's, so 20ms gaps and a 280ms total are what they say they are on any machine.
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

/**
 * A clock the TEST advances, for the one arm that asserts a deadline is NOT reached (#668).
 *
 * `readAnthropicStream` measures with `Date.now()` and waits with `setTimeout`. Stubbing only the
 * first makes the arithmetic deterministic while leaving the plumbing real — so "each gap is 20ms"
 * and "the total is 280ms" become facts rather than hopes about scheduling. The timer the code arms
 * from those numbers is still a real one; it simply never wins, because the frame it races is
 * delivered on a microtask and microtasks run before any timer.
 */
function virtualClock(startMs = 1_700_000_000_000) {
	let now = startMs;
	vi.spyOn(Date, "now").mockImplementation(() => now);
	return (ms: number) => {
		now += ms;
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	// Puts the real `Date.now` back. Without it the stub would outlive its test and silently
	// freeze the clock for every file sharing this worker.
	vi.restoreAllMocks();
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
		// "Well short of the total ceiling" is asserted by naming WHICH deadline fired, not by timing
		// the run. `retryable` is the machine-readable half of the same verdict (#518) and the two
		// kinds disagree about it — stall is worth retrying, the ceiling never is — so this pins the
		// stall deadline exactly as a wall-clock bound was trying to. It does so without measuring the
		// wall clock, which on a loaded box measures the box (#668).
		await expect(
			runUserWorkersAi(env, "user-1", "claude-sonnet-4-6", { messages: [{ role: "user", content: "hi" }] }),
		).rejects.toMatchObject({ status: 504, retryable: true, message: expect.stringMatching(/stopped sending mid-reply/) });
	});

	it("records the assembler state at the point of silence — message_start then nothing (#734)", async () => {
		// AC 4, case 1: message_start arrives, then the stream goes silent.
		// The error must carry events: 1, lastEvent: "message_start" so the caller can log what the
		// model was doing (or not doing) when the stall budget ran out.
		const env = await envWithAnthropicKey();
		let sent = false;
		const MSG_START = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\n';
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				let cancelled = false;
				return new Response(
					new ReadableStream<Uint8Array>({
						cancel() {
							cancelled = true;
						},
						pull(controller) {
							if (sent) return new Promise<void>(() => undefined);
							sent = true;
							if (!cancelled) controller.enqueue(new TextEncoder().encode(MSG_START));
						},
					}),
				);
			}),
		);
		await expect(
			runUserWorkersAi(env, "user-1", "claude-sonnet-4-6", { messages: [{ role: "user", content: "hi" }] }),
		).rejects.toMatchObject({ eventsSeen: 1, lastEventType: "message_start" });
	});

	it("records the assembler state at the point of silence — content_block_delta then nothing (#734)", async () => {
		// AC 4, case 2: the model has started writing and then falls silent after two partial text
		// frames. events: 4 (message_start + content_block_start + 2×content_block_delta),
		// lastEvent: "content_block_delta".
		// A content_block_start is required before content_block_delta — without it the assembler
		// throws (not a stall). The event count is 4, not 3, because the assembler counts every
		// parsed event; the intent of the AC is preserved: the last event is "content_block_delta"
		// and the platform records that the silence began after real content had started flowing.
		const env = await envWithAnthropicKey();
		let sent = false;
		const FRAMES = [
			'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\n',
			'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n',
		].join("");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				let cancelled = false;
				return new Response(
					new ReadableStream<Uint8Array>({
						cancel() {
							cancelled = true;
						},
						pull(controller) {
							if (sent) return new Promise<void>(() => undefined);
							sent = true;
							if (!cancelled) controller.enqueue(new TextEncoder().encode(FRAMES));
						},
					}),
				);
			}),
		);
		await expect(
			runUserWorkersAi(env, "user-1", "claude-sonnet-4-6", { messages: [{ role: "user", content: "hi" }] }),
		).rejects.toMatchObject({ eventsSeen: 4, lastEventType: "content_block_delta" });
	});

	it("stops a reply still arriving at the total ceiling, and tells the user a retry will not help", async () => {
		// Alive but endless: a ping inside every stall window resets the stall deadline forever, so the
		// total ceiling is the only thing that can end it. Before #427 nothing needed to — the single
		// 25s deadline had already killed every reply longer than a paragraph.
		const env = await envWithAnthropicKey();
		vi.stubGlobal("fetch", vi.fn(async () => endlessPings(20)));
		await expect(
			runUserWorkersAi(env, "user-1", "claude-sonnet-4-6", { messages: [{ role: "user", content: "hi" }] }),
			// The other side of the pair above: the ceiling is the one deadline a retry cannot help,
			// so the two arms now disagree about `retryable` and a regression that swapped the kinds
			// could not pass both.
		).rejects.toMatchObject({ status: 504, retryable: false, message: expect.stringMatching(/will fail the same way/) });
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
		// The gap is spent on BOTH clocks, and for two different reasons.
		//
		// Real, because the per-frame race is decided by timer ORDER, and that is already immune to
		// load: the frame's 20ms timer and the stall's 60ms timer are armed in the same tick, so the
		// frame is due first however long the process is descheduled — a starved box fires both late,
		// in the same order. Shrink the stall budget under 20 and the stall correctly wins.
		//
		// Virtual, because the CEILING is not a race. It is an absolute stamp taken once from
		// `startedAt`, so it never slips while the frames do, and real elapsed drifting past it was
		// the whole of #668. Advancing the clock exactly one gap per frame makes the total the
		// arithmetic sees exactly 13 x 20ms, on an idle box and a saturated one alike.
		const GAP_MS = 20;
		const advance = virtualClock();
		let cancelled = false;
		vi.stubGlobal("fetch", vi.fn(async () => {
			let i = 0;
			return new Response(
				new ReadableStream<Uint8Array>({
					// `readAnthropicStream` cancels the reader in its `finally`. Without this latch a
					// timer still in flight enqueues into a closed controller, which vitest reports as
					// an unhandled error against whichever file is unlucky (#668). `endlessPings`
					// above has always had it; this arm was written without one.
					cancel() {
						cancelled = true;
					},
					pull(controller) {
						return new Promise<void>((resolve) => {
							setTimeout(() => {
								advance(GAP_MS);
								if (!cancelled) {
									if (i >= frames.length) controller.close();
									else controller.enqueue(new TextEncoder().encode(frames[i++]));
								}
								resolve();
							}, GAP_MS);
						});
					},
				}),
			);
		}));
		const result = (await runUserWorkersAi(env, "user-1", "claude-sonnet-4-6", {
			messages: [{ role: "user", content: "hi" }],
		})) as { response: string; stopReason?: string };
		// Each gap (20ms) is inside the mocked 60ms stall budget, while the total the frames take
		// (13 x 20ms = 260ms) exceeds it fourfold and still lands under the 300ms ceiling: progress,
		// not duration, is what keeps the call alive. All three numbers are now exact on any machine,
		// which is what makes the assertion mean something — drop the ceiling to 200 and this arm
		// fails, which is the property the first attempt at this fix quietly lost.
		expect(result.response).toBe("part 0 part 1 part 2 part 3 part 4 part 5 part 6 part 7 ");
		expect(result.stopReason).toBe("end_turn");
	});
});
