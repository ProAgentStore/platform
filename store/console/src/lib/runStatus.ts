/**
 * Is a run over? The console's answer, written down once (#625, refs #611).
 *
 * ## What was wrong
 *
 * `RunDetail.tsx` carried a fourth hand-written status list:
 *
 *     const isFinished = task ? ["completed", "cancelled", "failed", "blocked", "expired"].includes(task.status) : false;
 *
 * Two members of it were wrong, in opposite ways.
 *
 * **`expired`** cannot occur. `task.status` is the mirrored `instance_runtime_tasks.status`,
 * which only ever holds a runner `TaskStatus` — a union with no such member. #611 established
 * that from a full production census (404 rows, seven distinct statuses, no `expired`) and
 * removed the same value from `CLEARED_RUNTIME_TASK_STATUSES`; this copy was out of its scope.
 * Both functions NAMED for expiry (`expireOrphanedRuntimeTasks`, the runner's
 * `expireInFlightTasks`) write `failed`.
 *
 * **`blocked`** can occur, and is not finished. It means the agent is waiting on the USER — the
 * card the board exists to surface. `CLEARED_RUNTIME_TASK_STATUSES` excludes it deliberately for
 * that reason, and this list included it, so the two disagreed about what "finished" means. The
 * disagreement had a cost: `isFinished` gates the delete confirmation
 * (`RunDetail.tsx`, `if (!isFinished && !confirm("… it will be stopped first."))`), so deleting a
 * live blocked run skipped the warning that it would be stopped — on precisely the run that IS
 * still doing something, and whose deletion is what stops it.
 *
 * ## The answer, and why the two lists are now equal
 *
 * `CLEARED_RUNTIME_TASK_STATUSES` is right and this was wrong, so the sets are identical:
 * `failed`, `completed`, `cancelled`. That is not a coincidence to be quietly relied upon —
 * `runStatus.test.ts` parses the api-side constant out of `routes/instances-runtime.ts` and
 * fails if they diverge, which is the arrangement `workers/mcp/src/state-vocabulary.test.ts`
 * uses across the same deployable seam. A MIRROR rather than an import, because the console
 * bundle must not pull Worker source in.
 *
 * If a future difference is genuinely wanted — a status that is "finished" for the purposes of
 * a delete prompt but not for a board sweep — it goes here, in prose, with the reason. A silent
 * divergence between two literals in two files is what this module exists to prevent.
 */

/**
 * The terminal statuses. A run in any of these has stopped on its own; anything else — `queued`,
 * `running`, `needs_human`, `blocked` — is still in flight and deleting it stops it.
 */
export const FINISHED_RUN_STATUSES = ["failed", "completed", "cancelled"] as const;

/** True when the run has already stopped, so deleting it interrupts nothing. */
export function isRunFinished(status: string | undefined | null): boolean {
	return !!status && (FINISHED_RUN_STATUSES as readonly string[]).includes(status);
}
