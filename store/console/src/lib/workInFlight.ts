/**
 * "Is this agent working right now?" — answered from the SERVER, not from what this tab
 * happens to remember (#252).
 *
 * The console's "working on it" was local React state set on send and cleared when the reply
 * landed, and the loop watcher was gated on a run id that only exists in the tab that pressed
 * Loop. So navigating away and back — or opening a second tab — showed an idle console over an
 * agent that was still working, with no way to tell a finished run from a running one. Both
 * answers already exist server-side (`GET /loop` lists every run; the DO reports its in-flight
 * chat turns, #251); the page simply never asked.
 *
 * The decisions live here, pure, so the polling glue in InstanceDetail stays dumb.
 */

/** The fields of a loop run this page cares about (`LoopRunView` has more). */
export interface LoopRunLike {
	runId: string;
	status: string;
	iteration?: number;
	maxIterations?: number;
	objective?: string;
	startedAt?: number;
}

/** A run is live only while the server says `running`; every terminal state is a different word. */
export function isRunning(run: Pick<LoopRunLike, "status"> | null | undefined): boolean {
	return run?.status === "running";
}

/**
 * The run a returning (or newly opened) tab should adopt: the newest one still running.
 * Newest by `startedAt` so that when an old run is somehow stuck `running`, the watcher follows
 * the work the user just started rather than the stale one.
 */
export function adoptableRun<T extends LoopRunLike>(runs: T[] | null | undefined): T | null {
	if (!Array.isArray(runs)) return null;
	let best: T | null = null;
	for (const run of runs) {
		if (!isRunning(run)) continue;
		if (!best || (run.startedAt ?? 0) >= (best.startedAt ?? 0)) best = run;
	}
	return best;
}

/**
 * Should this tab take over watching `run`? Only when it is not already watching it — adopting
 * the same run twice would restart the watcher and re-announce a completion.
 */
export function shouldAdopt(watching: string | null | undefined, run: LoopRunLike | null): run is LoopRunLike {
	return !!run && run.runId !== watching;
}

/** Instance DO state as far as this question is concerned (see AgentDO `/state`). */
export interface InstanceStateLike {
	status?: string;
	/** In-flight chat turns the DO is actually running (#251) — [] once they finish. */
	inflight?: { turnId: string; startedAt: number }[];
}

/**
 * Is a plain chat turn in flight server-side?
 *
 * ONLY the in-flight markers answer this. `state.status` is a hint at best: `ensureStateDefaults`
 * resets a stale `thinking` → `idle` when the object reloads, so a warm DO reports the truth and
 * a cold one reports idle whatever happened — and a DO that died mid-turn would otherwise leave
 * `thinking` set forever, which is the opposite lie.
 */
export function isChatWorking(state: InstanceStateLike | null | undefined): boolean {
	return Array.isArray(state?.inflight) && state.inflight.length > 0;
}
