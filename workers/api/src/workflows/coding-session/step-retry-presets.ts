/**
 * The retry and timeout options the coding Workflow gives its durable steps, and the one way it binds them (#1359).
 *
 * Moved out of `workflow-run.ts` unchanged. They are data, not behaviour: a step's name is what a replay matches on, and these
 * only say how long and how often the step is retried.
 */
import type { WorkflowStep } from "cloudflare:workers";
import type { CodingRunProbe } from "../../lib/coding-failure.js";
import type { RunStep } from "../../lib/runner-availability.js";

export const RETRY = { retries: { limit: 2, delay: "2 seconds" as const, backoff: "constant" as const }, timeout: "3 minutes" as const };
/** A decide may spend the whole per-decision recovery ceiling (max 10 min, #907) inside one step. */
export const DECIDE_RETRY = { ...RETRY, timeout: "12 minutes" as const };
/** waitIdle polls internally for minutes, so it needs a longer step budget than {@link RETRY}. */
export const IDLE_RETRY = { retries: { limit: 1, delay: "2 seconds" as const, backoff: "constant" as const }, timeout: "10 minutes" as const };
export const START_RETRY = { retries: { limit: 1, delay: "3 seconds" as const, backoff: "constant" as const }, timeout: "5 minutes" as const };

/**
 * `step.do` with its options pre-bound, as a plain callable the runner guard can drive.
 *
 * The cast is over Cloudflare's `Rpc.Serializable` constraint, which a generic wrapper cannot
 * carry through — the same reason every `step.do` result in the workflow already casts.
 */
type LooseDo = (name: string, opts: unknown, cb: () => Promise<unknown>) => Promise<unknown>;

export function stepRunners(step: WorkflowStep, probe: CodingRunProbe): { runWith: (opts: unknown) => RunStep; runRetry: RunStep; runIdle: RunStep } {
	const runWith = (opts: unknown): RunStep => (name, fn) => (step.do as unknown as LooseDo)(probe.at(name), opts, fn);
	return { runWith, runRetry: runWith(RETRY), runIdle: runWith(IDLE_RETRY) };
}
