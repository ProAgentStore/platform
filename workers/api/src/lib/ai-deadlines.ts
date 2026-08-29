/**
 * How long the platform waits for a model, and what it says when it stops waiting (#427).
 *
 * ── The defect this exists to make impossible
 *
 * `runAnthropic` used ONE number — 25s — to bound a NON-streamed request, so the deadline measured
 * the entire generation. `CHAT_MAX_TOKENS` is 4,096. A 4,096-token completion from
 * `claude-sonnet-4-6` does not finish in 25 seconds at any throughput anyone has measured, so the
 * platform was configured to permit a reply it was configured not to wait for. That is not a flaky
 * timeout: it fails BY CONSTRUCTION, identically, every time, which is exactly what a user saw on
 * 2026-08-08 — the tool loop's round 2 (the longest prompt, reached only after the agent had already
 * created an issue and read a repo) timed out at 25s, twice, six minutes apart, on the same message.
 * The side effects landed; the answer did not.
 *
 * ── What replaced it
 *
 * Three deadlines that each measure something real, because "the model is still writing" and "the
 * provider has gone away" are different facts and one number could not tell them apart:
 *
 *   FIRST TOKEN  the provider has this long to start.  Nothing yet ⇒ outage or overload, and a
 *                retry is genuinely the right advice.
 *   STALL        once it has started, this long of COMPLETE SILENCE ends it. Anthropic sends `ping`
 *                frames, so silence this long is a dead socket, not a thinking model.
 *   TOTAL        an absolute ceiling, so a runaway generation cannot hold a request open forever.
 *
 * Only streaming makes those separable, which is why #427's first item is the streaming and this
 * table is the second: with `stream: true` the wait is bounded by SILENCE rather than by LENGTH, and
 * the length cap stops being a trap.
 *
 * ── The invariant, and the test that holds it
 *
 * `generationBudgetMs(CHAT_MAX_TOKENS) <= AI_TOTAL_TIMEOUT_MS`. Raise the token cap without raising
 * the ceiling and `ai-deadlines.test.ts` fails, naming both numbers. That test IS the deliverable
 * for #427's third acceptance criterion: the pair drifted apart silently once and nothing noticed,
 * so the pair is now checked rather than trusted.
 */

/** Time the provider gets to START replying. Beyond this it has not begun, so nothing is lost. */
export const AI_FIRST_TOKEN_TIMEOUT_MS = 25_000;

/**
 * Longest COMPLETE silence tolerated once the reply has begun — no bytes of any kind received for
 * this long, after the first frame arrived.
 *
 * 20s is the platform's own estimate of the pre-generation latency it is willing to pay AFTER the
 * stream has opened (`PROMPT_PROCESSING_ALLOWANCE_MS` in this file covers the time before it). A
 * model that genuinely started writing and then fell silent for longer than that is one we are not
 * getting more output from this call, and retrying is cheaper than waiting. Whether the cause is a
 * dropped socket or the model having not produced a first content byte yet is the distinction this
 * threshold CANNOT make — no keep-alive is captured — and nothing here should assert it.
 */
export const AI_STALL_TIMEOUT_MS = 20_000;

/**
 * Absolute ceiling on one provider call. It is the number the old 25s should always have been: large
 * enough that a reply at the output cap can finish, small enough that a runaway cannot hold a chat
 * request open indefinitely.
 */
export const AI_TOTAL_TIMEOUT_MS = 180_000;

/**
 * Output throughput the budget assumes, deliberately BELOW what Sonnet actually sustains (~50-80
 * tok/s observed). A budget computed from the best case is a budget that fails on a bad afternoon.
 */
export const SUSTAINED_OUTPUT_TOKENS_PER_SECOND = 30;

/**
 * Flat allowance for everything that is not generation: TLS, queueing at the provider, and
 * processing a large prompt (a Coder chat carries repo context, session snapshots and a cached
 * system prompt before the model writes a word).
 */
export const PROMPT_PROCESSING_ALLOWANCE_MS = 20_000;

/**
 * Wall clock a completion of `maxTokens` needs before calling it stuck.
 *
 * Pure, and exported so the consistency test can state the relationship rather than restate a
 * number: it is the function that turns "4,096 tokens" into "156 seconds", which is the conversion
 * nobody performed when the two constants were chosen independently.
 */
export function generationBudgetMs(maxTokens: number): number {
	const tokens = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 0;
	return PROMPT_PROCESSING_ALLOWANCE_MS + Math.ceil((tokens / SUSTAINED_OUTPUT_TOKENS_PER_SECOND) * 1000);
}

/** Which deadline ran out. They read differently to the user because they mean different things. */
export type AiDeadlineKind = "first-token" | "stall" | "total";

/**
 * The sentence the user reads.
 *
 * #427's fourth item: `AI request timed out (25s)` named a number the user cannot act on and implied
 * the one action that could not work. The failure was DETERMINISTIC — they retried, and it failed
 * identically six minutes later — so "try again" was not merely unhelpful, it was wrong, and it
 * spent their own Anthropic credit being wrong. A message earns its place by naming the action that
 * changes the outcome, which is different for each of the three deadlines: a provider that never
 * started really is worth retrying; a reply too long to finish never is.
 */
export function deadlineMessage(kind: AiDeadlineKind, budgetMs: number): string {
	const s = Math.round(budgetMs / 1000);
	if (kind === "first-token") {
		return (
			`The AI provider did not begin replying within ${s}s. Nothing was generated, so nothing was lost —` +
			" this is usually a provider hiccup or an overloaded model. Send the message again; if it keeps happening, check status.anthropic.com."
		);
	}
	if (kind === "stall") {
		return (
			`The AI provider stopped sending mid-reply — ${s}s with no bytes received after the reply had begun.` +
			" The half-written answer was discarded instead of being shown as if it were complete. Send the message again."
		);
	}
	return (
		`The reply was still being written after ${s}s and had to be stopped — it was too long to finish, not broken.` +
		" Sending the same message again will fail the same way. Ask for a shorter answer (\"summarise in a few sentences\")" +
		" or narrow the request to one file, one issue or one step."
	);
}

/**
 * The same verdict as `deadlineMessage`, in the form a MACHINE can act on (#518).
 *
 * Two of the three sentences above end in "Send the message again" and the third says a retry
 * "will fail the same way". That advice was only ever prose: the platform told the user to retry
 * and then made retrying their problem. Now that a failed turn's completed tool rounds are
 * resumable (#442), the platform can perform that retry itself — but only where its own message
 * says a retry is worth performing, which is exactly this function.
 *
 * Keeping the two together is the point. `ai-deadlines.test.ts` asserts they agree sentence by
 * sentence, so a message that starts advising a retry and a policy that declines to make one
 * cannot drift apart in silence — the failure mode that makes automated recovery untrustworthy.
 */
export function isRetryableDeadline(kind: AiDeadlineKind): boolean {
	// `total` is the one deterministic failure of the three: the reply was too LONG, and a
	// byte-identical retry produces a reply of the same length and stops at the same ceiling.
	return kind !== "total";
}

/**
 * What the user reads when the socket dies rather than a deadline expiring (#518).
 *
 * The runtime's own `AbortError` used to be reported with `deadlineMessage("stall", 20_000)`, which
 * states a MEASUREMENT — "20s of silence" — that nothing measured: the number was the constant, and
 * the connection may have been dropped a second in. The observable fact is only that the connection
 * ended mid-reply, so that is all this says. The remedy is identical, which is why it was tempting
 * to reuse the sentence and why reusing it was wrong: an error message that invents a number is one
 * an investigator will later spend an hour trusting.
 */
export function connectionLostMessage(): string {
	return (
		"The connection to the AI provider ended mid-reply, so the answer was cut off rather than slow." +
		" The half-written answer was discarded instead of being shown as if it were complete. Send the message again."
	);
}
