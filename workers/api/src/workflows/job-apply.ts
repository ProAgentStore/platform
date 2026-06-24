import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { decideAction, runApplyLoop, type ApplyDecision, type ApplyDeps, type ApplyJob, type ApplyResult, type PageSnapshot } from "../lib/apply-loop.js";
import { callRunner, getRunnerConn, type RunnerConn } from "../lib/runner-client.js";
import type { Env } from "../types.js";

export interface JobApplyParams {
	instanceId: string;
	userId: string;
	/** The runner task id this application drives (created by the trigger route). */
	taskId: string;
	job: ApplyJob;
}

/** Max minutes to wait for a human to solve a CAPTCHA before giving up. */
const CAPTCHA_WAIT_POLLS = 180; // 180 × 5s = 15 min

/**
 * The remote brain: a durable Cloudflare Workflow that drives the user's local
 * browser runner through a whole job application — read the page, ask Claude
 * (the user's BYOK key) for one action, perform it, repeat. On a CAPTCHA it
 * hands off to the human REMOTELY (same live session via the console takeover),
 * polls until solved, then resumes. Each step is durable, so the loop survives
 * restarts and runs far past the 30s request limit.
 */
export class JobApplyWorkflow extends WorkflowEntrypoint<Env, JobApplyParams> {
	async run(event: WorkflowEvent<JobApplyParams>, step: WorkflowStep): Promise<ApplyResult> {
		const { instanceId, userId, taskId, job } = event.payload;
		const env = this.env;

		// Resolved fresh (not journaled) so the runner token never lands in state.
		const conn = await getRunnerConn(env, instanceId, userId);
		if (!conn) {
			return { outcome: "failed", detail: "No browser runner connected. Start it with: pags up", steps: 0 };
		}

		await step.do("open", () => callRunner<{ url: string }>(conn, "/browser/act", { action: "navigate", url: job.url }));

		// Durable-step wrappers for the tested pure loop. The call order is
		// deterministic, so the monotonic counter yields stable, replayable step
		// names — even across captcha handoffs (it never resets).
		let n = 0;
		const deps: ApplyDeps = {
			snapshot: () => step.do(`s${n++}-snapshot`, () => callRunner<PageSnapshot>(conn, "/browser/snapshot")) as Promise<PageSnapshot>,
			decide: (p) => step.do(`s${n++}-decide`, () => decideAction(env, userId, p)) as Promise<ApplyDecision>,
			act: (a) => step.do(`s${n++}-act`, async () => { await callRunner(conn, "/browser/act", a); return { url: "", challenge: null as string | null }; }) as Promise<{ url: string; challenge: string | null }>,
			onEvent: (type, message, data) => step.do(`s${n++}-event`, async () => {
				await callRunner(conn, "/browser/event", { taskId, type, message, data }).catch(() => undefined);
				return null;
			}).then(() => undefined),
		};

		// Drive; on a CAPTCHA hand off to the human (same session), wait, resume,
		// and re-enter the loop until the application reaches a terminal outcome.
		let result: ApplyResult = { outcome: "failed", detail: "did not start", steps: 0 };
		for (let round = 0; round < 12; round++) {
			result = await runApplyLoop(deps, job, { maxSteps: 40 });
			if (result.outcome !== "captcha") break;

			await step.do(`handoff-${round}`, () => callRunner<{ ok: boolean }>(conn, "/browser/handoff", { taskId, challenge: result.challenge ?? "captcha" }));

			let solved = false;
			for (let poll = 0; poll < CAPTCHA_WAIT_POLLS && !solved; poll++) {
				await step.sleep(`wait-${round}-${poll}`, "5 seconds");
				const status = await step.do(`hstatus-${round}-${poll}`, () => callRunner<{ solved: boolean }>(conn, "/browser/handoff-status", { taskId }));
				solved = status.solved;
			}
			if (!solved) {
				await step.do(`complete-timeout-${round}`, () => callRunner<{ ok: boolean }>(conn, "/browser/complete", { taskId, outcome: "failed", detail: "CAPTCHA not solved in time" }));
				return { outcome: "failed", detail: "CAPTCHA not solved in time", steps: result.steps };
			}
			await step.do(`resume-${round}`, () => callRunner<{ ok: boolean }>(conn, "/browser/resume", { taskId }));
		}

		await step.do("complete", () => callRunner<{ ok: boolean }>(conn, "/browser/complete", { taskId, outcome: result.outcome, detail: result.detail }));
		return result;
	}
}

export type { RunnerConn };
