/**
 * Whose sentence wins when the platform's style hint contradicts the subscriber's own rule (#521).
 *
 * ## The defect
 *
 * An owner stored this in Rules & Tips: *"Do NOT mention file names, file paths, directory names,
 * or code identifiers … unless I explicitly ask for them."* Three replies over two days named
 * `TournamentDetail.tsx`, `STUDENT_OPEN_TOURNAMENTS_SQL`, `E2E_TARGET_URL` and more — every one of
 * them straight after a tool round.
 *
 * The rule was not ignored; it was OUT-POSITIONED. Rules & Tips lands mid-system-prompt
 * (`agent-think.ts`, `## Subscriber Rules`), while `resolveResponseStyle`'s technical branch —
 * *"cite real file paths/functions"* — is appended to the LAST USER TURN, twice: once per tool
 * round and once again as *"Now give your final answer."*. `agent-think.ts` records that position
 * as *"the strongest position of all"* off its own earlier measurement, so the platform was
 * out-arguing its own user with a sentence written after his, every turn.
 *
 * ## The fix, and the two options it rejects
 *
 * Chosen: **fold both into the same (strongest) position, subscriber LAST.** The platform keeps its
 * style sentence, then hands authority away to the owner's own words, which are quoted after it.
 *
 * - *Suppression* (drop the style sentence whenever any rule exists) was rejected: the sentence
 *   also carries "grounded in the code above" and the plain-English lead-in, so an unrelated rule
 *   ("always answer in Spanish") would silently delete an accuracy instruction — the same trade
 *   `resolveResponseStyle` already refuses when it keeps `GROUNDED` alongside a declared style.
 * - *Conflict detection* (only defer when the rule actually contradicts the hint) was rejected as
 *   undecidable: no reliable test says whether free text conflicts with a sentence. Precedence by
 *   POSITION needs no such test, which is what makes it general — it works for a rule about emoji,
 *   about length, about language, not only about file paths.
 *
 * This is also the resolution order the platform already commits to everywhere else: creator
 * default < subscriber override (`resolveBehaviour`).
 *
 * ## Why the quote is bounded
 *
 * `specialInstructions` is capped at 4000 chars (`routes/instances-apply.ts:364`) and this string is
 * re-sent on EVERY tool round (up to 3) plus the final answer — so quoting the maximum verbatim
 * would repeat ~4000 chars four times in one turn, purely duplicating text the system prompt
 * already carries. Above the limit the reminder points at the `## Subscriber Rules` block instead,
 * carrying the identical precedence clause. A rule is never cut mid-sentence and presented as the
 * whole rule: it is quoted whole or not at all.
 *
 * 700 chars is sized off what real rules weigh: the rule that produced this ticket is 175 chars, so
 * the limit carries it — and a set of three or four such rules — verbatim, while a pasted policy
 * document falls back to the pointer.
 *
 * ## Why the clause names more than the sentence it trails
 *
 * The last user turn is the strongest position, but it is not the only one that out-positions the
 * owner. `agent-style-prompt.ts`'s `STYLE:` block — "cite real file paths, functions and short
 * snippets when they help" for a `codingContext` agent — is appended to the SYSTEM PROMPT at
 * `agent-think.ts:1113`, while `## Subscriber Rules` goes in at `:266`. Later in the same string is
 * a stronger position, so the rule is out-positioned there too, one rung down. Naming style
 * guidance generally costs no extra bytes and covers both.
 *
 * It says STYLE, and that word is load-bearing. Manner is all a subscriber may outrank: the
 * honesty/safety text ("never claim an action succeeded when it failed") must stay above free
 * subscriber text, which is the same reason `behaviourPrompt` is injected BEFORE it and why
 * `set_behaviour` is confined to `SELF_WRITABLE_FIELDS`. A rule saying "always tell me the build
 * passed" must lose, and under this wording it does.
 */

/** Longest set of rules quoted verbatim into the reminder. Sized in the header. */
export const SUBSCRIBER_RULE_QUOTE_LIMIT = 700;

const PRECEDENCE =
	"Your subscriber's standing rules OUTRANK this note (and any other STYLE guidance in your instructions) wherever the two conflict";

/**
 * Compose the reminder that rides the last user turn: the platform's style sentence, then the
 * subscriber's rules with precedence over it.
 *
 * With no rules stored (absent, empty, or whitespace-only) the platform sentence is returned
 * UNCHANGED, byte for byte — an instance whose owner never wrote a rule must see exactly today's
 * prompt. That is the one property this whole change is not allowed to break.
 */
export function withSubscriberRulePrecedence(platformReminder: string, subscriberRules?: string): string {
	const rules = typeof subscriberRules === "string" ? subscriberRules.trim() : "";
	if (!rules) return platformReminder;

	const deference =
		rules.length <= SUBSCRIBER_RULE_QUOTE_LIMIT
			? `${PRECEDENCE} — follow their words, exactly as written: ${rules}`
			: `${PRECEDENCE} — re-read the "## Subscriber Rules" section in your instructions and follow it exactly.`;

	// Join rather than interpolate: a caller with nothing to say must not contribute a leading space.
	return [platformReminder, deference].filter(Boolean).join(" ");
}
