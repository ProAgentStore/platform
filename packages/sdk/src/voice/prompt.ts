/**
 * Transcription vocabulary bias. OpenAI's gpt-4o-transcribe accepts a `prompt` that
 * nudges the model toward expected words + spellings. Without it, homophones get
 * mis-heard out of context — a developer saying "bugs" comes back as "bars". We build
 * the prompt from the agent's surfaces (what it's FOR) so each agent biases toward its
 * own domain vocabulary.
 */

import { normalizeSpeech } from "./normalize.js";

/** Terms a developer says that generic ASR routinely mangles. */
const CODING_TERMS =
	"bug, bugs, debug, refactor, function, variable, repository, repo, commit, branch, " +
	"merge, pull request, deploy, build, lint, TypeScript, JavaScript, React, API, endpoint, " +
	"console, terminal, npm, pnpm, git, stack trace, null, undefined, async, await, regression";

/** Terms specific to the job-application agent. */
const APPLY_TERMS =
	"resume, résumé, application, cover letter, LinkedIn, recruiter, salary, relocation, " +
	"sponsorship, work authorization, ATS, Workday, Greenhouse, Lever";

/**
 * Build the transcription prompt for an instance from its capability surfaces (+ any
 * extra proper nouns, e.g. attached repo names). Returns "" when there's nothing to
 * bias, so the caller can omit the field entirely.
 */
export function buildTranscribePrompt(surfaces: string[] = [], extra: string[] = []): string {
	const parts: string[] = [];
	if (surfaces.includes("coding") || surfaces.includes("repo")) parts.push(CODING_TERMS);
	if (surfaces.includes("apply")) parts.push(APPLY_TERMS);
	const extraStr = extra.filter((t) => t?.trim()).join(", ");
	if (extraStr) parts.push(extraStr);
	if (!parts.length) return "";
	// A BARE TERM LIST, deliberately — no sentence, no first person, no "the speaker …" framing.
	// (Also the format `transcribeBiasTerms` below reads back, so the terms stay recoverable.)
	//
	// The prompt used to open "The speaker is talking to an AI assistant about their work. Expect
	// terms like: …". Given silence, Whisper does not return nothing: it continues the prompt in
	// the prompt's own style. A prose, first-person framing produced fluent phantom user messages
	// — "I just need to refactor this function before I commit the changes to the repo" — built
	// entirely from the term list below and logged as something the user said. A comma-separated
	// list has no grammatical continuation to fall into, and it is the form OpenAI documents for
	// vocabulary bias anyway.
	return parts.join(", ");
}

/** Read a bias prompt back into its terms — the inverse of the join above. */
export function transcribeBiasTerms(prompt?: string): string[] {
	return (prompt || "")
		.split(",")
		.map((t) => normalizeSpeech(t))
		.filter(Boolean);
}

/**
 * Is this transcript just our own vocabulary list read back to us (#332)?
 *
 * The observed failure: two user messages in a row, both carrying audio, both reading **"Coder
 * Lead"** — the agent's own name, which the console adds to the bias list. The user said neither.
 * Given silence, the decoder does not return nothing; it returns a term from the list it was
 * handed, and a PROPER NOUN is the likeliest one to surface because it is the only distinctive
 * token among generic vocabulary. `365475c` fixed the fluent version of this (a prose framing
 * produced whole invented sentences) by making the prompt a bare list. A bare list still supplies
 * candidates — the failure got quieter, not fixed.
 *
 * ── Why MULTI-WORD terms only
 *
 * `isNoiseTranscript`'s whole contract is that genuine short commands survive: "yes", "no", "go",
 * "stop", "next" are deliberately NOT filtered. A one-word bias term is the same shape — "commit",
 * "deploy" and "refactor" are all things a user really does say alone to a coding agent, and
 * dropping one would trade a phantom turn for a swallowed one, which is the same bug wearing the
 * other hat. A multi-word term echoed back ALONE ("Coder Lead", "pull request") carries no
 * instruction at all, so the cost of asking for it again is close to zero.
 *
 * This is defence in depth, not the fix: silence should never reach the decoder in the first
 * place (see the dictation gate in `gate.ts` and `endOfTurnAction`). It is what catches the leak.
 */
export function isTranscribeBiasEcho(text: string, prompt?: string): boolean {
	const t = normalizeSpeech(text);
	if (!t.includes(" ")) return false; // single word (or empty) → a plausible real utterance
	return transcribeBiasTerms(prompt).includes(t);
}
