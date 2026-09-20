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

/**
 * What the server says a Continue would carry forward (#806 item 2).
 *
 * A NAMED shape rather than an inline object literal on the call: `check-console-types.mjs`
 * ratchets every anonymous shape a console API call declares, and naming one is the only
 * direction that ratchet moves. It is also the honest shape — the fields below are what
 * `GET …/continue-preview` returns, and a reader can compare them to the route.
 *
 * Do not write the generic-call form out in a comment here. That guard's scanner skips a `//`
 * line but reads a block comment, so a doc comment demonstrating the pattern it forbids IS a
 * finding — the same "explaining it regenerates it" trap `check-design-tokens.mjs` records for
 * Tailwind class names, found the same way: by tripping it.
 */
export interface ContinuePreview {
	runId: string;
	canContinue: boolean;
	/** Why not, in the server's words. Null when it can be continued. */
	refusal: string | null;
	maxIterations: number;
	briefing: {
		kind: "this-run" | "other-run" | "none";
		predecessorRunId: string | null;
		landed: string[];
		landedOverflow: number;
		unobserved: number;
		uncommittedFiles: number | null;
		workingTree: "read" | "unavailable";
		/** The stopped Pilot's own notes, oldest first. Optional: an API older than #806's last slice omits it. */
		learned?: string[];
		caveat: string | null;
		note: string | null;
	};
	/** One sentence, composed SERVER-SIDE. Rendered verbatim — see {@link previewLines}. */
	summary: string;
}

/**
 * The lines the panel renders, in order.
 *
 * The headline is the server's `summary` and is never rebuilt here. That is the whole point of the
 * field: this page and the run's own briefing have to agree about what carries forward, and a
 * console that phrased it locally would be a second voice for one fact — free to drift the day
 * either side changes, with nothing failing when it did.
 *
 * What IS decided here is layout: which of the server's facts earn a line of their own. The landed
 * list does, because "3 actions already landed" is a claim an owner should be able to check rather
 * than take; the caveat does, because an unreadable tree is the difference between a promise and a
 * guess; the ceiling does, because it is the one number the button spends.
 */
export function previewLines(p: ContinuePreview): string[] {
	const lines = [p.summary];
	for (const act of p.briefing.landed) lines.push(`· ${act}`);
	if (p.briefing.landedOverflow > 0) {
		lines.push(`· …and ${p.briefing.landedOverflow} more`);
	}
	// The stopped run's own account of where it had got to (#806 item 2's "what it was mid-way
	// through"). Quoted and attributed: these are the Pilot's claims at the time, and a panel that
	// listed them bare beside the landed acts would present an intention as a fact on the record.
	const learned = p.briefing.learned ?? [];
	if (learned.length > 0) {
		lines.push("What the run noted to itself as it worked — its own words, not checked:");
		for (const note of learned) lines.push(`“${note}”`);
	}
	if (p.briefing.caveat) lines.push(p.briefing.caveat);
	// Only when it can actually be pressed: on a refused run the number describes nothing.
	if (p.canContinue) lines.push(`Continuing would give the new run up to ${p.maxIterations} steps.`);
	if (p.refusal) lines.push(`This run cannot be continued: ${p.refusal}`);
	return lines;
}

/**
 * The body a Continue sends (#806 item 3(b)).
 *
 * Empty unless the owner typed something: an empty body is "another run of the same size on the
 * same objective", and a blank `note` key would be a second spelling of that for the server to
 * agree with. Trimmed here so a textarea holding only a newline is not an instruction.
 */
export function continueBody(note: string | undefined): { note?: string } {
	const text = (note ?? "").trim();
	return text ? { note: text } : {};
}
