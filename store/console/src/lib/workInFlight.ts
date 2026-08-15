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

/**
 * The platform's verdict on a run, sent by the server (`GET /loop`, `routes/tools.ts` `withHealth`).
 *
 * Mirrored rather than imported: the console does not depend on the Worker's source tree. The
 * fallback below is what keeps that honest — an unrecognised value is treated as "no verdict",
 * never as one of these.
 */
export type RunHealth = "working" | "waiting" | "stalled" | "ended";

/** The fields of a loop run this page cares about (`LoopRunView` has more). */
export interface LoopRunLike {
	runId: string;
	status: string;
	/** The SERVER's verdict. Read this for liveness — never derive one from `status` (#589). */
	health?: RunHealth;
	/** What a parked run is waiting for, in the server's words. Present only when parked. */
	waitNote?: string | null;
	iteration?: number;
	maxIterations?: number;
	objective?: string;
	startedAt?: number;
	/** A stop the server accepted but the run has not reached yet (#376, lib/loopStopState.ts). */
	cancelRequested?: boolean;
}

/**
 * Is the run still OPEN — i.e. has it not reached a terminal state?
 *
 * `status === "running"` is the right test for THIS question and the wrong one for "is it alive".
 * The two were the same sentence here until #589, and the comment that used to sit on this line
 * ("a run is live only while the server says `running`") stopped being true at `fd1c323`: since
 * migration 0127, `running` covers a run that is working, one deliberately parked, and one whose
 * Workflow died and will say `running` forever. Openness is what the watcher, the poll and the
 * Stop button need; liveness is {@link runActivity}, and it comes from the server.
 */
export function isOpen(run: Pick<LoopRunLike, "status"> | null | undefined): boolean {
	return run?.status === "running";
}

/**
 * What a run is ACTUALLY doing, as one word — the server's verdict, quoted rather than derived.
 *
 * The console was the third of the three surfaces #589 measured disagreeing about one run: it
 * rendered "step 1/40 · started 4h ago" with a live Stop button for a run the platform had already
 * classified as parked, at the same instant `check_instance_loop` reported `waiting`. Nothing was
 * wrong with the data — the page simply never read the field.
 *
 * `null` means the server sent no verdict (an older response, a cached payload). The caller must
 * render nothing rather than guessing, which is why this returns null instead of a default: a
 * plausible default is precisely how this page came to state a liveness it had never been told.
 */
export function runActivity(run: Pick<LoopRunLike, "status" | "health"> | null | undefined): RunHealth | null {
	if (!run) return null;
	const h = run.health;
	return h === "working" || h === "waiting" || h === "stalled" || h === "ended" ? h : null;
}

/** How the row says it, in the owner's words. Null for a run carrying no verdict, or a plain one. */
export function activityLabel(run: Pick<LoopRunLike, "status" | "health" | "waitNote"> | null | undefined): string | null {
	switch (runActivity(run)) {
		case "waiting":
			// The server's own sentence when it sent one: it names WHAT the run is waiting for,
			// which is the part that turns a four-hour pause from alarming into expected. A resume
			// time rides along only when one is knowable — `coding-pause.ts:146` writes none for a
			// HUMAN handoff, because that park's deadline is when the run gives up rather than when
			// it resumes (#591/#596). So the FALLBACK must not promise one either: "expected to
			// resume on its own" would be a fabricated all-clear over a run waiting for this owner.
			return run?.waitNote ? `Waiting — ${run.waitNote}` : "Waiting — deliberately parked, not stalled";
		case "stalled":
			return "Stalled — nothing has ticked for a while; this run may have died";
		default:
			// `working` gets no label: the row already says "step N/M · started X ago", and adding
			// "Working" to a healthy run is noise. `ended` is covered by the status/stopReason
			// the row already renders, and `null` has nothing to say.
			return null;
	}
}

/**
 * The run a returning (or newly opened) tab should adopt: the newest one still OPEN.
 *
 * Openness, not liveness (#589): a parked or stalled run is exactly the one a returning tab wants
 * to watch — it is still the run in flight, and the watcher is how the owner finds out what state
 * it is in. Newest by `startedAt` so that when an old run is somehow stuck `running`, the watcher
 * follows the work the user just started rather than the stale one.
 */
export function adoptableRun<T extends LoopRunLike>(runs: T[] | null | undefined): T | null {
	if (!Array.isArray(runs)) return null;
	let best: T | null = null;
	for (const run of runs) {
		if (!isOpen(run)) continue;
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
