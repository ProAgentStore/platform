import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { decideAction, runApplyLoop, type ApplyDecision, type ApplyDeps, type ApplyJob, type ApplyResult, type PageSnapshot } from "../lib/apply-loop.js";
import { callRunner, getRunnerConn } from "../lib/runner-client.js";
import type { Env } from "../types.js";

export interface JobApplyParams {
	instanceId: string;
	userId: string;
	/** Runner task id this application is associated with (for the takeover handoff). */
	taskId?: string;
	job: ApplyJob;
}

/**
 * The remote brain: a durable Cloudflare Workflow that drives the user's local
 * browser runner through a whole job application — read the page, ask Claude
 * (the user's BYOK key) for one action, perform it, repeat — handing off to a
 * human only for a CAPTCHA. Each snapshot / decision / action is a durable step,
 * so the loop survives restarts and runs far past the 30s request limit.
 */
export class JobApplyWorkflow extends WorkflowEntrypoint<Env, JobApplyParams> {
	async run(event: WorkflowEvent<JobApplyParams>, step: WorkflowStep): Promise<ApplyResult> {
		const { instanceId, userId, job } = event.payload;
		const env = this.env;

		// Resolved fresh (not journaled) so the runner token never lands in state.
		const conn = await getRunnerConn(env, instanceId, userId);
		if (!conn) return { outcome: "failed", detail: "No browser runner connected. Start it with: pags up", steps: 0 };

		// Open the job page first.
		await step.do("open", () => callRunner<{ url: string }>(conn, "/browser/act", { action: "navigate", url: job.url }));

		// Wire the tested pure loop to real durable steps. The call order in
		// runApplyLoop is deterministic, so the counter yields stable step names
		// that replay from cache. (Casts bridge Workflows' Serializable<T> wrapper.)
		let n = 0;
		const deps: ApplyDeps = {
			snapshot: () => step.do(`s${n++}-snapshot`, () => callRunner<PageSnapshot>(conn, "/browser/snapshot")) as Promise<PageSnapshot>,
			decide: (p) => step.do(`s${n++}-decide`, () => decideAction(env, userId, p)) as Promise<ApplyDecision>,
			act: (a) => step.do(`s${n++}-act`, async () => { await callRunner(conn, "/browser/act", a); return { url: "", challenge: null as string | null }; }) as Promise<{ url: string; challenge: string | null }>,
		};

		return runApplyLoop(deps, job, { maxSteps: 40 });
	}
}
