/**
 * Transcription vocabulary bias. OpenAI's gpt-4o-transcribe accepts a `prompt` that
 * nudges the model toward expected words + spellings. Without it, homophones get
 * mis-heard out of context — a developer saying "bugs" comes back as "bars". We build
 * the prompt from what the agent IS (its capabilities) plus the proper nouns the platform
 * and the user can name, so each agent biases toward its own domain vocabulary.
 *
 * ── WHAT BELONGS IN THIS LIST (the rule, applied everywhere below)
 *
 * A term earns a place only if it is BOTH **likely to be said** to this agent and **likely to be
 * mis-heard** by a general-purpose recogniser. Both halves matter, and the second one is the one
 * that keeps the list short:
 *
 *   - `tmux`, `pnpm`, `ATS` — said constantly, and not in the decoder's ordinary English prior.
 *     IN.
 *   - the agent's own name, an attached repo's name — said constantly ("ask Heartfull to…"),
 *     and by construction not a word. IN.
 *   - `file`, `open`, `please`, `yes` — said constantly and transcribed correctly every time.
 *     OUT. They dilute the list and buy nothing.
 *   - a commit SHA, a file path, a collection id, a URL — knowable, and never said out loud in
 *     that form. OUT, even though we could enumerate them.
 *
 * The list is finite (`prompt` is a bounded field and dilution degrades bias), so every term
 * added is a term of budget spent — see MAX_EXTRA_TERMS.
 *
 * ── AND WHY A LONGER LIST IS NOT A FREE WIN (#332)
 *
 * The bias list is also a hazard. Given a low-information clip the decoder does not return
 * nothing: it returns a term from the list it was handed, and that text is indistinguishable
 * from the user's own words. `isTranscribeBiasEcho` below catches the multi-word case. It
 * deliberately does not catch single words, so every SINGLE-WORD term added here is a term that
 * can come back as a phantom turn uncaught. That is the direct cost of a longer list, and it is
 * why the rule above is "likely to be mis-heard" rather than "we happen to know it".
 */

import { normalizeSpeech } from "./normalize.js";

/** Terms a developer says that generic ASR routinely mangles. */
const CODING_TERMS =
	"bug, bugs, debug, refactor, function, variable, repository, repo, commit, branch, " +
	"merge, pull request, deploy, build, lint, TypeScript, JavaScript, React, API, endpoint, " +
	"console, terminal, npm, pnpm, git, stack trace, null, undefined, async, await, regression";

/**
 * Terms said to a TERMINAL operator agent (#371).
 *
 * `tmux` is the word this whole ticket is about: the browser gate returned **Timo** for it, and
 * `tmux` was in no list anywhere despite being the agent's entire subject. The rest are the
 * nouns a user says when driving a shell — each one a word the decoder has a strong, WRONG
 * English prior for (`pane`→"pain", `detach`→"the tach") rather than merely a technical word.
 *
 * Deliberately NOT here: `run`, `open`, `list`, `show`, `output`. All said constantly, all
 * transcribed correctly, and all short single words — exactly the shape that comes back as a
 * phantom turn under #332 for no accuracy gain.
 */
const TMUX_TERMS = "tmux, pane, panes, window, session, attach, detach, shell, stdout, stderr, ssh, sudo, grep, tail";

/** Terms specific to the job-application agent. */
const APPLY_TERMS =
	"resume, résumé, application, cover letter, LinkedIn, recruiter, salary, relocation, " +
	"sponsorship, work authorization, ATS, Workday, Greenhouse, Lever";

/**
 * How many derived/user terms may ride along with the static lists.
 *
 * The `prompt` field is bounded and its bias quality DEGRADES with length — a 200-term list is
 * worse than a 20-term one, not better, because every term is a candidate the decoder can reach
 * for. 30 is roughly "the proper nouns one person says to one agent in a working session", which
 * is what the caller is asked to supply most-recently-used-first so the cap truncates the tail
 * rather than the head.
 */
export const MAX_EXTRA_TERMS = 30;

/** Split an identifier into the words it is SAID as: `tmux-operator-runner` is three words out
 *  loud, and `ProAgentStore/platform` is two. Returns "" when there is nothing to split, so the
 *  caller can skip adding a duplicate. */
export function spokenForm(term: string): string {
	const split = term
		.replace(/[_/\-.]+/g, " ")
		// camel/Pascal boundaries: `ProAgentStore` → `Pro Agent Store`. Said as words, written as one.
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/\s+/g, " ")
		.trim();
	return split && split !== term ? split : "";
}

export interface TranscribePromptOptions {
	/**
	 * The agent's declared `runtime` (`"coding"`, `"browser"`, …).
	 *
	 * #371's root cause was reading the wrong axis: the gate asked about SURFACES, a tmux operator
	 * has `surfaces: ["tmux"]`, and so `CODING_TERMS` — which already contained `console`,
	 * `terminal`, `git`, `npm`, `commit`, `deploy`, every word that user was saying — was skipped
	 * for an agent whose `runtime` was `"coding"` the whole time. Both axes are read now: a
	 * surface says what the agent SHOWS, a runtime says what it DRIVES, and either is enough to
	 * know the user is talking about code.
	 */
	runtime?: string | null;
}

/**
 * Build the transcription prompt for an instance from its capabilities (+ any extra proper
 * nouns: the agent's name, attached repo names, terminal targets — see #372). Returns "" when
 * there's nothing to bias, so the caller can omit the field entirely.
 */
export function buildTranscribePrompt(
	surfaces: string[] = [],
	extra: string[] = [],
	opts: TranscribePromptOptions = {},
): string {
	const parts: string[] = [];
	const codingish = surfaces.includes("coding") || surfaces.includes("repo") || surfaces.includes("tmux");
	if (codingish || opts.runtime === "coding") parts.push(CODING_TERMS);
	if (surfaces.includes("tmux")) parts.push(TMUX_TERMS);
	if (surfaces.includes("apply")) parts.push(APPLY_TERMS);
	// Dedupe against what the static lists already carry (`platform`, `git`, `console` arrive as
	// repo/target names constantly) — a term sent twice spends budget without adding bias — and
	// against each other, case-insensitively, since the same repo can reach us by two names.
	//
	// Keyed on CASE alone, not `normalizeSpeech`: the whole point of `spokenForm` is that
	// `tmux-operator-runner` and `tmux operator runner` are two spellings we want the decoder to
	// see, and the shared normaliser (which reduces punctuation to a space) collapses them into
	// one. `isTranscribeBiasEcho` still uses the shared normaliser, so an echo of either form is
	// caught by the same key — the two questions want different keys and now have them.
	const key = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
	const seen = new Set(parts.join(", ").split(",").map((t) => key(t)).filter(Boolean));
	const picked: string[] = [];
	for (const raw of extra) {
		const term = raw?.trim();
		if (!term) continue;
		for (const form of [term, spokenForm(term)]) {
			if (!form) continue;
			const k = key(form);
			if (!k || seen.has(k)) continue;
			seen.add(k);
			picked.push(form);
			if (picked.length >= MAX_EXTRA_TERMS) break;
		}
		if (picked.length >= MAX_EXTRA_TERMS) break;
	}
	if (picked.length) parts.push(picked.join(", "));
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
 * The rule is unchanged by #371/#372/#373, and it is the reason the term-entry rule at the top of
 * this file is written the way it is: a single-word addition is an addition this guard cannot
 * cover, so it has to earn its place on accuracy alone. Note that a derived or user-supplied
 * proper noun is usually helped here rather than hurt — `tmux-operator-runner` and
 * `ProAgentStore/platform` both arrive with a multi-word {@link spokenForm} beside them, and the
 * echo of EITHER form is caught.
 *
 * This is defence in depth, not the fix: silence should never reach the decoder in the first
 * place (see the dictation gate in `gate.ts` and `endOfTurnAction`). It is what catches the leak.
 */
export function isTranscribeBiasEcho(text: string, prompt?: string): boolean {
	const t = normalizeSpeech(text);
	if (!t.includes(" ")) return false; // single word (or empty) → a plausible real utterance
	return transcribeBiasTerms(prompt).includes(t);
}
