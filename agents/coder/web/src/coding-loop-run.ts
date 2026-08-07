// The Coding tab's Loop, once it stopped being the thing that RUNS the loop (#374).
//
// ── What it was ──
//
// `use-coding-loop.ts` self-scheduled with `setTimeout`: read `/capture`, ask `/loop-decide` for
// the next instruction, and relay it verbatim to `…/coding/sessions/:id/message` — the route
// documented "manual drive, no brain". It was not a manual drive. The decision came from BYOK
// Claude, cloud-side, up to fifty times, chaining issue after issue in issues-mode. An autonomous
// driver wearing the human-typing path's clothes, which put it on the far side of every guard the
// platform has for autonomous drivers: merge authority (#314) is resolved in the Pilot and screens
// only the Pilot's own instructions; the one-driver-per-engine claim (#208) guards `/run`,
// `drive_claude` and the coding driver but deliberately NOT `/message`, because a human
// interjecting must always get through; and the delegation budget (#184) is opened by `POST /loop`,
// which the browser Loop never called.
//
// ── What it is ──
//
// The button starts a server-driven run (`POST /loop` → `loopDriverFor` → the coding driver → the
// Pilot) and the hook WATCHES `/loop/:runId`, the same shape the Assistant tab has had since #158.
// The gates are not reimplemented here; the decision simply happens where they already run.
//
// What is LEFT to decide is what the Co-pilot thread says and, in issues-mode, whether an issue may
// be struck off — and both are now read off a run row rather than off a `/loop-decide` reply, so
// they live in a pure module instead of inside a hook where no test can reach them.

/** The bits of `GET /v1/instances/:id/loop/:runId` this tab reads. */
export interface LoopRunSnapshot {
	/** `running` while it goes; anything else is terminal. */
	status: string;
	/** Why it ended (`done`, `failed`, `max_iterations`, `cancelled`, …). Absent while running. */
	stopReason?: string | null;
	detail?: string | null;
	iteration?: number;
}

/** Has the run reached a terminal state? The one status the watcher must not treat as an ending. */
export function loopRunEnded(run: { status: string }): boolean {
	return run.status !== "running";
}

/**
 * The line the thread gets when a run ends.
 *
 * `stopReason` is preferred over `status` because it is the one that distinguishes the endings a
 * human cares about: `failed` and `max_iterations` both carry status `failed`, and reporting the
 * status would tell someone their objective was impossible when it merely ran out of steps.
 */
export function loopOutcomeNotice(run: LoopRunSnapshot): string {
	const reason = run.stopReason || run.status;
	const detail = (run.detail || "").trim();
	const head = reason === "done" ? "Loop complete" : `Loop stopped (${reason})`;
	return detail ? `${head}: ${detail}` : `${head}.`;
}

/**
 * Issues-mode: may this issue be struck off and the next one proposed?
 *
 * ONLY on a clean finish, which is the rule the browser loop had (`decision === "done"` advanced;
 * escalate/failed left the issue open so you could retry it). Worth keeping literally, because the
 * new vocabulary has more ways to not-finish than the old one did: `max_iterations`, `budget`,
 * `no_progress` and `cancelled` are all runs that touched the issue without resolving it, and
 * excluding it on any of them would quietly walk the backlog leaving half-done work behind.
 */
export function issueWasHandled(run: LoopRunSnapshot): boolean {
	return run.stopReason === "done";
}

export interface LoopStart {
	/** Which executor the server dispatched to (#210) — absent when it did not say. */
	driver?: string | null;
	objective: string;
	maxIterations: number;
}

/**
 * The "it started" line.
 *
 * It says the run is on the server, because that is the whole difference and it changes what the
 * user may do next: closing the tab used to kill the objective and now does not.
 *
 * It also names the driver when it is NOT the coding one. On this tab that would mean the agent
 * declares no `CODING_SESSION` workflow, so its Loop is looping its chat while the user watches a
 * terminal that will never move — a silence that reads exactly like a broken button.
 */
export function loopStartNotice({ driver, objective, maxIterations }: LoopStart): string {
	const goal = objective.trim();
	const short = goal.length > 120 ? `${goal.slice(0, 120)}…` : goal;
	return driver && driver !== "coding"
		? `Loop started: ${short}\n\nThis agent's Loop drives its chat rather than the engine, so the terminal will stay quiet. Up to ${maxIterations} steps.`
		: `Loop started: ${short}\n\nIt runs on the server — you can close this tab. Up to ${maxIterations} steps.`;
}

/** A failed START is always this tab's to report — no server ever saw the run. */
export function loopStartFailureNotice(err: unknown): string {
	return `Couldn't start the loop: ${err instanceof Error ? err.message : String(err)}`;
}
