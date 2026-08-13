// What the Coding tab says when the ENGINE, not the platform, refused the turn (#545).
//
// The owner opened this tab on a Codex session, read "No output yet — send the engine an
// instruction to get started", and reported the engine as broken. He was wrong about that session
// (it was fresh) and right about the engine: another session's every turn was exiting 1, with
// `[codex exited with code 1]` printed in the pane three times, and nothing on the page could tell
// the two apart. A pane is something a person has to parse; this is the sentence.
//
// Pure, and separate from the component, for the reason ./engine-auth-view.ts is: the wording of a
// failure is the part that has to be right, and it is testable without a runner.

/** The `lastTurn` block the runner attaches to every /capture, from CLI 0.4.51. */
export interface EngineTurnReport {
	verdict?: string;
	exitCode?: number | null;
	signal?: string | null;
	at?: number;
	detail?: string;
}

export interface EngineTurnNotice {
	/** The headline: what happened, in the engine's own terms. */
	label: string;
	/** What it means — an engine that refuses is not an answer to the instruction. */
	detail: string;
	/** The engine's own last line, when it printed one. Rendered verbatim, as evidence. */
	evidence: string | null;
}

/**
 * Render the report, or null when there is nothing honest to say.
 *
 * Null for FOUR distinct reasons, and it matters that they collapse here rather than in the
 * component:
 *   * no report — the runner predates CLI 0.4.51, or no turn has finished. Absence is not a
 *     verdict, and a banner reading "unknown" on every un-updated machine would be noise.
 *   * `ok` — the turn worked. Nothing to report is the correct amount to report.
 *   * `killed` — WE ended it (the 15-minute wedge ceiling, an interrupt). The pane already carries
 *     that line, and it says nothing about the engine's health.
 *   * an unrecognised verdict — the runner is a published npm package and may be NEWER than this
 *     build. Guessing at a word this build does not know is how a green tick starts lying.
 */
export function engineTurnNotice(report: EngineTurnReport | null | undefined): EngineTurnNotice | null {
	if (report?.verdict !== "failed") return null;
	const code = typeof report.exitCode === "number" ? report.exitCode : null;
	return {
		label: code !== null ? `The engine exited with code ${code} on its last turn` : "The engine reported its last turn as failed",
		// Names the CLASS, because the expensive mistake here is reading a refusal as a bad
		// instruction and rewording it — which is exactly what the Pilot did three times in eight
		// seconds on the run that filed this.
		detail: "That is the engine refusing to run, not an answer to your instruction. Rewording the instruction will not change it.",
		evidence: report.detail?.trim() ? report.detail.trim() : null,
	};
}
