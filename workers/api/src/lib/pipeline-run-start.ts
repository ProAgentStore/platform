// The SINGLE kick path for a pipeline run (issue #97), shared by the LLM-callable
// `run_pipeline` tool and the POST /v1/instances/:id/pipelines/:name/run endpoint so both
// audit + start a run identically. Cron/webhook triggers (#92) call this same helper —
// that's the clean hook for trigger wiring, which is NOT built here.
import { loadPipeline } from "./pipeline.js";
import { logEvent } from "./events.js";
import { openRun } from "./pipeline-runs.js";
import type { PipelineRunParams } from "../workflows/pipeline-run.js";
import type { Env } from "../types.js";

export type StartTrigger = NonNullable<PipelineRunParams["trigger"]>;

export type StartResult = { ok: true; runId: string; workflowId: string } | { ok: false; error: string };

/**
 * Load the named pipeline from the instance's config, audit the start, and kick the durable
 * PipelineRunWorkflow. Owner-scoping is the caller's responsibility (the API route calls
 * requireOwnedInstance; the tool runs with the owner's own instanceId/userId). Returns an
 * error string when the pipeline isn't found so callers surface a clean message.
 */
export async function startPipelineRun(
	env: Env,
	instanceId: string,
	userId: string,
	name: string,
	params: Record<string, unknown>,
	trigger: StartTrigger,
): Promise<StartResult> {
	const pipeline = await loadPipeline(env, instanceId, userId, name);
	if (!pipeline) return { ok: false, error: `No pipeline named "${name}" is configured on this agent (or its definition is invalid).` };
	const runId = crypto.randomUUID();
	// Audit the start BEFORE the kick so a failed create still leaves a record of who asked.
	await logEvent(env, { source: "pipeline", event: "pipeline.requested", message: `Start "${name}" via ${trigger}`, userId, instanceId, traceId: runId, context: { pipeline: name, trigger, params } }).catch(() => undefined);
	// Open the run RECORD (issue #98) at kick, status 'running'. The workflow updates counts
	// + closes it. Opening here (not in the workflow) means a run that fails to start still
	// leaves a row, and the row exists before the first step runs.
	await openRun(env, { runId, userId, instanceId, pipeline: name, trigger, params });
	const wf = await env.PIPELINE_RUN.create({ params: { instanceId, userId, pipeline, params, runId, trigger } satisfies PipelineRunParams });
	return { ok: true, runId, workflowId: wf.id };
}
