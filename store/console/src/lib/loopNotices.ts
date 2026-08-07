/**
 * What the transcript says about an autonomous run — and, more importantly, when it says nothing.
 *
 * ── Why this is a decision, not a string
 *
 * A loop run (#158) is watched by the console but DRIVEN by the server, so three parties can
 * narrate the same run: the workflow (server-side, for the coding driver), the tab that pressed
 * Loop, and any other tab that adopted the run on mount (#252). Every one of them is polling the
 * same `/loop/:runId` and seeing the same terminal status at the same moment.
 *
 * Two rules keep that from producing a transcript full of duplicates, and both were reachable
 * only by driving a live 3s poll against a running workflow — which is to say, not reachable by
 * a test, which is to say they were defended by a comment:
 *
 *   1. The CODING driver posts its own outcome from the workflow (it must — the notice has to
 *      survive the tab closing). A client-side notice would be the second copy.
 *   2. An ADOPTED run is not this tab's to write down. The tab that started it persists the
 *      line; N tabs watching would otherwise write N rows into one thread.
 *
 * `persist:false` is not "don't show it" — the run still ENDED here and the reader must see
 * that. It is "show it locally, do not put it in the log".
 */

/** A line for the thread, and whether it belongs in the durable log. */
export interface LoopNotice {
	text: string;
	/** false ⇒ local to this tab only (an adopted run, #252). */
	persist: boolean;
}

export interface LoopStart {
	/** Which executor the server dispatched to (#210) — `null`/absent when it did not say. */
	driver?: string | null;
	objective: string;
	maxIterations: number;
}

/**
 * The "it started" line.
 *
 * It names WHERE the work will happen because the Loop dispatches on the agent's declared
 * workflow: on a coding agent it drives the ENGINE, so nothing at all appears in this thread
 * while it works. Without that sentence the run was silent until a one-line result, which reads
 * as "the button did nothing" right up until it reads as "where did this commit come from".
 */
export function loopStartNotice({ driver, objective, maxIterations }: LoopStart): string {
	const goal = objective.trim();
	const head = `**Loop started** — working on: ${goal}`;
	return driver === "coding"
		? `${head}\n\nIt drives the coding engine, so progress shows on the **Coding** tab, not here. Up to ${maxIterations} steps.`
		: `${head}\n\nUp to ${maxIterations} steps.`;
}

/** A failed START is always this tab's to report — no server ever saw the run. */
export function loopStartFailureNotice(err: unknown): string {
	return `Could not start the loop: ${err instanceof Error ? err.message : String(err)}`;
}

export interface LoopEnd {
	/** The run's terminal status, as the server reports it. */
	status: string;
	/** Why it stopped, when the server distinguishes it from the status. */
	stopReason?: string | null;
	detail?: string | null;
	/** Which executor ran it — `null` for an adopted run, whose driver we never learned. */
	driver?: string | null;
	/** Did THIS tab start the run, or merely find it already going (#252)? */
	adopted: boolean;
}

/**
 * The "it ended" line, or `null` when this tab must stay quiet.
 *
 * `null` is reserved for the coding driver, whose outcome the workflow already wrote — the
 * transcript refresh that runs alongside this poll has therefore already brought it in.
 */
export function loopCompletionNotice({ status, stopReason, detail, driver, adopted }: LoopEnd): LoopNotice | null {
	if (driver === "coding") return null;
	const label = stopReason === "done" ? "Loop complete" : `Loop stopped (${stopReason ?? status})`;
	return { text: `${label}: ${detail || ""}`.trim(), persist: !adopted };
}
