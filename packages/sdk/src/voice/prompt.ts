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
	const extraStr = extra.filter((t) => t && t.trim()).join(", ");
	if (extraStr) parts.push(extraStr);
	if (!parts.length) return "";
	// Framed as context, not a command — the prompt primes vocabulary, it isn't spoken.
	return `The speaker is talking to an AI assistant about their work. Expect terms like: ${parts.join(", ")}.`;
}
