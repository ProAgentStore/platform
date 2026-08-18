import type { RunnerTask, TaskStatus } from "./types.js";

/**
 * How a finished cloud-driven run lands on the local task — as a TOTAL table (#636).
 *
 * ── Why a table
 *
 * `browserComplete` derived it from a chain of string comparisons:
 *
 *     const success = outcome === "submitted" || outcome === "ready" || outcome === "expired";
 *     task.status = outcome === "blocked" ? "blocked" : success ? "completed" : "failed";
 *
 * `cancelled` matched nothing and fell off the end into `failed`, with `task.error =
 * "stopped by the user"`, a `task.failed` event, and — because the console offers Retry on
 * `failed` — a button inviting the owner to re-run the application they had just stopped.
 * The Cancelled column the board already has had never held a card, while `agent_loop_runs`
 * recorded the same run as `cancelled`: two surfaces disagreeing about one event.
 *
 * This is the SECOND surface deriving a fact the cloud already derives, and it is the one
 * that drifted. The cloud's is `BROWSER_RUN_STOP_REASONS` in `workers/api/src/lib/
 * browser-run.ts` — a `Record<ApplyOutcome, LoopStopReason>`, total by construction, so an
 * eleventh outcome cannot be added without the compiler naming every table that has not
 * decided about it. A fall-through has no such property: it stays quiet and picks `failed`.
 *
 * ── Why the union is re-declared rather than imported
 *
 * `@proagentstore/browser-runner` is a separate package, bundled into the published CLI. It
 * does not depend on `workers/api`, its `tsconfig` rootDir is `src/`, and nothing under
 * `workers/` exists in the published artifact — so the import is not available at any of
 * build, publish or runtime. The risk that re-declaring creates (the two drifting apart) is
 * measured instead: `apply-outcome.test.ts` reads the union out of `apply-loop.ts` and fails
 * when the two disagree, the same technique `browser-run.test.ts` uses one package over.
 */
export type ApplyOutcome =
	| "submitted"
	| "ready"
	| "expired"
	| "blocked"
	| "captcha"
	| "stuck"
	| "needs_input"
	| "failed"
	| "max_steps"
	| "cancelled";

export interface OutcomeDisposition {
	/** The status written on the task — what column the board card lands in. */
	status: TaskStatus;
	/** The event appended to the task's activity, which the cloud mirrors verbatim. */
	event: "task.completed" | "task.failed" | "task.cancelled";
	/** Whether `task.error` carries the detail. An error is a FAULT the owner should read;
	 *  "stopped by the user" is a fact about what they chose, and is not one. */
	error: boolean;
}

/**
 * Every outcome `/browser/complete` can be called with, and what it means locally.
 *
 * Only `cancelled` changed in #636. The rest are the behaviour that was already there, written
 * down: `blocked` stays its own status because the agent stopped and needs the USER (email
 * verification, something it cannot answer truthfully) — needs-attention, not a failure, and
 * the console shows it as an active ticket rather than burying it.
 *
 * `captcha`/`stuck`/`needs_input` reach here only through the workflow's handoff TIMEOUT,
 * which calls this endpoint with `failed` and a "… not resolved in time" detail — so their
 * rows are a backstop for a direct call. They are `failed` because `TaskStatus` has no
 * `escalated`, which is what the cloud's run record calls them; the honest local equivalent
 * would be `needs_human`, but a task in that state is not finished, and every call to this
 * method IS the finish. Left as-is deliberately rather than changed under an unrelated fix.
 */
export const APPLY_OUTCOME_DISPOSITION: Record<ApplyOutcome, OutcomeDisposition> = {
	submitted: { status: "completed", event: "task.completed", error: false },
	ready: { status: "completed", event: "task.completed", error: false },
	expired: { status: "completed", event: "task.completed", error: false },
	blocked: { status: "blocked", event: "task.failed", error: true },
	captcha: { status: "failed", event: "task.failed", error: true },
	stuck: { status: "failed", event: "task.failed", error: true },
	needs_input: { status: "failed", event: "task.failed", error: true },
	failed: { status: "failed", event: "task.failed", error: true },
	max_steps: { status: "failed", event: "task.failed", error: true },
	cancelled: { status: "cancelled", event: "task.cancelled", error: false },
};

/**
 * The disposition for an outcome off the wire.
 *
 * `outcome` is a string from an HTTP body: a newer cloud can send one this bundled runner has
 * never heard of, since the runner ships inside a CLI the user upgrades on their own schedule.
 * An unknown outcome falls back to `failed` — the same `?? "failed"` the cloud's
 * `browserRunStopReason` uses — because "something ended and I cannot say it went well" is the
 * only honest reading of a word this build does not know.
 */
export function dispositionForOutcome(outcome: string): OutcomeDisposition {
	return APPLY_OUTCOME_DISPOSITION[outcome as ApplyOutcome] ?? APPLY_OUTCOME_DISPOSITION.failed;
}

/**
 * Write a finished run's outcome onto the task, and name the event to append.
 *
 * Pure apart from the mutation of the task it is handed, so the whole disposition — status,
 * error-or-not, which event — is decided in one tested place instead of inside a method that
 * also detaches CDP sessions and closes pages.
 */
export function settleTaskOutcome(task: RunnerTask, outcome: string, detail?: string): OutcomeDisposition {
	const disposition = dispositionForOutcome(outcome);
	task.status = disposition.status;
	task.output = { outcome, detail };
	if (disposition.error) task.error = detail || outcome;
	task.updatedAt = new Date().toISOString();
	task.completedAt = task.updatedAt;
	return disposition;
}

/**
 * The statuses a task cannot be moved out of — what `cancelTask` refuses to overwrite.
 *
 * `blocked` is deliberately NOT here: a blocked task is waiting on the owner, and Stop is the
 * owner answering. `cancelled` IS here, and was the member the old `completed || failed` pair
 * missed (#636) — a second Stop rewrote the timestamps and appended a duplicate
 * `task.cancelled`. `completed` and `failed` stay untouchable in the other direction: a run
 * that genuinely finished must not be relabelled as cancelled, because it was not.
 */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["completed", "failed", "cancelled"];

/** Has this task already finished, whichever way it finished? */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
	return TERMINAL_TASK_STATUSES.includes(status);
}
