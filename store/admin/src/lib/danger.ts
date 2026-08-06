/**
 * The destructive-action state machine (#280, #282).
 *
 * These guards used to live inside `DangerAction`'s JSX — two-step open→confirm, the
 * echo gate, the 409→force path — which made them untestable by construction: this repo
 * has no DOM environment and no component-testing stack, so nothing could assert the
 * levers that suspend an account or delete an agent behaved as described. #282 chose to
 * push the logic down here rather than adopt a renderer, so the component becomes a
 * dumb view over a reducer that IS testable.
 *
 * The safety properties are structural, not conventional:
 *
 *  - `force` is DERIVED from `blocked` (`runArgs`), and only `failureEvent` sets
 *    `blocked`, and only from a 409. So forcing on a first attempt is not "something we
 *    remember not to do" — there is no state in which a first attempt carries force.
 *  - `canConfirm` is the single echo gate. A mismatched or empty echo cannot arm
 *    anything, and the typed value is handed to the request builder rather than the
 *    component re-supplying the correct one from props (see `moderation-policy.ts`).
 */

export interface DangerState {
	/** The control has been opened. Opening is a separate act from confirming. */
	open: boolean;
	/** What the operator has typed into the echo box. */
	typed: string;
	/** Free-text reason, stored in the audit row. */
	reason: string;
	/** A request is in flight. */
	busy: boolean;
	/**
	 * The API's 409 message, verbatim. Empty until the platform has refused once and
	 * told us how many live subscribers this would strand. This is the ONLY thing that
	 * unlocks forcing, which is why forcing cannot precede reading the count.
	 */
	blocked: string;
	/** A real failure, shown in the open panel. */
	error: string;
	/** A success line, shown next to the closed button. */
	ok: string;
}

export const initialDangerState: DangerState = {
	open: false,
	typed: "",
	reason: "",
	busy: false,
	blocked: "",
	error: "",
	ok: "",
};

export type DangerEvent =
	| { type: "open" }
	| { type: "cancel" }
	| { type: "typed"; value: string }
	| { type: "reason"; value: string }
	| { type: "submit" }
	| { type: "succeeded"; message: string }
	/** The API refused with a 409 and told us what is in the way. Not a failure. */
	| { type: "blocked"; message: string }
	| { type: "failed"; message: string };

export function dangerReducer(state: DangerState, event: DangerEvent): DangerState {
	switch (event.type) {
		case "open":
			// Clear the previous success line: a stale "Suspended." sitting next to a
			// freshly opened panel reads as though this attempt already succeeded.
			return { ...state, open: true, ok: "" };
		case "cancel":
			// Everything the operator entered goes with it, including the 409 — a
			// reopened control must re-earn the right to force.
			return { ...state, open: false, typed: "", reason: "", error: "", blocked: "", busy: false };
		case "typed":
			return { ...state, typed: event.value };
		case "reason":
			return { ...state, reason: event.value };
		case "submit":
			return { ...state, busy: true, error: "" };
		case "succeeded":
			// Close and clear, but keep `ok` — the operator needs to see what landed.
			return { ...initialDangerState, ok: event.message };
		case "blocked":
			return { ...state, busy: false, blocked: event.message };
		case "failed":
			return { ...state, busy: false, error: event.message };
		default:
			return state;
	}
}

/**
 * Classify a rejected request.
 *
 * A 409 on a forceable action is INFORMATION — the platform saying "N live subscribers
 * are attached" — and becomes `blocked`, which surfaces the count and offers a second,
 * distinctly-labelled action. Everything else is a plain failure. A 409 on an action
 * that is not forceable is also a plain failure: there is nothing to escalate to.
 */
export function failureEvent(status: number | null, message: string, forceable: boolean): DangerEvent {
	if (forceable && status === 409) return { type: "blocked", message };
	return { type: "failed", message };
}

/**
 * The echo gate. `confirmPhrase` is the agent's slug / the provider / the login; it has
 * to match EXACTLY. No trimming, no case folding — a control that accepts "Delete " for
 * "delete" is not an echo gate, it is a speed bump.
 */
export function canConfirm(state: DangerState, confirmPhrase?: string): boolean {
	if (state.busy) return false;
	if (!confirmPhrase) return true;
	return state.typed === confirmPhrase;
}

/** Which button the open panel is showing: the plain confirm, or the escalation. */
export function confirmAction(state: DangerState): "confirm" | "force" {
	return state.blocked ? "force" : "confirm";
}

/**
 * The arguments handed to the action.
 *
 * `force` is derived from the recorded 409 and is `undefined` — not `false` — when
 * absent, so an action that never reads it cannot accidentally receive a meaningful
 * falsy value. `confirmed` carries what the operator ACTUALLY TYPED, so the request
 * builder validates the echo instead of the component substituting the right answer
 * from its own props.
 */
export function runArgs(state: DangerState): { reason?: string; force?: boolean; confirmed?: string } {
	return {
		reason: state.reason.trim() || undefined,
		force: state.blocked ? true : undefined,
		confirmed: state.typed || undefined,
	};
}

/**
 * Pull "N active instance(s)" out of the API's 409 so the count leads the copy.
 * Returns null when the message does not carry one — in which case the raw message is
 * shown rather than a confident-looking zero.
 */
export function blockedCount(message: string): number | null {
	const m = message.match(/(\d+)\s+active instance/i);
	return m ? Number(m[1]) : null;
}
