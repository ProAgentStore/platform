/**
 * Transcription vocabulary bias. OpenAI's gpt-4o-transcribe accepts a `prompt` that
 * nudges the model toward expected words + spellings. Without it, homophones get
 * mis-heard out of context — a developer saying "bugs" comes back as "bars". We build
 * the prompt from the agent's surfaces (what it's FOR) so each agent biases toward its
 * own domain vocabulary.
 */

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
