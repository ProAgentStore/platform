/**
 * What a handoff-status poll can answer WITHOUT looking at the live page (#641).
 *
 * A handoff is the runner asking a human for something the brain cannot do: solve a
 * challenge, perform one widget step it failed at, or supply a value it must not invent.
 * The remote Workflow polls `browserHandoffStatus` until it is told the human acted, and
 * `solved: true` is a licence to resume the application — so the only safe answers are the
 * ones the runner can actually stand behind.
 *
 * ── The rule
 *
 * A handoff whose PAGE IS GONE is LOST, not resolved. It is the same category as a handoff
 * whose SESSION is gone (the runner restarted, the takeover expired), which the caller
 * already answers `solved: false` under a comment stating the rule outright: *a status poll
 * must never relaunch the browser or claim a lost handoff is done.* Three lines below that
 * comment sat `if (page.isClosed()) return { solved: true }`, ahead of all three per-reason
 * branches, so it overrode every one of them:
 *
 *   - `challenge` — the brain resumed with the CAPTCHA unsolved, and the claim was acted
 *     on rather than re-checked: the workflow records `solvedChallengeUrl`, and the apply
 *     loop then suppresses captcha re-detection on that page for the rest of the round. A
 *     false "solved" muted the detector that would have caught it.
 *   - `stuck` — resumed without the human doing the single step the handoff exists for;
 *     `humanDone` was never consulted.
 *   - `needs_input` — resumed with `value: undefined`, so the workflow skipped the save and
 *     the brain re-asked on the next round for a value it had been given.
 *
 * There is nothing to resume ONTO in any of those cases: the page the human was working in
 * no longer exists, and the brain's next action would land on a freshly created blank tab.
 * Staying unsolved lets the wait time out into "not resolved in time", which the cloud maps
 * to `escalated` → the board's "Needs you" column — visible, and retryable by the owner.
 *
 * ── The one exception, and why it is not one
 *
 * `needs_input` is answered BEFORE page liveness is considered, because its answer never
 * involved the page: the value arrives out of band through `browserSubmitInput`, which
 * writes it onto the session. A value the owner typed is a real answer whether or not the
 * tab survived, and discarding it would re-ask for something already in hand.
 */

/** The facts a status poll has about a handoff, with no browser in them — so this is pure. */
export interface HandoffFacts {
	/** `challenge` (the default for an unrecognised reason), `stuck`, or `needs_input`. */
	reason?: string;
	/** Whether the page the human was handed is closed. */
	pageClosed: boolean;
	/** The value supplied through the ask-and-hold channel, if any. */
	inputValue?: string;
	/** Whether the human explicitly said they were finished. */
	humanDone?: boolean;
}

export interface HandoffStatus {
	solved: boolean;
	challenge: string | null;
	value?: string;
}

/**
 * The answer to a handoff-status poll, or `null` when only the live DOM can give one — a
 * `challenge` on a page that is still open, whose token clears in the page itself.
 */
export function resolveHandoffStatus(facts: HandoffFacts): HandoffStatus | null {
	// Out of band, and therefore unaffected by a page that has gone.
	if (facts.reason === "needs_input") return { solved: !!facts.inputValue, challenge: null, value: facts.inputValue };
	// Lost, not done. See the note above — this line is the fix for #641.
	if (facts.pageClosed) return { solved: false, challenge: null };
	// A stuck handoff resumes only when the human explicitly clicks Resume — there's
	// nothing to auto-detect.
	if (facts.reason === "stuck") return { solved: !!facts.humanDone, challenge: null };
	return null;
}
