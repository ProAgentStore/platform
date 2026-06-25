import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { decideAction, runApplyLoop, type ApplyDecision, type ApplyDeps, type ApplyJob, type ApplyResult, type PageSnapshot } from "../lib/apply-loop.js";
import { callRunner, getRunnerConn, type RunnerConn } from "../lib/runner-client.js";
import { atsHost, getAtsCacheHint, saveAtsCache } from "../lib/apply-cache.js";
import { guessProfileKey, setProfileField } from "../lib/profile.js";
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

		// Per-ATS cache: replay the known-good route from a prior success here.
		const host = atsHost(job.url);
		const cacheHint = await step.do("load-cache", async () => (await getAtsCacheHint(env, userId, host)) ?? "");
		if (cacheHint) job.cacheHint = cacheHint;

		await step.do("open", () => callRunner<{ url: string }>(conn, "/browser/act", { action: "navigate", url: job.url }));

		// Durable-step wrappers for the tested pure loop. The call order is
		// deterministic, so the monotonic counter yields stable, replayable step
		// names — even across captcha handoffs (it never resets).
		// Bounded retries: a Playwright failure is a SIGNAL for the brain, not a
		// transient error to hammer — so act catches it and returns it as data.
		const retry = { retries: { limit: 2, delay: "2 seconds" as const, backoff: "constant" as const }, timeout: "2 minutes" as const };
		let n = 0;
		const deps: ApplyDeps = {
			snapshot: () => step.do(`s${n++}-snapshot`, retry, () => callRunner<PageSnapshot>(conn, "/browser/snapshot")) as Promise<PageSnapshot>,
			decide: (p) => step.do(`s${n++}-decide`, retry, () => decideAction(env, userId, p)) as Promise<ApplyDecision>,
			act: (a) => step.do(`s${n++}-act`, retry, async () => {
				// Hard dry-run guard: in test mode, NEVER let a submit click reach the
				// page — block it here (the brain can't override the runtime) and tell
				// the brain to finish(ready). This is what makes dryRun actually safe.
				if (job.dryRun && a.action === "click" && /submit|send application|apply now/i.test(String(a.name ?? ""))) {
					return { url: "", challenge: null as string | null, error: "DRY-RUN (test mode): the final submit is BLOCKED — do not submit. Call finish(status:\"ready\") now." };
				}
				try {
					const r = await callRunner<{ url: string; challenge: string | null }>(conn, "/browser/act", a);
					return { url: r.url ?? "", challenge: r.challenge ?? null, error: undefined as string | undefined };
				} catch (e) {
					// Return the failure to the brain instead of throwing (which would retry the same dead click).
					return { url: "", challenge: null as string | null, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
				}
			}) as Promise<{ url: string; challenge: string | null; error?: string }>,
			onEvent: (type, message, data) => step.do(`s${n++}-event`, async () => {
				await callRunner(conn, "/browser/event", { taskId, type, message, data }).catch(() => undefined);
				return null;
			}).then(() => undefined),
		};

		// Drive; on a CAPTCHA hand off to the human (same session), wait, resume,
		// and re-enter the loop until the application reaches a terminal outcome.
		let result: ApplyResult = { outcome: "failed", detail: "did not start", steps: 0 };
		const transcript: string[] = [];
		let solvedChallengeUrl: string | undefined; // page where a captcha was just solved
		for (let round = 0; round < 12; round++) {
			result = await runApplyLoop(deps, job, { maxSteps: 60, solvedChallengeUrl });
			solvedChallengeUrl = undefined;
			transcript.push(...(result.transcript ?? []));
			if (result.outcome !== "captcha" && result.outcome !== "stuck" && result.outcome !== "needs_input") break;

			// Three handoff kinds, one console takeover, one pause/resume:
			//  captcha → auto-resume when solved · stuck → resume on human "Resume"
			//  needs_input → resume when the user supplies the value (saved to Profile).
			const reason = result.outcome === "captcha" ? "challenge" : result.outcome === "needs_input" ? "needs_input" : "stuck";
			const label = result.outcome === "captcha" ? result.challenge ?? "captcha" : result.outcome === "needs_input" ? result.fieldNeeded ?? "a value" : result.detail ?? "this step";
			await step.do(`handoff-${round}`, () => callRunner<{ ok: boolean }>(conn, "/browser/handoff", { taskId, label, reason, challenge: result.challenge ?? undefined }));

			let solved = false;
			let providedValue: string | undefined;
			for (let poll = 0; poll < CAPTCHA_WAIT_POLLS && !solved; poll++) {
				await step.sleep(`wait-${round}-${poll}`, "5 seconds");
				const status = await step.do(`hstatus-${round}-${poll}`, () => callRunner<{ solved: boolean; value?: string }>(conn, "/browser/handoff-status", { taskId }));
				solved = status.solved;
				if (solved) providedValue = status.value;
			}
			if (!solved) {
				await step.do(`complete-timeout-${round}`, () => callRunner<{ ok: boolean }>(conn, "/browser/complete", { taskId, outcome: "failed", detail: `${reason} not resolved in time` }));
				// Save the partial run's learnings (incl. what got stuck) before bailing.
				if (transcript.length) await step.do(`save-cache-timeout-${round}`, async () => { await saveAtsCache(env, userId, host, transcript, result.outcome); return null; });
				return { outcome: "failed", detail: `${reason} not resolved in time`, steps: result.steps };
			}
			// Persist a supplied value to the Profile + feed it into the run so it's never asked again.
			if (result.outcome === "needs_input" && providedValue && result.fieldNeeded) {
				const field = result.fieldNeeded;
				const value = providedValue;
				await step.do(`save-input-${round}`, async () => { await setProfileField(env, userId, guessProfileKey(field), value); return null; });
				job.providedAnswers = { ...(job.providedAnswers ?? {}), [field]: value };
			}
			// After a solved captcha, suppress re-detection on that SAME page (its
			// widget/text lingers) so the agent fills the form instead of looping.
			if (result.outcome === "captcha") solvedChallengeUrl = result.url;
			await step.do(`resume-${round}`, () => callRunner<{ ok: boolean }>(conn, "/browser/resume", { taskId }));
		}

		await step.do("complete", () => callRunner<{ ok: boolean }>(conn, "/browser/complete", { taskId, outcome: result.outcome, detail: result.detail }));

		// Remember this run's path (what worked AND what failed) for the next
		// application to this ATS + the transparency view — not just on submit.
		if (transcript.length) {
			await step.do("save-cache", async () => { await saveAtsCache(env, userId, host, transcript, result.outcome); return null; });
		}
		return result;
	}
}

export type { RunnerConn };
