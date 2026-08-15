// How a RUNNER-DRIVEN browser run is recorded as a loop run, so it can be stopped (#560).
//
// `JOB_APPLY` and `BROWSER_TASK` are the two drivers that hand the work to a browser on the
// owner's own machine. Until this module they were the two drivers with no `agent_loop_runs` row,
// and that single absence is the whole of #560:
//
//   * `stop_work` resolves a run through `agent_loop_runs` (`lib/work-stop.ts` → `requestCancel`),
//     so the tool that exists to stop autonomous work reached neither of them. The agent was asked
//     to stop an application and had nothing that could.
//   * the ONLY cancel path was the runtime task — `POST /:instanceId/tasks/:taskId/cancel` →
//     `requireLiveRuntime` → the runner marks the task cancelled → the next `/browser/snapshot`
//     reports `cancelled:true`. That is runner-mediated: with the machine off, or the relay down,
//     a run spending the owner's BYOK credit could not be stopped AT ALL.
//   * and #516 had just given apply a spend pool, so the owner could watch the money go and still
//     had no way to end the run — a pool with no cancel path is half a fix.
//
// The remedy is not a second cancellation mechanism. It is the row every other driver already has:
// `cancel_requested` is a D1 column the workflow reads for itself, so a stop works with the runner
// unreachable, and `stop_work`/`check_work`/the sweeper all reach these runs for free rather than
// each learning about a second population.
//
// ── Why the ROUND is the iteration, and the step is not
//
// `runApplyLoop`'s own counter restarts at zero on every handoff round (`apply-loop.ts:156` —
// `for (let step = 0; step < maxSteps; step++)`), so writing it to `last_progress_at` would produce
// a progress counter that goes BACKWARDS every time a human answered a captcha. `recordIteration`
// only advances progress when the counter advances, so the effect would not even be visible as a
// wrong number — it would silently freeze, which is the shape #580 spent a commit removing.
//
// The outer round loop IS monotone and IS capped, so it is what the row records. One round is one
// uninterrupted drive of the browser between handoffs, which is also the honest unit: "instruction
// 2 of up to 12" means the second attempt after a human unblocked it.
//
// Liveness is separate, and that separation is 0127's whole point (#580): a run parked on a captcha
// for fifteen minutes is ticking and NOT advancing, and those are two different facts. The snapshot
// heartbeat writes `last_alive_at`; the handoff wait writes it with a `human` park so the run
// reports as WAITING rather than as working or as stalled.
import type { ApplyOutcome, ApplyResult } from "./apply-loop.js";
import type { LoopStopReason } from "./agent-loop.js";
import { finishLoopRun, isCancelRequested, recordIteration, recordLiveness } from "./agent-loop-store.js";
import type { Env } from "../types.js";

/**
 * The outer handoff-round cap both browser drivers loop to.
 *
 * It was the bare literal `12` in `workflows/job-apply.ts` and `workflows/browser-task.ts`, which
 * is fine until it becomes a run row's `max_iterations` — then two files and a record have to agree
 * about the same number, and nothing makes them.
 */
export const BROWSER_RUN_ROUNDS = 12;

/** One handoff poll — 5s, matching `CAPTCHA_WAIT_POLLS`/`HANDOFF_WAIT_POLLS` in both workflows. */
export const HANDOFF_POLL_MS = 5_000;

/**
 * Every terminal browser outcome, mapped to the reason a run record carries.
 *
 * TOTAL over `ApplyOutcome`, and deliberately a table rather than a ternary chain: `statusFor`
 * turns the reason into the board column, so an outcome added later with no entry here would be
 * recorded under whatever the fallback happened to be — which is exactly how #553's cards came to
 * say `completed` for runs that had died. `Record<ApplyOutcome, …>` makes that a type error, and
 * `browser-run.test.ts` walks the declared outcome union so the guard cannot be satisfied by a
 * hand-written list that has drifted.
 *
 * The three groupings worth defending:
 *
 *   `ready` → `done`. A dry run that walked the whole form and stopped at the submit button did
 *   exactly what it was asked. Recording it as a failure would tell the owner a rehearsal broke.
 *
 *   `captcha`/`stuck`/`needs_input` → `escalated`. These are only terminal when the human never
 *   answered, and `statusFor` puts `escalated` in "Needs you" — the column that was empty for three
 *   dead runs in #553. Never `failed`: nothing failed, somebody was asked and did not reply.
 *
 *   `max_steps` → `max_iterations`. The one runaway-shaped record in the whole error log
 *   ("browser task max_steps: stopped after 60 actions") is this, and it is a CAP doing its job,
 *   not a fault.
 */
export const BROWSER_RUN_STOP_REASONS: Record<ApplyOutcome, LoopStopReason> = {
	submitted: "done",
	ready: "done",
	expired: "failed",
	blocked: "failed",
	captcha: "escalated",
	stuck: "escalated",
	needs_input: "escalated",
	failed: "failed",
	max_steps: "max_iterations",
	cancelled: "cancelled",
};

/** The reason a browser run's record carries, from the outcome its loop returned. */
export function browserRunStopReason(outcome: ApplyOutcome): LoopStopReason {
	return BROWSER_RUN_STOP_REASONS[outcome] ?? "failed";
}

/**
 * When a handoff wait RUNS OUT — the instant to publish as `waiting_until`.
 *
 * Computed from the polls REMAINING rather than from a fixed offset, for the reason #596 gives: a
 * Workflow replays, so an instant derived from "now + the whole wait" would move forward every time
 * the journal was re-executed and the run would appear to postpone its own deadline. Polls
 * remaining is a function of where the loop actually is, so it names the same absolute moment on
 * every tick.
 *
 * This is a GIVE-UP time, not a resume time — `waiting_reason: "human"`, which is what makes
 * `work-report.ts`'s `waitClause` render "it gives up in 12m if nobody does" instead of promising a
 * resume that a human handoff never has.
 */
export function handoffGiveUpAt(now: number, pollsRemaining: number, pollMs = HANDOFF_POLL_MS): number {
	return now + Math.max(0, pollsRemaining) * pollMs;
}

/**
 * What the run record calls this work, in the owner's words.
 *
 * `check_work` and `stop_work` both quote the objective back — "Asked run <id> to stop (objective:
 * …)" — so an empty or id-shaped objective is read by the model as a run it cannot describe. An
 * apply has no objective of its own (the human picked a URL), so the host is the subject.
 */
export function browserRunObjective(kind: "apply" | "browse", input: { url: string; objective?: string }): string {
	if (kind === "browse") {
		const stated = (input.objective ?? "").trim();
		if (stated) return stated.slice(0, 500);
		return `Browser task on ${hostOf(input.url)}`;
	}
	return `Apply for the job at ${hostOf(input.url)}`;
}

function hostOf(url: string): string {
	try {
		return new URL(url).host || url.slice(0, 120);
	} catch {
		return url.slice(0, 120);
	}
}

// ── The three touches both browser drivers make on their run row ─────────────────────────────
//
// Thin on purpose. They live here rather than in each workflow so the two drivers cannot drift
// apart the way they already had — `browser-task.ts` was a copy of `job-apply.ts`'s handoff block
// with the cancellation left out of both, and a fix applied to one of them is how #560 became the
// third instance of its own class.
//
// Every one of them SWALLOWS its D1 error and every one of them fails CLOSED — a heartbeat that
// cannot be written must not be read as "the user pressed stop", because that would let a database
// blip cancel an application mid-submit. The run row's absence costs observability; treating its
// absence as a cancel would cost the work.

/**
 * One step of the loop: the orchestrator is alive, and has the owner asked it to stop?
 *
 * Called from inside the driver's journaled `snapshot` step, which is the loop's only guaranteed
 * per-step touch point and already the place a cancel is observed — `apply-loop.ts:158` returns
 * `outcome: "cancelled"` on `snap.cancelled`, so this reuses a path that is already tested rather
 * than adding a second way for a browser run to stop.
 *
 * The RUNNER's own `cancelled` flag stays authoritative alongside this one. That path (the console
 * Cancel button → `POST /tasks/:id/cancel` → the runner) still works and is faster; this one is
 * what works when the machine is unreachable, which is when it matters.
 */
export async function browserRunTick(env: Env, runId: string | null): Promise<boolean> {
	if (!runId) return false;
	await recordLiveness(env, runId, Date.now()).catch(() => undefined);
	return isCancelRequested(env, runId).catch(() => false);
}

/**
 * The run advanced to a new handoff round — and is no longer parked.
 *
 * `recordIteration` clears `waiting_until`/`waiting_reason` on the same condition it moves
 * progress, so resuming after a human answers un-parks the run without a second write.
 */
export async function browserRunAdvance(env: Env, runId: string | null, round: number): Promise<void> {
	if (!runId) return;
	await recordIteration(env, runId, round).catch(() => undefined);
}

/**
 * Waiting on a human, with a give-up time — and has the owner stopped it meanwhile?
 *
 * The gap this closes is the one `cc17c1d` recorded and left: during a handoff the driver polls
 * `/browser/handoff-status`, which has no cancellation awareness, so a cancel arriving in that
 * window was not seen for up to FIFTEEN MINUTES. That window is also exactly when a wedged run is
 * most likely to be stopped — an unanswered captcha or `needs_input` is the failure #560 names.
 *
 * The park is what stops the same fix producing a #459: a run deliberately holding for a human
 * ticks without advancing, and liveness alone would report that as "working". `human` makes
 * `work-report.ts` say it is WAITING and name the deadline as a give-up rather than a resume.
 */
export async function browserRunPark(env: Env, runId: string | null, until: number): Promise<boolean> {
	if (!runId) return false;
	await recordLiveness(env, runId, Date.now(), { reason: "human", until }).catch(() => undefined);
	return isCancelRequested(env, runId).catch(() => false);
}

/**
 * Close the run out, so the record says what happened.
 *
 * Without this every application would leave a `running` row until `sweepStaleRuns` closed it three
 * hours later as dead — which would make `check_work` report a submitted application as a run still
 * in progress, and would put a fresh false claim into the exact surface #459 is about.
 */
export async function finishBrowserRun(env: Env, runId: string | null, result: ApplyResult): Promise<void> {
	if (!runId) return;
	const reason = browserRunStopReason(result.outcome);
	await finishLoopRun(env, runId, reason, result.detail ?? result.outcome, Date.now()).catch(() => undefined);
}
