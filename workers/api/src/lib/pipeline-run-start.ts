// The SINGLE kick path for a pipeline run (issue #97), shared by the LLM-callable
// `run_pipeline` tool and the POST /v1/instances/:id/pipelines/:name/run endpoint so both
// audit + start a run identically. Cron/webhook triggers (#92) call this same helper —
// that's the clean hook for trigger wiring, which is NOT built here.
import { loadPipeline } from "./pipeline.js";
import { logEvent } from "./events.js";
import { openRun } from "./pipeline-runs.js";
import { capabilitiesForInstance } from "./agent-capabilities.js";
import { declaredToolsFor, pipelineDeclarationError } from "./pipeline-tool-policy.js";
import { pipelineOpensDelegations } from "./pipeline-budget.js";
import { openBudget } from "./delegation-budget-store.js";
import { getRegistryTool } from "./tool-registry.js";
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
	/** The run that CAUSED this one, when a connection delivered the event that started it.
	 *  Kept so a chain (lead → site → outreach) can be followed across agents; choreography
	 *  otherwise leaves N disconnected runs with nothing joining them. */
	parentTraceId?: string | null,
): Promise<StartResult> {
	const pipeline = await loadPipeline(env, instanceId, userId, name);
	if (!pipeline) return { ok: false, error: `No pipeline named "${name}" is configured on this agent (or its definition is invalid).` };
	// The agent's capabilities, resolved ONCE for the whole run (#381). Per step this would be a D1
	// query per step; per run it is one, and the answer cannot change halfway through a walk.
	const capabilities = await capabilitiesForInstance(env, instanceId, userId);
	const declaredTools = declaredToolsFor(capabilities);
	// Refused BEFORE the run opens, not eight steps in. `runRegistryTool` enforces the same rule on
	// every dispatch — that is the gate — but half-running a pipeline that cannot finish is worse
	// than not starting it: site-builder would have created a draft site and then stopped, leaving
	// work nobody asked to be half-done. Steps-only, so a tool `enrich` names in its inputs is
	// still caught downstream rather than here.
	const declarationError = pipelineDeclarationError(pipeline, capabilities, getRegistryTool);
	if (declarationError) return { ok: false, error: declarationError };
	// ONE pool for the whole run (#382), and only when the definition actually delegates — see
	// lib/pipeline-budget.ts for why the definition decides rather than every run paying for one.
	// Deliberately NOT closed when the run ends: `delegate_goal` returns a run HANDLE and the
	// subordinate keeps working afterwards, so closing here would refuse the very work it started.
	const budgetId = pipelineOpensDelegations(pipeline) ? (await openBudget(env, userId, instanceId)).id : undefined;
	const runId = crypto.randomUUID();
	// Audit the start BEFORE the kick so a failed create still leaves a record of who asked.
	await logEvent(env, { source: "pipeline", event: "pipeline.requested", message: `Start "${name}" via ${trigger}`, userId, instanceId, traceId: runId, context: { pipeline: name, trigger, params, ...(parentTraceId ? { parentTraceId } : {}) } }).catch(() => undefined);
	// The join between the two runs, logged under the PARENT's trace so following the chain
	// forward is one query: the parent's trace names the run it set off.
	if (parentTraceId) {
		await logEvent(env, { source: "connection", event: "chain.link", message: `${trigger} → "${name}" (run ${runId})`, userId, instanceId, traceId: parentTraceId, context: { pipeline: name, childRunId: runId, instanceId } }).catch(() => undefined);
	}
	// Open the run RECORD (issue #98) at kick, status 'running'. The workflow updates counts
	// + closes it. Opening here (not in the workflow) means a run that fails to start still
	// leaves a row, and the row exists before the first step runs.
	await openRun(env, { runId, userId, instanceId, pipeline: name, trigger, params });
	const wf = await env.PIPELINE_RUN.create({ params: { instanceId, userId, pipeline, params, runId, trigger, budgetId, declaredTools } satisfies PipelineRunParams });
	return { ok: true, runId, workflowId: wf.id };
}
