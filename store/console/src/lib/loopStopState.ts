/**
 * What the Stop control on an autonomous run says and does — including the state nothing rendered
 * (#376).
 *
 * Cancelling a loop run is COOPERATIVE by design. `requestCancel` sets a flag the workflow reads at
 * the TOP of the next iteration, so the in-flight step finishes and settles its spend; killing
 * mid-step would strand a reservation against the shared tree pool and leak headroom nothing ever
 * gives back. That reasoning is sound and is not what this file changes. What matters here is the
 * WAIT it implies: the in-flight step is `act-<n>`, a whole agent turn — on a coding agent, a whole
 * Claude Code task. Minutes, not seconds.
 *
 * That wait was invisible. `cancelRequested` rides on every `/loop` and `/loop/:runId` response and
 * no UI in either console read it: a row rendered from `status === "running"` alone, so pressing
 * Stop flashed a transient component-state sentence, the row went on saying **running**, and the
 * Stop button stayed live. Press it again — the same. The flag was set, re-set and re-set, and the
 * user was right to conclude the button did nothing.
 *
 * So a run has THREE states, not two, and the third one is the one that needed a name. A
 * cooperative cancel with a multi-minute settling window is fine; a cooperative cancel with a
 * multi-minute window and no persistent acknowledgement is indistinguishable from a broken button.
 *
 * A pending cancel DISABLES Stop rather than escalating a second press to a hard abort. #376 raises
 * that idea and it is a real one, but it reintroduces exactly the stranded reservation the
 * cooperative design exists to avoid — a decision to take deliberately, not one to fall into
 * because a disabled button felt unsatisfying.
 */

/** The fields of a loop run that decide what the Stop control does (`LoopRunView` has more). */
export interface LoopRunStopLike {
	status: string;
	/** Set by `POST /loop/:runId/cancel`. Absent ⇒ no cancel pending, which is also how an older
	 *  server that does not send the field reads — the pre-#376 behaviour, not a wrong answer. */
	cancelRequested?: boolean | null;
}

/** `running` and `stopping` are both `status === "running"` on the wire; only the flag separates them. */
export type LoopPhase = "running" | "stopping" | "ended";

/**
 * The sentence for the wait.
 *
 * It names WHAT is being waited for, because a multi-minute pause with no stated cause reads as a
 * hang rather than as the documented behaviour it is. `work-report.ts` already composed this fact
 * for the agent's own work report ("a cancel has been requested"); the console never got it.
 */
export const STOPPING_HINT = "Stopping — the current step has to finish first. This can take a few minutes.";

export interface LoopStopControl {
	phase: LoopPhase;
	/**
	 * The run's own word, for a status line. `null` once it has ended — the caller has a better
	 * label then, because it knows the stop reason and "cancelled" is not the same news as "failed".
	 */
	statusLabel: string | null;
	/** The button's text. */
	actionLabel: string;
	/** May the button be pressed? */
	canStop: boolean;
	/** What the wait is for, or `null` when nothing is pending. */
	hint: string | null;
}

/** One run → everything the Stop control needs. The components then only render. */
export function loopStopControl(run: LoopRunStopLike | null | undefined): LoopStopControl {
	if (run?.status !== "running") {
		return { phase: "ended", statusLabel: null, actionLabel: "Stop", canStop: false, hint: null };
	}
	if (!run.cancelRequested) {
		return { phase: "running", statusLabel: "running", actionLabel: "Stop", canStop: true, hint: null };
	}
	return { phase: "stopping", statusLabel: "Stopping…", actionLabel: "Stopping…", canStop: false, hint: STOPPING_HINT };
}
