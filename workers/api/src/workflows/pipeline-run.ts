import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { executePipelineStep, stepBind, type PipelineDef, type StepResult } from "../lib/pipeline.js";
import { logError } from "../lib/error-log.js";
import { logEvent } from "../lib/events.js";
import { isTransientInfraError } from "../lib/transient-error.js";
import type { Env } from "../types.js";

export interface PipelineRunParams {
	instanceId: string;
	userId: string;
	/** The pipeline definition to run (resolved by the caller from instance config). */
	pipeline: PipelineDef;
	/** Run parameters (from chat args, the trigger payload, or the API body). */
	params?: Record<string, unknown>;
	/** Groups all trace events for this run. */
	runId: string;
	/** How the run was started, for the audit trail. */
	trigger?: "chat" | "api" | "trigger";
}

export interface PipelineRunResult {
	outcome: "completed" | "failed";
	steps: number;
	sunk?: number;
	detail?: string;
}

/**
 * The durable pipeline runner (issue #97). Walks a declarative pipeline's steps IN ORDER,
 * each in its own `step.do` so the run is durable + resumable past the 30s DO limit — the
 * same machinery as JobApplyWorkflow / CodingSessionWorkflow. Each step dispatches its
 * registry tool through runRegistryTool (inside executePipelineStep), so connector
 * auth/grant/consent (#86/#90) are enforced identically to a direct tool call. Outputs
 * thread between steps by `bind`; the final bound output feeds the optional `sink`.
 *
 * Resume-determinism caveat (mirrors job-apply): connector tokens are re-minted INSIDE each
 * step.do (runRegistryTool → connectorClient runs per step) and NEVER captured across steps,
 * so a resume after an isolate reset re-authenticates rather than replaying a stale token.
 * The step call order is deterministic (linear walk, stable `s{i}` names), so replay is
 * stable.
 */
export class PipelineRunWorkflow extends WorkflowEntrypoint<Env, PipelineRunParams> {
	async run(event: WorkflowEvent<PipelineRunParams>, step: WorkflowStep): Promise<PipelineRunResult> {
		const { instanceId, userId, pipeline, params = {}, runId, trigger = "api" } = event.payload;
		const env = this.env;
		try {
			await step.do("trace-start", async () => {
				await logEvent(env, { source: "pipeline", event: "pipeline.start", message: `Run "${pipeline.name}" (${trigger})`, userId, instanceId, traceId: runId, context: { pipeline: pipeline.name, steps: pipeline.steps.length, trigger } }).catch(() => undefined);
				return null;
			});

			// Bound outputs accumulate across steps; NOT captured across step.do closures as a
			// mutable token — the value written here is journaled by the Workflow and replayed
			// deterministically on resume. Connector auth is re-minted per step (see caveat).
			const outputs: Record<string, unknown> = {};
			let lastOutput: unknown = null;

			for (let i = 0; i < pipeline.steps.length; i++) {
				const s = pipeline.steps[i];
				const bind = stepBind(s, i);
				// Each step is a durable unit. On failure the runner records it and stops (a
				// clean seam: #96's step library can add per-step retry/continue policy here).
				// step.do requires a Serializable return; a step's `output` is arbitrary tool JSON
				// (typed `unknown`), which doesn't satisfy that constraint at compile time even
				// though it's plain JSON at runtime. Route the callback through `unknown` and cast
				// the journaled result back to StepResult — same escape hatch job-apply uses.
				const result = (await step.do(`s${i}-${s.tool}`, async () => (await executePipelineStep({ env, userId, instanceId }, s, i, outputs, params)) as unknown as Record<string, string>)) as unknown as StepResult;
				outputs[bind] = result.output;
				lastOutput = result.output;
				await step.do(`s${i}-trace`, async () => {
					await logEvent(env, { source: "pipeline", event: "pipeline.step", level: result.success ? "info" : "warn", message: `${s.tool} → ${bind}: ${result.content.slice(0, 160)}`, userId, instanceId, traceId: runId, context: { step: i, tool: s.tool, bind, success: result.success } }).catch(() => undefined);
					return null;
				});
				if (!result.success) {
					await step.do("trace-fail", async () => {
						await logEvent(env, { source: "pipeline", event: "pipeline.end", level: "warn", message: `Failed at step ${i} (${s.tool}): ${result.content.slice(0, 160)}`, userId, instanceId, traceId: runId, context: { failedStep: i, tool: s.tool } }).catch(() => undefined);
						return null;
					});
					return { outcome: "failed", steps: i + 1, detail: `step ${i} (${s.tool}) failed: ${result.content.slice(0, 200)}` };
				}
			}

			// Optional sink: upsert the final step's output into an instance collection (#91)
			// via the AgentDO's records route — the same DO-fetch pattern job-apply uses to
			// reach the instance. Each record is its own durable step so a large sink resumes
			// mid-write. Dedupe/upsert-by-key is #96's job; here we insert.
			let sunk = 0;
			if (pipeline.sink) {
				const records = Array.isArray(lastOutput) ? lastOutput : lastOutput != null ? [lastOutput] : [];
				const collection = pipeline.sink.collection;
				for (let r = 0; r < records.length; r++) {
					const rec = records[r];
					if (rec == null || typeof rec !== "object") continue;
					await step.do(`sink-${r}`, async () => {
						const stub = env.AGENT.get(env.AGENT.idFromName(instanceId));
						const res = await stub.fetch(new Request(`https://agent/collections/${encodeURIComponent(collection)}/records`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: rec }) }));
						if (!res.ok) throw new Error(`sink insert failed (${res.status}): ${(await res.text()).slice(0, 160)}`);
						return null;
					});
					sunk++;
				}
			}

			await step.do("trace-end", async () => {
				await logEvent(env, { source: "pipeline", event: "pipeline.end", message: `Completed "${pipeline.name}": ${pipeline.steps.length} step(s)${pipeline.sink ? `, ${sunk} → ${pipeline.sink.collection}` : ""}`, userId, instanceId, traceId: runId, context: { steps: pipeline.steps.length, sunk } }).catch(() => undefined);
				return null;
			});
			return { outcome: "completed", steps: pipeline.steps.length, sunk };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// A DO/isolate reset from a deploy is TRANSIENT — re-throw so the Workflow retries
			// + resumes from its last completed step (same as job-apply); don't manufacture a
			// crash on every deploy.
			if (isTransientInfraError(msg)) {
				await logEvent(env, { source: "pipeline", event: "pipeline.interrupted", message: `pipeline interrupted by a deploy, resuming: ${msg}`.slice(0, 200), userId, instanceId, traceId: runId }).catch(() => undefined);
				throw err;
			}
			await logError(env, { source: "pipeline-run", userId, status: 500, message: `pipeline "${pipeline.name}" crashed: ${msg}`, context: { instanceId, runId, pipeline: pipeline.name, stack: err instanceof Error ? String(err.stack || "").slice(0, 1500) : undefined } });
			return { outcome: "failed", steps: 0, detail: msg };
		}
	}
}
