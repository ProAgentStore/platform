/**
 * A reply that stopped because it ran out of room (#397).
 *
 * ── What happened
 *
 * `runAnthropic` defaults to `max_tokens: 1024` and the chat loop never passed one, so every
 * Anthropic-backed chat reply — the surface that produces by far the longest text, and the only one
 * a human reads end to end — was capped at roughly 4,000 characters. Every OTHER caller chose:
 * loop-orchestrator 300, coding-copilot 160/600, coding-brains 700/800, resume-parse 2000, the
 * pipeline `ai_generate` step 500. Chat inherited a number picked for nothing in particular.
 *
 * A Repo Coder message of 2026-08-07 ends mid-file, mid-import, on the bare word `import`. That is
 * not a formatting artefact: the generation stopped there, and the message was stored and displayed
 * as though it were the whole answer.
 *
 * ── Why nothing said so
 *
 * The provider reports it. `stop_reason: "max_tokens"` is in the response body, next to the
 * `content` and `usage` that `runAnthropic` does read — and `stop_reason` appeared nowhere in
 * `workers/api/src` except a loop-run store about a different thing entirely. The platform had the
 * fact and discarded it, so a truncated reply was indistinguishable from a finished one to every
 * layer below it: nothing marked the message, nothing warned the user, nothing logged it.
 *
 * ── The rule
 *
 * The platform knows, so the user is told. Same rule the voice stack follows for a turn it could
 * not transcribe (#377) and the loop for a cancel it accepted (#376). This module is the pure half:
 * the cap chat chooses, the test for the provider's verdict, and the sentence the user reads. The
 * one thing it deliberately does NOT do is hide the stop behind a silent continuation round — a
 * second generation is a real charge on the owner's own key, and an answer the owner can see was
 * cut off is honest in a way an invisible retry is not.
 */

/**
 * The output ceiling every chat completion names explicitly.
 *
 * 4,096 tokens ≈ 16,000 characters — long enough for a Repo Coder to explain a file or quote a
 * function, which is exactly the reply `guardrails.responseStyle: "technical"` asks for and exactly
 * the reply the old default cut. It is a number chosen for the surface rather than inherited, which
 * is the whole point: the failure was not that 1024 is small, it is that nobody picked it.
 *
 * Not a per-agent setting yet — #397's third suggestion, and a `settingsSchema` field is the right
 * home for it when a terse operator agent and a code-explaining Repo Coder want different ceilings.
 */
export const CHAT_MAX_TOKENS = 4096;

/**
 * Did the provider stop because it ran out of output budget?
 *
 * Anthropic says `max_tokens`; the OpenAI-shaped `finish_reason` says `length`. Both are accepted
 * because the field this reads is whatever the provider adapter put there, and a second provider
 * arriving with the other spelling must not silently turn this check off. Everything else —
 * `end_turn`, `tool_use`, `stop_sequence`, a provider that reports nothing at all — is NOT a
 * truncation: this must never fire on a reply that simply finished, or the notice becomes noise and
 * stops being read.
 */
export function hitOutputCap(stopReason: unknown): boolean {
	if (typeof stopReason !== "string") return false;
	const r = stopReason.trim().toLowerCase();
	return r === "max_tokens" || r === "length";
}

/** The platform's own voice, matching the ⚠️ prefix the fabrication notices use (#395). */
const PREFIX = "⚠️ **platform**";

/**
 * What the user reads.
 *
 * It leads the tool-log system message, which the console renders ABOVE the assistant reply, so it
 * says "below" and names the remedy. Naming the remedy matters more than naming the cause: a reply
 * that stops mid-sentence reads as a bug in the agent, and "ask it to continue" is the one action
 * that actually recovers the rest of the answer.
 */
export function truncationNotice(maxTokens: number = CHAT_MAX_TOKENS): string {
	return (
		`${PREFIX} The reply below was cut off at the ${maxTokens.toLocaleString("en-US")}-token length limit —` +
		" it is not the whole answer. Ask the agent to continue and it will pick up from where it stopped."
	);
}
