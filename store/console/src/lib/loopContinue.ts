/**
 * Which ended runs offer a Continue button (#806 item 3(c)).
 *
 * ── The server is the authority, and this is a filter
 *
 * `RESUMABLE_STOP_REASONS` lives in `workers/api/src/lib/agent-loop-store.ts` and is where the
 * decision is made: `POST /:id/loop/:runId/continue` refuses anything else with a 409 that names
 * what to do instead. This list exists only so the button is not OFFERED on a run the server will
 * refuse — a control that always errors is worse than no control.
 *
 * So the two lists can drift, and the drift is survivable in one direction only, which is why it is
 * worth stating: a reason added to the server and not here costs a button that could have been
 * shown; a reason added here and not to the server costs a click that comes back as an explained
 * 409. Neither can start work the server would not have started. The console cannot import the
 * worker's copy — different build, no shared package — and vendoring is this repo's answer to that
 * (see the workspace CLAUDE.md), so a copy with its direction of failure written down beats an
 * import that does not exist.
 *
 * ── Why "ended" is checked separately from the reason
 *
 * A run still going has no `stopReason` at all, so the reason test alone would be enough today. It
 * is checked anyway because the two facts answer different questions — "is this over" and "was it
 * over WITHOUT a verdict" — and a run that reports a reason while still running (a cooperative
 * cancel settling, a park) must not grow a Continue button underneath its Stop button.
 */

/** The endings the server will continue. Kept in the order `RESUMABLE_STOP_REASONS` lists them. */
export const CONTINUABLE_STOP_REASONS = ["interrupted", "max_iterations", "engine_limit", "provider_credit"] as const;

/** The fields of a loop run that decide whether Continue is offered (`LoopRunView` has more). */
export interface LoopRunContinueLike {
	status: string;
	stopReason?: string | null;
}

/**
 * Is this run one the owner can carry on from?
 *
 * Deliberately not "should we show a Continue button" — the caller decides that, because the same
 * answer is wanted in two places that render differently. This is the fact, not the layout.
 */
export function canContinueRun(run: LoopRunContinueLike | null | undefined): boolean {
	if (!run || run.status === "running") return false;
	return (CONTINUABLE_STOP_REASONS as readonly string[]).includes(run.stopReason ?? "");
}
