import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { describeAction, runApplyLoop, type ApplyDecision, type ApplyDeps, type ApplyResult, type PageSnapshot } from "../lib/apply-loop.js";
import { blockedActionReason, decideBrowserTask, type BrowserTaskJob } from "../lib/browser-task-loop.js";
import { callRunner, getBoundRunnerConn } from "../lib/runner-client.js";
import { instanceBoardLink } from "../lib/console-links.js";
import { logError } from "../lib/error-log.js";
import { logEvent } from "../lib/events.js";
import { isTransientInfraError } from "../lib/transient-error.js";
import { runShotKey } from "../lib/run-shots.js";
import { notifyUser } from "../routes/push.js";
import type { Env } from "../types.js";

export interface BrowserTaskParams {
	instanceId: string;
	userId: string;
	/** The runner task id this run drives (created by the trigger route). */
	taskId: string;
	job: BrowserTaskJob;
}

/** Max minutes to wait for a human to resolve a handoff before giving up. */
const HANDOFF_WAIT_POLLS = 180; // 180 × 5s = 15 min

function b64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const arr = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
	return arr;
}

/**
 * The generic browser brain: a durable Cloudflare Workflow that drives the user's
 * local browser runner toward an arbitrary objective — read the page, ask Claude
 * (BYOK) for one action, perform it, repeat — with the SAME captcha/stuck/needs_input
 * handoff machinery as apply. This is the production path (#69/#71) that replaces the
 * experimental chat-loop browser connector for real multi-step tasks. It reuses
 * `runApplyLoop`; only the prompt/tools/decision are generic (see browser-task-loop.ts).
 */
export class BrowserTaskWorkflow extends WorkflowEntrypoint<Env, BrowserTaskParams> {
	async run(event: WorkflowEvent<BrowserTaskParams>, step: WorkflowStep): Promise<ApplyResult> {
		try {
			return await this.runInner(event, step);
		} catch (err) {
			const { instanceId, userId, taskId, job } = event.payload;
			const msg = err instanceof Error ? err.message : String(err);
			if (isTransientInfraError(msg)) {
				await logEvent(this.env, { source: "apply", event: "browse.interrupted", message: `browser task interrupted by a deploy, resuming: ${msg}`.slice(0, 200), userId, instanceId, traceId: taskId }).catch(() => undefined);
				throw err;
			}
			await logError(this.env, { source: "browser-task", userId, status: 500, message: `browser task workflow crashed: ${msg}`, context: { instanceId, taskId, url: job?.url } });
			try {
				const conn = await getBoundRunnerConn(this.env, instanceId, userId);
				if (conn) await callRunner(conn, "/browser/complete", { taskId, outcome: "failed", detail: msg.slice(0, 300) });
			} catch { /* best-effort */ }
			return { outcome: "failed", detail: msg, steps: 0 };
		}
	}

	private async runInner(event: WorkflowEvent<BrowserTaskParams>, step: WorkflowStep): Promise<ApplyResult> {
		const { instanceId, userId, taskId, job } = event.payload;
		const env = this.env;

		const conn = await getBoundRunnerConn(env, instanceId, userId);
		if (!conn) {
			return { outcome: "failed", detail: "No browser runner connected. Start it with: pags up", steps: 0 };
		}

		// Open the start URL FIRST — this initializes the runner's page for the task
		// (the same "open" step the apply workflow uses; a fresh, scoped page — no stale tab).
		await step.do("open", () => callRunner<{ url: string }>(conn, "/browser/act", { action: "navigate", url: job.url }));

		const retry = { retries: { limit: 2, delay: "2 seconds" as const, backoff: "constant" as const }, timeout: "2 minutes" as const };
		let n = 0;
		const deps: ApplyDeps<BrowserTaskJob> = {
			snapshot: () => step.do(`s${n++}-snapshot`, retry, () => callRunner<PageSnapshot>(conn, "/browser/snapshot", { taskId })) as Promise<PageSnapshot>,
			decide: (p) => step.do(`s${n++}-decide`, retry, () => decideBrowserTask(env, userId, p, { kind: "chat", instanceId })) as Promise<ApplyDecision>,
			act: (a) => { const sn = n++; return step.do(`s${sn}-act`, retry, async () => {
				// The commit guard, enforced HERE and not in the prompt: a rehearsal (`dryRun`) or a
				// read-only agent (`readOnly`, declared on the agent row) never lets the committing
				// click reach the page, and the brain cannot override a runtime it does not run in.
				// This is what makes dryRun safe for a task whose commit is a plain click
				// (Confirm/Add/…), which apply's fill-gated guard wouldn't catch — and what lets a
				// read-only agent be pointed at a REAL logged-in account.
				const blocked = blockedActionReason(job, a);
				if (blocked) {
					return { url: "", challenge: null as string | null, error: blocked };
				}
				try {
					const r = await callRunner<{ url: string; challenge: string | null; feedback?: string; screenshot?: string }>(conn, "/browser/act", a);
					if (r.screenshot && env.STORAGE) {
						const key = runShotKey(userId, instanceId, taskId, sn);
						await env.STORAGE.put(key, b64ToBytes(r.screenshot), { httpMetadata: { contentType: "image/jpeg" } }).catch(() => undefined);
						await callRunner(conn, "/browser/event", { taskId, type: "agent.shot", message: describeAction(a), data: { seq: sn, key, action: a.action, name: a.name ?? "", url: r.url ?? "" } }).catch(() => undefined);
					}
					return { url: r.url ?? "", challenge: r.challenge ?? null, error: undefined as string | undefined, feedback: r.feedback };
				} catch (e) {
					return { url: "", challenge: null as string | null, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
				}
			}) as Promise<{ url: string; challenge: string | null; error?: string }>; },
			onEvent: (type, message, data) => step.do(`s${n++}-event`, async () => {
				await callRunner(conn, "/browser/event", { taskId, type, message, data }).catch(() => undefined);
				await logEvent(env, { source: "apply", event: type, message, userId, instanceId, traceId: taskId, context: data as Record<string, unknown> | undefined }).catch(() => undefined);
				return null;
			}).then(() => undefined),
			pollHint: () => step.do(`s${n++}-hint`, async () => {
				const row = await env.DB.prepare("SELECT user_hint FROM instance_runtime_tasks WHERE id = ?1 AND user_id = ?2").bind(taskId, userId).first<{ user_hint?: string }>();
				const h = (row?.user_hint as string) ?? null;
				if (h) await env.DB.prepare("UPDATE instance_runtime_tasks SET user_hint = NULL WHERE id = ?1 AND user_id = ?2").bind(taskId, userId).run();
				return h;
			}) as Promise<string | null>,
		};

		let result: ApplyResult = { outcome: "failed", detail: "did not start", steps: 0 };
		let solvedChallengeUrl: string | undefined;
		const tokens = { input: 0, output: 0 };
		await step.do("trace-start", async () => { await logEvent(env, { source: "apply", event: "browse.start", message: `Browser task → ${job.url}${job.dryRun ? " (dry run)" : ""}`, userId, instanceId, traceId: taskId, context: { url: job.url, dryRun: !!job.dryRun } }).catch(() => undefined); return null; });
		for (let round = 0; round < 12; round++) {
			result = await runApplyLoop<BrowserTaskJob>(deps, job, { maxSteps: 60, solvedChallengeUrl, tokens });
			solvedChallengeUrl = undefined;
			if (result.outcome !== "captcha" && result.outcome !== "stuck" && result.outcome !== "needs_input") break;

			const reason = result.outcome === "captcha" ? "challenge" : result.outcome === "needs_input" ? "needs_input" : "stuck";
			const label = result.outcome === "captcha" ? result.challenge ?? "captcha" : result.outcome === "needs_input" ? result.fieldNeeded ?? "a value" : result.detail ?? "this step";
			await step.do(`handoff-${round}`, () => callRunner<{ ok: boolean }>(conn, "/browser/handoff", { taskId, label, reason, challenge: result.challenge ?? undefined }));

			await step.do(`notify-${round}`, async () => {
				const link = instanceBoardLink(instanceId);
				const { title, body } =
					reason === "needs_input"
						? { title: "🙋 Your agent needs an answer", body: `${label} — open to provide it and it continues.` }
						: reason === "challenge"
							? { title: "🔐 Verification needed", body: `A human check (${label}) appeared — take over to solve it and the agent continues.` }
							: { title: "✋ Your agent needs a hand", body: `Stuck on: ${label}. Take over that one step and it continues.` };
				await notifyUser(env, userId, "apply", title, body, link).catch(async (e) => {
					await logError(env, { source: "browser-task", userId, message: `handoff notify failed (${reason}): ${e instanceof Error ? e.message : String(e)}`.slice(0, 300), context: { instanceId, taskId, reason } }).catch(() => undefined);
				});
				return null;
			});

			let solved = false;
			let providedValue: string | undefined;
			for (let poll = 0; poll < HANDOFF_WAIT_POLLS && !solved; poll++) {
				await step.sleep(`wait-${round}-${poll}`, "5 seconds");
				const status = await step.do(`hstatus-${round}-${poll}`, () => callRunner<{ solved: boolean; value?: string }>(conn, "/browser/handoff-status", { taskId }));
				solved = status.solved;
				if (solved) providedValue = status.value;
			}
			if (!solved) {
				await step.do(`complete-timeout-${round}`, () => callRunner<{ ok: boolean }>(conn, "/browser/complete", { taskId, outcome: "failed", detail: `${reason} not resolved in time` }));
				await step.do(`log-timeout-${round}`, async () => { await logEvent(env, { source: "apply", event: "browse.handoff_timeout", message: `browser task timed out: ${reason} not resolved in time`, userId, instanceId, traceId: taskId, context: { url: job.url, reason, steps: result.steps } }).catch(() => undefined); return null; });
				return { outcome: "failed", detail: `${reason} not resolved in time`, steps: result.steps };
			}
			if (result.outcome === "needs_input" && providedValue && result.fieldNeeded) {
				job.providedAnswers = { ...(job.providedAnswers ?? {}), [result.fieldNeeded]: providedValue };
			}
			if (result.outcome === "captcha") solvedChallengeUrl = result.url;
			await step.do(`resume-${round}`, () => callRunner<{ ok: boolean }>(conn, "/browser/resume", { taskId }));
		}

		await step.do("complete", () => callRunner<{ ok: boolean }>(conn, "/browser/complete", { taskId, outcome: result.outcome, detail: result.detail }));
		await step.do("trace-end", async () => { await logEvent(env, { source: "apply", event: "browse.end", level: result.outcome === "submitted" ? "info" : "warn", message: `Outcome: ${result.outcome}${result.detail ? ` — ${result.detail}` : ""}`, userId, instanceId, traceId: taskId, context: { outcome: result.outcome, steps: result.steps, url: job.url } }).catch(() => undefined); return null; });

		if (["failed", "blocked", "expired", "max_steps"].includes(result.outcome)) {
			await step.do("log-outcome", async () => { await logError(env, { source: "browser-task", userId, message: `browser task ${result.outcome}: ${result.detail ?? ""}`, context: { instanceId, taskId, url: job.url, outcome: result.outcome, steps: result.steps } }).catch(() => undefined); return null; });
		}
		return result;
	}
}
