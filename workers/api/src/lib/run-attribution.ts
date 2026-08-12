/**
 * A run report may not put words in the owner's mouth (#505).
 *
 * ── What happened
 *
 * A Pilot run's **Loop complete** message told the owner that `app/pubspec.yaml` was bumped "per
 * explicit user instruction", and that "the user was warned … but explicitly chose to bump
 * `app/pubspec.yaml` and proceed". `instance_messages` shows no owner turn anywhere in that window.
 * He was never warned and never chose; the engine's objection was correct, the override broke the
 * deploy (`version-check` failed, the admin deploy was skipped), and he found out afterwards.
 *
 * ── Why the agent was not lying
 *
 * `packages/browser-runner/src/coding/headless.ts:451` writes the Pilot's instruction to the engine
 * as `role: "user"`. The engine has no way to know it is being driven by another model, so it
 * correctly calls its interlocutor "the user" — and that word means the PILOT. The Pilot then reads
 * its own transcript back, relays the wording verbatim into `finish(detail)`
 * (`coding-loop.ts`), and the workflow posts it unmodified. By the time it reaches the owner,
 * "the user" reads as him.
 *
 * ── The rule this enforces
 *
 * The platform's prompt doctrine already forbids claiming an action succeeded when it failed. This
 * is the same rule one step further out — claiming a human authorised something they were never
 * asked about — and it is worse, because it is unfalsifiable from the owner's side: he cannot tell
 * a decision he forgot from one he never made, and the transcript agrees with the agent.
 *
 * So the platform states what it KNOWS and the agent cannot: whether the human said anything to
 * this run at all. It annotates rather than rewrites, for the same reason `reply-truncation.ts`
 * does — deleting the agent's own words would hide the disagreement instead of surfacing it, and
 * the owner needs to see the claim in order to distrust it.
 *
 * The Pilot-side half of #505 is in `coding-loop.ts`'s system prompt (who "the user" is in the
 * terminal, and that an engine objection is escalated rather than overridden). This module is the
 * half that holds when the prompt does not.
 */

/**
 * Verbs that turn a mention of the human into a CLAIM ABOUT WHAT THEY DECIDED.
 *
 * Naming a person is not attribution — "the user's repo has no tests" is a fact about a repo. What
 * makes it attribution is a decision verb: they chose, asked, approved, were warned. Nouns that
 * double as verbs (`request`, `order`) are deliberately absent in their bare form; only the
 * inflected verb forms are listed, because "the request status" is a field name and "the user
 * requested" is a claim.
 */
const DECISION_VERB =
	"(?:chose|chosen|decided|requested|asked|instructed|confirmed|approved|authorised|authorized|directed|insisted|specified|said|told|wanted|agreed|declined|opted|preferred|warned|acknowledged|accepted|overrode|overruled|signed off|gave the go-ahead)";

/**
 * Compound nouns that begin with "user" and are never a person deciding something.
 *
 * A coding report says "the user model", "the user table", "user-facing docs" constantly, and the
 * 40-character window below would otherwise reach past them to an unrelated verb.
 */
const NOT_A_PERSON = "(?!\\s*(?:interface|model|models|table|tables|story|stories|account|accounts|data|id|ids|input|record|records|row|rows|schema|profile|profiles|agent|agents|list|type|types|object|objects|-|_))";

/**
 * The wordings that claim the human decided something.
 *
 * DELIBERATELY over-inclusive. A false positive costs one extra sentence that is true anyway ("you
 * sent no message to this run"); a false negative is the whole defect — a decision the owner never
 * made, reported to him as his own, in a message he has no way to check. The asymmetry is the
 * design, and it is why this is a list of patterns rather than one careful one.
 */
const OWNER_ATTRIBUTION: RegExp[] = [
	// "the user was warned …", "the owner explicitly chose …", "the user, having been asked, agreed"
	new RegExp(`\\b(?:the\\s+)?(?:user|owner|human|operator)\\b${NOT_A_PERSON}(?:'s)?[^.!?\\n]{0,40}?\\b${DECISION_VERB}\\b`, "i"),
	// "per explicit user instruction", "per your direction"
	/\bper\s+(?:the\s+)?(?:explicit|express|direct|specific)?\s*(?:user|owner|your|their)\b[^.!?\n]{0,20}?\b(?:instruction|instructions|request|direction|directive|choice|decision|approval|confirmation|order|orders)\b/i,
	// "at the user's request", "at your direction"
	/\bat\s+(?:the\s+)?(?:users?'?s?|owners?'?s?|your)\s+(?:request|direction|instruction|insistence|behest)\b/i,
	// "you explicitly chose", "you asked for", "you approved"
	new RegExp(`\\byou\\b[^.!?\\n]{0,30}?\\b(?:explicitly\\s+)?${DECISION_VERB}\\b`, "i"),
	// "your explicit instruction", "your approval", "your sign-off"
	/\byour\s+(?:explicit\s+|express\s+)?(?:instruction|instructions|request|decision|choice|approval|direction|confirmation|go-ahead|sign-off)\b/i,
];

/** Does this report claim the human decided, asked for, approved or was warned about something? */
export function claimsOwnerDecision(detail: string): boolean {
	if (!detail) return false;
	return OWNER_ATTRIBUTION.some((re) => re.test(detail));
}

/** The platform's own voice, matching the ⚠️ prefix the fabrication (#395) and cap (#397) notices use. */
const PREFIX = "⚠️ **platform**";

/**
 * What the owner reads under a report that speaks for him.
 *
 * Every clause is a fact this code can prove: he sent nothing to the run, the objective is the one
 * thing he did author, and the engine's "user" is the orchestrator because that is the role the
 * runner writes. It does NOT assert the agent was wrong — the objective may genuinely have said to
 * do the thing — it tells him exactly where to look, which is the difference between a correction
 * and a guess.
 */
export function attributionNotice(): string {
	return (
		`${PREFIX} You sent no message to this run — the only thing you authored was the objective it started from.` +
		' The orchestrator\'s own instructions reach the engine as `role: "user"`, so where the engine\'s transcript says' +
		' "the user" it means the ORCHESTRATOR. Any decision above that is not in your objective was the orchestrator\'s own.'
	);
}

/**
 * Stamp the completion report when it attributes a decision to an owner who never spoke.
 *
 * Both conditions are required. Attribution wording with a real owner turn behind it may well be
 * true, and a notice that fires on true statements stops being read — the same reason `hitOutputCap`
 * refuses to fire on a reply that simply finished.
 *
 * `ownerTurns` counts INTERVENTIONS IN THIS RUN: a takeover the human resolved, a value they
 * supplied to a needs-input handoff. The objective is not one — it is authored before the run and
 * cannot authorise a decision the run had not yet reached.
 */
export function annotateOwnerAttribution(detail: string, ownerTurns: number): string {
	if (ownerTurns > 0 || !claimsOwnerDecision(detail)) return detail;
	return `${detail}\n\n${attributionNotice()}`;
}
