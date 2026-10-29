import { clipMarked } from "./clip-marked.js";

/**
 * What the run's own words have already ruled out, for `questions: "decide"` (#1390).
 *
 * `judgeQuestion` ranked a question's options by how reversible they read and knew nothing else about the run. Run 31555ee5 had the objective
 * "Close #243 only if all three are green … otherwise leave it open and report what failed", and a hint repeating "Close #243 only when the
 * production E2E is fully green". The E2E failed. The run asked {close, leave open}; decide took "close" as the most reversible, and the run closed
 * an issue its objective said to keep open.
 *
 * The platform cannot tell whether "the E2E is green" — that is a fact about the run's work, and the run is the one that checked it. What it CAN
 * tell is that the objective made closing conditional (or forbade it). So when it did, an option that closes is never chosen FOR the run: it is set
 * aside like any other option that needs the owner, the remaining options compete on reversibility as before, and when none is left the question
 * parks. Closing then stays what the objective made it: something the run does itself, once its own condition holds.
 *
 * Narrow on purpose, like the guardrails beside it: each pattern fires on a phrase that plainly gates or forbids closing, and a false match only
 * costs a "leave it open" the run can overrule, where a false pass is the defect this fixes. Pure.
 */

/** A phrase that makes closing conditional or forbids it. Tried against one sentence at a time. */
const GATES: RegExp[] = [
	// "Close #243 only if / unless / provided …", "close it as long as …"
	/\bclos(?:e|ing)\b[^.\n]{0,200}\b(?:only|unless|provided|as long as)\b/i,
	// "Only close if …", "only closing when …"
	/\bonly\s+(?:to\s+)?clos(?:e|ing)\b/i,
	// "Do not close", "don't close yet", "never close", "must not close"
	/\b(?:do not|don'?t|never|must not|mustn'?t|should not|shouldn'?t|not to)\s+(?:yet\s+)?clos(?:e|ing)\b/i,
	// "otherwise leave it open", "keep #243 open"
	/\b(?:leave|keep)\b[^.\n]{0,80}\bopen\b/i,
	// "Close #243 when the E2E is green", "close it once CI passes"
	/\bclos(?:e|ing)\b[^.\n]{0,160}\b(?:if|when|once|after)\b[^.\n]{0,120}\b(?:green|pass(?:es|ing)?|succeed(?:s|ed)?|verified|confirmed)\b/i,
];

/** Splits on the end of a sentence or a line, keeping each sentence whole enough to quote. */
function sentences(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+|\n+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * The sentence in the run's own words that gates or forbids closing, quoted (clipped), or null when none does. The first sentence that matches
 * wins; the texts are the objective, then any hints and standing rules, in the order given.
 */
export function closingGate(texts: ReadonlyArray<string | null | undefined>): string | null {
	for (const text of texts) {
		if (!text) continue;
		for (const s of sentences(text)) {
			if (GATES.some((re) => re.test(s))) return clipMarked(s, 200, { within: true });
		}
	}
	return null;
}

const CLOSES = /\b(?:clos(?:e|es|ing)|resolv(?:e|es|ing)\s+(?:the\s+)?(?:issue|ticket|#\d+))\b/i;
/** "don't close", "without closing", "instead of closing", "rather than closing": the clause says NOT to. */
const NEGATED_CLOSE = /\b(?:do not|don'?t|not|never|without|instead of|rather than|avoid|no need to|no longer)\s+(?:\w+\s+){0,2}(?:clos(?:e|es|ing)|resolv(?:e|es|ing))\b/i;
/** A bare "yes" to a question that asks whether to close. */
const AFFIRMATIVE = /^\s*(?:yes|y|ok|okay|sure|proceed|go ahead|do it|approve|confirm)\b/i;

/** Does this text ask for, or propose, closing something? A negated clause ("do not close") does not. */
export function mentionsClosing(text: string): boolean {
	return CLOSES.test(text.replace(new RegExp(NEGATED_CLOSE.source, "gi"), " "));
}

/**
 * Would taking this option close the issue? It says so ("Close #243 … and file a separate issue"), or the question asked whether to close and
 * the option is a bare yes. "Leave #243 open" and "Do not close it" do not.
 */
export function closesSomething(option: string, question: string): boolean {
	if (mentionsClosing(option)) return true;
	return mentionsClosing(question) && AFFIRMATIVE.test(option);
}
