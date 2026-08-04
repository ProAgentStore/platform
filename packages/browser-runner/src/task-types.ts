/**
 * Task types steered by a remote durable Workflow rather than executed by the runner.
 *
 * ONE list, in its own module because THREE places need it and they drifted: task creation had
 * `job.apply_agent || browser.task`, `resumeTakeover` had only `job.apply_agent` (so resolving a
 * stuck browse handoff destroyed the session), and `RunnerStore.expireInFlightTasks` still
 * hardcodes its own copy — which meant restarting `pags up` failed a live browse run locally while
 * the cloud side preserved it, leaving the two views of one durable run disagreeing.
 *
 * `browser.handoff` is the synthetic task `browserHandoff` creates for a caller that has none (the
 * engine sign-in relay mints its own id for a coding session with no runner task). It belongs here
 * for the same reason: the console's Resume button is agent-agnostic, so without it pressing
 * Resume would complete and END the takeover mid-sign-in — reintroducing the exact bug the browse
 * case was fixed for.
 */
export const WORKFLOW_DRIVEN_TASKS: ReadonlySet<string> = new Set([
	"job.apply_agent",
	"browser.task",
	"browser.handoff",
]);
