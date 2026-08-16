// Who owns a board card's LIVE state — the one question the runner-reconnect sweep has to answer
// before it may fail a task (#567).
//
// ## Why this is an allowlist
//
// `expireOrphanedRuntimeTasks` used to name the types it must NOT touch, and that list drifted
// three times: `browser.task` was in neither of its two copies of the predicate (fixed in place),
// `browser.handoff` is in the runner's equivalent list and was never added to the API's at all, and
// #553 put `needs_human` coding cards inside the same `SELECT`. Each drift failed DESTRUCTIVELY: a
// card type nobody had thought about was silently marked `failed` and stamped with a `completedAt`
// it never reached.
//
// In production this expired a coding session that then ran for two more hours and made 15
// irreversible pushes to `origin main`, and a standing-policy card whose policy deliberately has no
// actuator — both told "its browser session is gone. Re-run it to try again."
//
// Inverted, the failure mode inverts with it: a card type nobody has classified is NOT swept, so
// the worst a future drift can do is leave a stale card on the board. That is a visibility bug. The
// old direction's worst case was killing live work.
//
// ## Why the sweepable set is exactly two types
//
// The cloud sweep exists to MIRROR a decision the runner already makes locally: on restart,
// `RunnerStore.expireInFlightTasks` (`packages/browser-runner/src/store.ts:58`) fails its own
// in-flight tasks except the ones in `WORKFLOW_DRIVEN_TASKS`. The runner executes exactly two task
// types itself — `Runner.execute()` dispatches `echo` and `browser.open` and throws
// `Unknown task type` for everything else (`packages/browser-runner/src/runner.ts:544-590`) — so
// those two are the whole set whose live state (a Playwright page, an open takeover) dies with the
// process.
//
// `runtime-task-ownership.test.ts` derives both halves from the runner's own source and fails if
// this file disagrees with it, so the two sweeps cannot drift apart again.

/**
 * Who holds the task's live state, and therefore who is allowed to end it.
 *
 * - `runner` — the runner PROCESS executes it, and expires it locally when it restarts. Its page /
 *   takeover cannot outlive the process, so the cloud mirror must expire it too or the board keeps
 *   a "Needs you" card for a browser session that no longer exists. **The only sweepable class.**
 * - `runner-durable` — it is in the runner's task list, but the runner deliberately PRESERVES it
 *   across a restart (`WORKFLOW_DRIVEN_TASKS`) because a durable remote Workflow is steering it.
 *   Sweeping the cloud half of a task the runner keeps makes the two views of one task disagree —
 *   and the next `/tasks` poll re-mirrors the runner's copy over the write anyway.
 * - `cloud` — never a runner task at all. Written by the API, a DO or a Workflow: a coding session
 *   card, a delegation, a pipeline run, a standing-policy observation. No runner ever held its
 *   state, so a runner reconnect says nothing about it.
 */
export type RuntimeTaskOwner = "runner" | "runner-durable" | "cloud";

/**
 * Every board card type this codebase writes, and who owns it.
 *
 * The test scans `workers/api/src` for card-shaped writes and fails if it finds a type that is not
 * here — so this stays a census rather than a memory. Adding a type here is documentation; it is
 * NOT what makes a card safe. Only `runner` is swept, so an unclassified type is already safe.
 */
export const RUNTIME_TASK_OWNERS: Readonly<Record<string, RuntimeTaskOwner>> = {
	// --- runner-executed: `Runner.execute()` dispatches these, and only these ---
	echo: "runner",
	"browser.open": "runner",

	// --- runner task list, preserved across a runner restart by WORKFLOW_DRIVEN_TASKS ---
	"job.apply_agent": "runner-durable", // JobApplyWorkflow
	"browser.task": "runner-durable", // BrowserTaskWorkflow
	"browser.handoff": "runner-durable", // synthetic takeover task the runner mints for a caller with none
	// The cloud-side card for an engine sign-in takeover. It SHADOWS a `browser.handoff`: routes/
	// coding.ts writes this card and then hands the SAME task id to the runner's /browser/handoff,
	// which mints `browser.handoff` under that id. So the runner keeps the handoff alive across a
	// restart and re-mirrors it — expiring the cloud copy would be undone on the next poll.
	"engine.signin": "runner-durable",

	// --- cloud-written board cards: no runner process ever held their state ---
	"coding.session": "cloud", // lib/coding-board.ts — the CLI child process + CodingSessionWorkflow
	delegation: "cloud", // lib/delegation.ts — a durable loop run
	escalation: "cloud", // workflows/agent-loop.ts — parked for a human, by a durable workflow
	"pipeline.run": "cloud", // lib/pipeline-board.ts
	ticket: "cloud", // lib/tool-registry.ts create_ticket
	"coding.uncommitted": "cloud", // lib/repo-policies.ts — a standing-policy observation
	"coding.off_branch": "cloud", // lib/repo-policies.ts — ditto
	"coding.unauthorized_act": "cloud", // lib/coding-authority.ts
	"coding.out_of_scope_write": "cloud", // lib/repo-write-scope.ts — a write outside the registered repos
	"setup.pags_browser_runtime": "cloud", // synthetic "run pags up" advisory
	"setup.cloudflare_workers_ai": "cloud", // synthetic "add credentials" advisory
};

/**
 * The types a runner reconnect may expire. Sorted so the SQL filter it builds is stable.
 *
 * Derived from the table rather than written twice — the predicate is needed in two places (the
 * SQL `IN` list and the per-row guard) and those two ARE what drifted the first time.
 */
export const ORPHANABLE_TASK_TYPES: readonly string[] = Object.entries(RUNTIME_TASK_OWNERS)
	.filter(([, owner]) => owner === "runner")
	.map(([type]) => type)
	.sort();

/** Unknown types answer `cloud`: not swept. An unrecognised card is somebody else's, not ours. */
export function runtimeTaskOwner(type: string): RuntimeTaskOwner {
	return RUNTIME_TASK_OWNERS[type] ?? "cloud";
}

/** May a runner reconnect end this task? True only for work the dead process was itself running. */
export function isOrphanedByRunnerReconnect(type: string): boolean {
	return runtimeTaskOwner(type) === "runner";
}

/**
 * What to tell the owner, in terms of what actually died.
 *
 * One string used to cover three unrelated situations, and it named a browser session for tasks
 * that had none — the #513/#517/#530/#552 family, where a remedy is prescribed for a situation the
 * code never checked. Classify at the site that knows: `browser.open` is the only orphanable type
 * that holds a page, so it is the only one allowed to say so.
 */
export function orphanedTaskReason(type: string): string {
	return type === "browser.open"
		? "Runner reconnected — this paused task was orphaned (its browser session is gone). Re-run it to try again."
		: "Runner reconnected — this task was running on the previous runner process and cannot be resumed. Re-run it to try again.";
}
