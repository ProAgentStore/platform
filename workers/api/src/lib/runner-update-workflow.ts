/** Durable, owner-scoped executor for runner_update (#1008). */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { executeRunnerUpdateOperation, type RunnerUpdateWorkflowParams } from "./runner-update.js";
import type { Env } from "../types.js";

/** Kept separate from the HTTP route so request termination cannot own machine execution. */
export async function runRunnerUpdateWorkflow(
	env: Env,
	event: WorkflowEvent<RunnerUpdateWorkflowParams>,
	step: Pick<WorkflowStep, "do">,
) {
	return step.do("dispatch-runner-update", async () => executeRunnerUpdateOperation(env, event.payload));
}

export class RunnerUpdateWorkflow extends WorkflowEntrypoint<Env, RunnerUpdateWorkflowParams> {
	override async run(event: WorkflowEvent<RunnerUpdateWorkflowParams>, step: WorkflowStep) {
		return runRunnerUpdateWorkflow(this.env, event, step);
	}
}
