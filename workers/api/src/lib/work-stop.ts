// How an agent STOPS work it started (#540) — the third verb of `start_work` / `check_work`.
//
// The gap this closes was reported by the owner twice in one day, four hours apart, and both rows
// were filed by the agent itself through `record_feedback`: he said "finish the session, stop here"
// five times and was answered with *"that's controlled by the app on your device"*. No app on his
// device owns this. It is a fabrication with a true core — the agent had no tool that stops
// anything, so it had no true remedy to offer and produced a plausible one instead.
//
// The capability was already there: `requestCancel` (agent-loop-store.ts), the `cancel_requested`
// column, `POST /v1/instances/:id/loop/:runId/cancel`, and MCP's `stop_instance_loop`. Only the
// agent's own catalog was missing an entry. So this module is deliberately small: it holds the two
// things that are DECISIONS rather than plumbing — which runs a bare "stop" applies to, and what
// the agent is entitled to say afterwards — as pure functions with their own tests.
//
// ── The one thing that must not drift: requested ≠ stopped
//
// Cancelling is COOPERATIVE. The flag is read at the top of the next iteration, so the step in
// flight finishes and settles its spend; killing mid-step would strand a budget reservation and a
// repo lock (`agent-loop-store.ts:177-183`, and the leak class #291's lineage produced once). That
// makes "I stopped it" false at the moment the tool returns, every single time — the run is still
// working. This codebase has fixed the report-a-success-you-did-not-observe class repeatedly, and a
// stop tool that says "stopped" would reintroduce it in the one place where the user is watching to
// see whether it worked. Every sentence below says ASKED.
import type { LoopRunView } from "./agent-loop-store.js";

/** What a stop attempt did to one run. Four distinct facts, four distinct sentences. */
export type StopResultKind =
	/** The cancel flag is now set on a run that was running. The step in flight is still going. */
	| "requested"
	/** It was already set — an earlier stop is still working through the current step. */
	| "already-requested"
	/** The run had already finished before the stop reached it. Nothing was stopped. */
	| "already-finished"
	/** It was running when read and not running when written: it ended in between. */
	| "vanished";

export interface StopOutcome {
	kind: StopResultKind;
	runId: string;
	objective: string;
	/** The run's status as last read — quoted for `already-finished` so the agent reports the real end. */
	status: string;
	stopReason: string | null;
	/** True when this run is on a subordinate and THIS instance delegated it (#318 scoping). */
	delegated: boolean;
	/** The instance the run is on. Named for a delegated run, so the supervisor can cite both. */
	instanceId: string;
}

/** The runs a bare `stop_work` (no runId) applies to: everything of this agent's that is running. */
export function stoppableRuns(runs: readonly LoopRunView[]): LoopRunView[] {
	return runs.filter((r) => r.status === "running");
}

/**
 * Classify one run BEFORE the write, from the row that was read.
 *
 * Split out from the write so the interesting half is pure: "already finished" and "already asked"
 * are answers this function can give without touching D1, and they are the two the agent is most
 * likely to get wrong on its own — a model that sees a cancel succeed on a run that ended ten
 * minutes ago will happily claim credit for stopping it.
 */
export function classifyBeforeStop(run: LoopRunView): "already-finished" | "already-requested" | "stoppable" {
	if (run.status !== "running") return "already-finished";
	return run.cancelRequested ? "already-requested" : "stoppable";
}

function where(o: StopOutcome): string {
	return o.delegated ? ` — it runs on instance ${o.instanceId}, which you delegated it to` : "";
}

/** One outcome, in the words the agent should use about it. */
export function describeStopOutcome(o: StopOutcome): string {
	switch (o.kind) {
		case "requested":
			return `Asked run ${o.runId} to stop (objective: ${o.objective})${where(o)}.`;
		case "already-requested":
			return `Run ${o.runId} (objective: ${o.objective}) had already been asked to stop${where(o)}; it is still finishing the step it is on.`;
		case "already-finished":
			return (
				`Run ${o.runId} (objective: ${o.objective}) had already ended before this — status ${o.status}` +
				`${o.stopReason ? `, stopped because: ${o.stopReason}` : ""}. Nothing was stopped. Report that it finished, not that you stopped it.`
			);
		case "vanished":
			return `Run ${o.runId} (objective: ${o.objective}) finished on its own between reading it and stopping it. Nothing was stopped.`;
	}
}

/**
 * The closing paragraph — the part that keeps the report honest.
 *
 * Only rendered when something was actually asked to stop. On a call where every run had already
 * ended, "it may keep working for another minute" would be an invented ongoing action.
 */
const COOPERATIVE_NOTE =
	"This is a REQUEST, not a completed stop: the step in flight finishes and settles its spend before the run ends," +
	" so it can keep working for another minute or more. Tell the user you have ASKED it to stop — do not say it has" +
	" stopped, and do not describe what it did or did not finish. Call check_work to see when it actually ends.";

/** The whole `stop_work` result for one or more runs. */
export function describeStopResult(outcomes: readonly StopOutcome[]): string {
	const lines = outcomes.map((o) => `- ${describeStopOutcome(o)}`).join("\n");
	const asked = outcomes.some((o) => o.kind === "requested" || o.kind === "already-requested");
	return asked ? `${lines}\n\n${COOPERATIVE_NOTE}` : lines;
}

/**
 * Nothing was running.
 *
 * A real answer, not an error — the same reasoning `describeWorkCheck`'s empty case gives: an error
 * reads as "could not tell", and "could not tell" is the state that produces a guess. This is the
 * sentence that replaces *"that's controlled by the app on your device"*.
 *
 * `canEndSession` is passed rather than assumed, because the pointer is only true for an agent that
 * HAS the session tool. On a coding agent, "nothing is running" and "there is still a session open"
 * are both true at once and the owner's "finish the session" usually means the second — so naming
 * the other tool is the difference between a complete answer and a technically-correct one. On an
 * agent without a coding surface the same sentence would send it looking for a tool it does not
 * have, which is where fabrications come from.
 */
export function describeNothingToStop(opts: { canEndSession?: boolean } = {}): string {
	return (
		"Nothing is running on this agent right now, so there was nothing to stop. Say that plainly — do NOT tell the" +
		" user you stopped anything." +
		(opts.canEndSession
			? " A coding session can still be OPEN with no run in progress; if that is what they meant by" +
				" \"finish the session\", end_coding_session is the tool for it."
			: "")
	);
}
