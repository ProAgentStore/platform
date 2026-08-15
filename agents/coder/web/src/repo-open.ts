// What the repo row's ONE action says, and when the tab opens a session by itself (#408).
//
// The console used to put two different buttons in that slot — **Open** when a session existed and
// **Start** when it did not — which is the platform asking the user to manage a cache. A session is
// a `coding_sessions` row plus a child process; the platform reaps it after six idle hours and
// re-opens it on demand, so which of those two states a repo happens to be in at the moment you
// look at it is not a question the user should be answering. The mental model is REPOS: the thing
// they chose, named and configured.
//
// So: one verb. `Open` ensures a session exists (the server route already reuses a live one) and
// lands on the terminal. Whether that involved spawning anything is the platform's business.
//
// Pure, because the two rules below are the ones most likely to be "tidied" back into a regression:
// disabling the action while the runner looks offline, and auto-opening regardless of whether it
// does.

export interface RepoOpenAction {
	label: string;
	disabled: boolean;
	/** Hover/aria text. Carries the diagnosis when there is one — never a substitute for the action. */
	title: string;
}

/**
 * The label and enabled-state of a repo's single action.
 *
 * NEVER disabled for an offline-looking runner, and that is #241's lesson rather than politeness:
 * connectivity is only ever learned from a live session's capture, so with no session and no way to
 * start one, "your machine isn't connected" can never be disproved — including while `pags up` is
 * demonstrably running. The warning goes in the title, beside the action, not in place of it.
 */
export function repoOpenAction(input: {
	hasActiveSession: boolean;
	opening: boolean;
	runnerOnline: boolean | null;
	/**
	 * The server's own reason for the offline reading (#537), when it has sent one.
	 *
	 * The hardcoded remedy below is wrong in the case where this action is MOST useful: a session
	 * stamped to a machine that is off, with another machine running `pags up` — opening it again is
	 * exactly what relocates it (`startSessionOnRunner`'s machine-switch reclaim), and "run `pags
	 * up`" tells the owner to do the thing they are already doing.
	 */
	offlineReason?: string | null;
}): RepoOpenAction {
	if (input.opening) {
		// A spawn plus a `--resume` takes seconds, not milliseconds (#378's lesson from the Terminal
		// tab: silence reads as a hang). The label is the progress indicator.
		return { label: "Opening…", disabled: true, title: "Starting the engine on your machine — this takes a few seconds." };
	}
	if (input.runnerOnline === false) {
		const why = (input.offlineReason || "").trim();
		return {
			label: "Open",
			disabled: false,
			title: why ? `${why} Opening will still try.` : "Your machine doesn't look connected — run `pags up`. Opening will still try.",
		};
	}
	if (input.hasActiveSession) return { label: "Open", disabled: false, title: "Open this repo's terminal." };
	return { label: "Open", disabled: false, title: "Open this repo — its engine starts if it isn't already running." };
}

/**
 * May the one-repo surface open its session WITHOUT being asked?
 *
 * Only there. For that agent the terminal IS the tab, so landing on a button that says "start the
 * thing this whole screen is about" is the question #408 opens with. A multi-repo agent gets no
 * auto-open: which repo you meant is a real question, and spawning an engine per repo on a tab
 * visit is not an answer to it.
 *
 * `runnerOnline === true` is required — not `!== false`. #408 is explicit that nothing may be
 * auto-opened with the runner offline, and `null` means "not known yet" (the tab has not observed a
 * capture), which must not be read as permission. The user's own click is still allowed either way;
 * see {@link repoOpenAction}.
 */
export function shouldAutoOpenSoloSession(input: {
	hasRepo: boolean;
	hasActiveSession: boolean;
	runnerOnline: boolean | null;
	/** This mount has already tried. Latched, so a failure is not retried on every render. */
	alreadyTried: boolean;
	opening: boolean;
}): boolean {
	return input.hasRepo && !input.hasActiveSession && input.runnerOnline === true && !input.alreadyTried && !input.opening;
}
