/** Durable, owner-scoped executor for runner_update (#1008). */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { clipMarked } from "./clip-marked.js";
import { logError } from "./error-log.js";
import { executeRunnerUpdateOperation, type RunnerUpdateWorkflowParams } from "./runner-update.js";
import type { Env } from "../types.js";

/**
 * Kept separate from the HTTP route so request termination cannot own machine execution.
 *
 * A failure that escapes the operation — its D1 claim or its record of the outcome throwing — fails
 * the step, which the engine retries; it used to be visible only in the Workflow's own run history.
 * It is recorded first (#1134) and rethrown, so the retry behaviour is unchanged.
 */
export async function runRunnerUpdateWorkflow(
	env: Env,
	event: WorkflowEvent<RunnerUpdateWorkflowParams>,
	step: Pick<WorkflowStep, "do">,
) {
	try {
		return await step.do("dispatch-runner-update", async () => executeRunnerUpdateOperation(env, event.payload));
	} catch (err) {
		const { opId, userId, node, kind } = event.payload;
		await logError(env, {
			source: "runner-update",
			message: `runner_update workflow failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
			userId,
			context: { opId, node, kind: kind ?? "update", stack: err instanceof Error ? clipMarked(String(err.stack || ""), 1800) : undefined },
		});
		throw err;
	}
}

export class RunnerUpdateWorkflow extends WorkflowEntrypoint<Env, RunnerUpdateWorkflowParams> {
	override async run(event: WorkflowEvent<RunnerUpdateWorkflowParams>, step: WorkflowStep) {
		return runRunnerUpdateWorkflow(this.env, event, step);
	}
}
