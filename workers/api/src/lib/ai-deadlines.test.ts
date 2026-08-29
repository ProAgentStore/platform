import { describe, expect, it } from "vitest";
import {
	AI_FIRST_TOKEN_TIMEOUT_MS,
	AI_STALL_TIMEOUT_MS,
	AI_TOTAL_TIMEOUT_MS,
	type AiDeadlineKind,
	connectionLostMessage,
	deadlineMessage,
	generationBudgetMs,
	isRetryableDeadline,
	PROMPT_PROCESSING_ALLOWANCE_MS,
	SUSTAINED_OUTPUT_TOKENS_PER_SECOND,
} from "./ai-deadlines.js";
import { CHAT_MAX_TOKENS } from "./reply-truncation.js";

describe("the output cap and the deadline that has to cover it (#427)", () => {
	/**
	 * THE regression test for this ticket, and its third acceptance criterion.
	 *
	 * The defect was not a number being wrong. It was two numbers, in two files, that nothing
	 * related: `CHAT_MAX_TOKENS = 4096` in reply-truncation.ts and a 25s ceiling in user-ai.ts, each
	 * defensible alone and impossible together. Every chat turn that used its budget failed, forever,
	 * and the only thing that would have caught it is an assertion that reads both.
	 *
	 * Raise the cap without raising the ceiling and this fails, naming both.
	 */
	it("leaves room for a reply that uses the whole output cap", () => {
		const needed = generationBudgetMs(CHAT_MAX_TOKENS);
		expect(
			AI_TOTAL_TIMEOUT_MS,
			`A ${CHAT_MAX_TOKENS}-token reply needs ~${Math.round(needed / 1000)}s at ` +
				`${SUSTAINED_OUTPUT_TOKENS_PER_SECOND} tok/s plus ${PROMPT_PROCESSING_ALLOWANCE_MS / 1000}s of preamble, ` +
				`but AI_TOTAL_TIMEOUT_MS is ${AI_TOTAL_TIMEOUT_MS / 1000}s. Raise the ceiling or lower the cap — ` +
				"shipping them contradictory is #427.",
		).toBeGreaterThanOrEqual(needed);
	});

	it("would have failed on the configuration that shipped the bug", () => {
		// 4,096 tokens under the old 25s total. The point of stating it: the assertion above is not
		// vacuously true, it genuinely discriminates the broken pair from the fixed one.
		expect(generationBudgetMs(4096)).toBeGreaterThan(25_000);
	});

	it("budgets a preamble even for a zero-token reply, and scales linearly after that", () => {
		expect(generationBudgetMs(0)).toBe(PROMPT_PROCESSING_ALLOWANCE_MS);
		expect(generationBudgetMs(-5)).toBe(PROMPT_PROCESSING_ALLOWANCE_MS);
		expect(generationBudgetMs(Number.NaN)).toBe(PROMPT_PROCESSING_ALLOWANCE_MS);
		const one = generationBudgetMs(SUSTAINED_OUTPUT_TOKENS_PER_SECOND) - PROMPT_PROCESSING_ALLOWANCE_MS;
		expect(one).toBe(1000);
	});

	it("orders the three deadlines the only way that makes sense", () => {
		// A stall budget above the total, or a first-token budget above the total, would make one of
		// them unreachable — a deadline that can never fire is a deadline nobody maintains.
		expect(AI_STALL_TIMEOUT_MS).toBeLessThan(AI_TOTAL_TIMEOUT_MS);
		expect(AI_FIRST_TOKEN_TIMEOUT_MS).toBeLessThan(AI_TOTAL_TIMEOUT_MS);
	});
});

describe("what the user is told (#427 item 4)", () => {
	it("tells a deterministic failure NOT to retry, and names what to do instead", () => {
		const msg = deadlineMessage("total", AI_TOTAL_TIMEOUT_MS);
		// The reported failure: the user retried on the advice of `AI request timed out (25s)` and got
		// the identical error six minutes later, on their own Anthropic credit. "Try again" is the one
		// instruction this case must never carry.
		expect(msg).toMatch(/will fail the same way/i);
		expect(msg).toMatch(/shorter|narrow/i);
		expect(msg).not.toMatch(/\btry again\b/i);
	});

	it("does invite a retry when the provider never started, because then it works", () => {
		const msg = deadlineMessage("first-token", AI_FIRST_TOKEN_TIMEOUT_MS);
		expect(msg).toMatch(/again/i);
		expect(msg).toContain("25s");
	});

	it("says a stalled reply was discarded rather than shown as complete", () => {
		// #397's lesson: a half-answer presented as whole is worse than an error.
		expect(deadlineMessage("stall", AI_STALL_TIMEOUT_MS)).toMatch(/discarded/i);
	});

	it("does not assert why the stall happened — only what was measured (#734)", () => {
		// The platform observed N seconds of silence. It did NOT observe that the socket was
		// dropped rather than slow — it has no keep-alive to tell them apart. The message must
		// state the observation and stop there.
		const msg = deadlineMessage("stall", AI_STALL_TIMEOUT_MS);
		expect(msg).not.toMatch(/connection.*gone/i);
		expect(msg).not.toMatch(/gone rather than slow/i);
		// It DOES say something observable: that nothing arrived for N seconds.
		expect(msg).toMatch(/\d+s/);
	});

	it("never quotes a raw millisecond count at a human", () => {
		for (const kind of ["first-token", "stall", "total"] as const) {
			expect(deadlineMessage(kind, 25_000)).not.toContain("25000");
		}
	});
});

describe("the advice and the automatic behaviour, held equal (#518)", () => {
	const KINDS: AiDeadlineKind[] = ["first-token", "stall", "total"];

	/**
	 * The invariant that makes an automatic retry trustworthy: the platform retries exactly the
	 * failures whose message tells the user to. Two tables that mean the same thing and are checked
	 * by nothing is how #427's own numbers drifted apart, and this pair is far easier to break —
	 * one is prose.
	 */
	it("retries precisely the kinds whose sentence says to send the message again", () => {
		for (const kind of KINDS) {
			const invitesRetry = /send the message again/i.test(deadlineMessage(kind, 25_000));
			expect(isRetryableDeadline(kind), `${kind}: the message and the retry policy disagree`).toBe(invitesRetry);
		}
	});

	it("never auto-retries the one deadline that fails identically every time", () => {
		expect(isRetryableDeadline("total")).toBe(false);
		expect(isRetryableDeadline("first-token")).toBe(true);
		expect(isRetryableDeadline("stall")).toBe(true);
	});

	/**
	 * The adjacent nit on #518: a runtime `AbortError` was reported as `deadlineMessage("stall",
	 * AI_STALL_TIMEOUT_MS)` — "20s of silence" — where the 20 was the CONSTANT and nothing had
	 * measured anything. A dropped socket may have dropped a second in.
	 */
	it("reports a dropped connection without inventing a duration", () => {
		const msg = connectionLostMessage();
		expect(msg).not.toMatch(/\d+\s*s\b/);
		expect(msg).toMatch(/discarded/i);
		expect(msg).toMatch(/send the message again/i);
	});
});
