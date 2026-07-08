import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { decideAction, describeAction, runApplyLoop, type ApplyDecision, type ApplyDeps, type ApplyJob, type ApplyResult, type PageSnapshot } from "../lib/apply-loop.js";
import { callRunner, getRunnerConn, type RunnerConn } from "../lib/runner-client.js";
import { atsHost, getAtsCacheHint, saveAtsCache } from "../lib/apply-cache.js";
import { saveAskAndHoldAnswer } from "../lib/profile.js";
import { decryptKey } from "../lib/crypto.js";
import { logError } from "../lib/error-log.js";
import { logEvent } from "../lib/events.js";
import { isTransientInfraError } from "../lib/transient-error.js";
import { runShotKey } from "../lib/run-shots.js";
import { notifyUser } from "../routes/push.js";
import { buildQuery, extractCode, findMatchingMessage, gmailMessageUrl, mintGmailAccessToken, rankConfirmationLinks } from "../lib/gmail.js";
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

/** Decode a base64 JPEG (no data: prefix) to bytes for an R2 put. */
function b64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const arr = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
	return arr;
}

/**
 * The remote brain: a durable Cloudflare Workflow that drives the user's local
 * browser runner through a whole job application — read the page, ask Claude
 * (the user's BYOK key) for one action, perform it, repeat. On a CAPTCHA it
 * hands off to the human REMOTELY (same live session via the console takeover),
 * polls until solved, then resumes. Each step is durable, so the loop survives
 * restarts and runs far past the 30s request limit.
 */
export class JobApplyWorkflow extends WorkflowEntrypoint<Env, JobApplyParams> {
	/** Entry point: run the apply, but NEVER let an uncaught throw vanish into an
	 *  "Errored" workflow with no trace. Any crash is persisted to error_log and the
	 *  runner task is marked failed — so it shows up in /v1/errors, the MCP, and the
	 *  console, not only in `wrangler workflows instances describe`. */
	async run(event: WorkflowEvent<JobApplyParams>, step: WorkflowStep): Promise<ApplyResult> {
		try {
			return await this.runInner(event, step);
		} catch (err) {
			const { instanceId, userId, taskId, job } = event.payload;
			const msg = err instanceof Error ? err.message : String(err);
			// A DO/isolate reset from a code deploy is TRANSIENT, not a crash. Re-throw so
			// the durable workflow retries + resumes from its last completed step (the whole
			// point of Workflows surviving deploys), and record it as an event — never a 500
			// error, which would manufacture a fake "crashed" entry on every deploy.
			if (isTransientInfraError(msg)) {
				await logEvent(this.env, { source: "apply", event: "apply.interrupted", message: `apply interrupted by a deploy, resuming: ${msg}`.slice(0, 200), userId, instanceId, traceId: taskId }).catch(() => undefined);
				throw err;
			}
			await logError(this.env, { source: "job-apply", userId, status: 500, message: `apply workflow crashed: ${msg}`, context: { instanceId, taskId, url: job?.url } });
			// Best-effort: don't leave the task stuck "running" after a crash.
			try {
				const conn = await getRunnerConn(this.env, instanceId, userId);
				if (conn) await callRunner(conn, "/browser/complete", { taskId, outcome: "failed", detail: msg.slice(0, 300) });
			} catch {
				/* best-effort */
			}
			return { outcome: "failed", detail: msg, steps: 0 };
		}
	}

	private async runInner(event: WorkflowEvent<JobApplyParams>, step: WorkflowStep): Promise<ApplyResult> {
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

		// May the brain read the candidate's inbox for a one-time sign-in link / code
		// this run? Requires: Gmail OAuth configured on the deployment, the user has
		// connected Gmail, AND the instance has the email permission toggled on.
		job.emailEnabled = await step.do("email-enabled", async () => {
			if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.KEY_ENCRYPTION_KEY) return false;
			const tokenRow = await env.DB.prepare("SELECT 1 AS ok FROM user_api_keys WHERE user_id = ?1 AND provider = 'gmail'").bind(userId).first<{ ok: number }>();
			if (!tokenRow) return false;
			try {
				const stub = env.AGENT.get(env.AGENT.idFromName(instanceId));
				const res = await stub.fetch(new Request("https://agent/state"));
				const state = (await res.json()) as { permissions?: { email?: boolean } };
				return state.permissions?.email === true;
			} catch {
				return false;
			}
		});

		await step.do("open", () => callRunner<{ url: string }>(conn, "/browser/act", { action: "navigate", url: job.url }));

		// Durable-step wrappers for the tested pure loop. The call order is
		// deterministic, so the monotonic counter yields stable, replayable step
		// names — even across captcha handoffs (it never resets).
		// Bounded retries: a Playwright failure is a SIGNAL for the brain, not a
		// transient error to hammer — so act catches it and returns it as data.
		const retry = { retries: { limit: 2, delay: "2 seconds" as const, backoff: "constant" as const }, timeout: "2 minutes" as const };
		let n = 0;
		const deps: ApplyDeps = {
			snapshot: () => step.do(`s${n++}-snapshot`, retry, () => callRunner<PageSnapshot>(conn, "/browser/snapshot", { taskId })) as Promise<PageSnapshot>,
			decide: (p) => step.do(`s${n++}-decide`, retry, () => decideAction(env, userId, p)) as Promise<ApplyDecision>,
			// Capture the step index OUTSIDE step.do so it's the SAME on a resume (n
			// increments deterministically every execution). Using it as the screenshot
			// seq keeps R2 keys unique + stable across handoff/resume — a plain counter
			// would reset to 0 on resume and overwrite earlier shots.
			act: (a) => { const sn = n++; return step.do(`s${sn}-act`, retry, async () => {
				// Hard dry-run guard: in test mode, NEVER let a submit click reach the
				// page — block it here (the brain can't override the runtime) and tell
				// the brain to finish(ready). This is what makes dryRun actually safe.
				// Block only UNAMBIGUOUS final-submit labels here (stateless — this guard
				// runs inside a journaled step, so it can't carry form-progress state). NOT
				// "Apply"/"Apply now": those are the ENTRY button on most ATS, and blocking
				// them stops dry-run before it can fill anything. The pure loop handles the
				// one-page "Apply = submit" case using typed-field state.
				// Also block labels that are ALWAYS terminal or one-click submitters even
				// before any field is filled (the pure-loop guard only arms after a fill, so a
				// 1-click "Easy Apply"/pre-filled submit as the FIRST action would otherwise
				// slip through and really submit in test mode). "Finish"/"Done" are never entry
				// buttons; "Easy/Quick Apply" + "1-click" submit from a saved profile. Plain
				// "Apply"/"Apply now"/"Next"/"Continue" stay walkable so dry-run can still fill.
				if (job.dryRun && a.action === "click" && /\bsubmit\b|\bfinish\b|\bdone\b|send application|submit application|easy apply|quick apply|one[- ]?click|1[- ]?click/i.test(String(a.name ?? ""))) {
					return { url: "", challenge: null as string | null, error: "DRY-RUN (test mode): the final submit is BLOCKED — do not submit. Call finish(status:\"ready\") now." };
				}
				try {
					// Pass resumePath so the runner arms file-chooser auto-attach (résumé
					// uploads never pop a blocking native dialog, whatever the ATS DOM).
					const r = await callRunner<{ url: string; challenge: string | null; feedback?: string; screenshot?: string }>(conn, "/browser/act", { ...a, resumePath: job.resumePath });
					// Persist a screenshot of the resulting page so the run can be REPLAYED
					// visually. The blob goes to R2 keyed by step; the event carries only the
					// key + the action (the events feed stays small). Best-effort — a shot
					// failure must never fail the application step.
					if (r.screenshot && env.STORAGE) {
						const key = runShotKey(userId, instanceId, taskId, sn);
						await env.STORAGE.put(key, b64ToBytes(r.screenshot), { httpMetadata: { contentType: "image/jpeg" } }).catch(() => undefined);
						await callRunner(conn, "/browser/event", { taskId, type: "agent.shot", message: describeAction(a), data: { seq: sn, key, action: a.action, name: a.name ?? "", url: r.url ?? "" } }).catch(() => undefined);
					}
					return { url: r.url ?? "", challenge: r.challenge ?? null, error: undefined as string | undefined, feedback: r.feedback };
				} catch (e) {
					// Return the failure to the brain instead of throwing (which would retry the same dead click).
					return { url: "", challenge: null as string | null, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
				}
			}) as Promise<{ url: string; challenge: string | null; error?: string }>; },
			onEvent: (type, message, data) => step.do(`s${n++}-event`, async () => {
				await callRunner(conn, "/browser/event", { taskId, type, message, data }).catch(() => undefined);
				// Bridge the same step into the unified trace so agent_trace shows the
				// apply play-by-play (nav → snapshot → act → stuck …), not just failures.
				await logEvent(env, { source: "apply", event: type, message, userId, instanceId, traceId: taskId, context: data as Record<string, unknown> | undefined }).catch(() => undefined);
				return null;
			}).then(() => undefined),
			// Mid-flight steering: read + clear any message the user sent to this task so
			// the brain picks it up on its next decision (works while RUNNING, not only
			// on a handoff resume). Same user_hint channel as the console message box.
			pollHint: () => step.do(`s${n++}-hint`, async () => {
				const row = await env.DB.prepare("SELECT user_hint FROM instance_runtime_tasks WHERE id = ?1 AND user_id = ?2").bind(taskId, userId).first<{ user_hint?: string }>();
				const h = (row?.user_hint as string) ?? null;
				if (h) await env.DB.prepare("UPDATE instance_runtime_tasks SET user_hint = NULL WHERE id = ?1 AND user_id = ?2").bind(taskId, userId).run();
				return h;
			}) as Promise<string | null>,
			// Read the connected Gmail for a one-time sign-in link / verification code.
			// Durable step; never throws — returns a message the brain acts on next turn.
			readEmail: (q) => step.do(`s${n++}-email`, retry, async () => {
				const row = await env.DB.prepare("SELECT key_ciphertext, dek_wrapped, iv FROM user_api_keys WHERE user_id = ?1 AND provider = 'gmail'").bind(userId).first<{ key_ciphertext: ArrayBuffer; dek_wrapped: ArrayBuffer; iv: ArrayBuffer }>();
				if (!row || !env.KEY_ENCRYPTION_KEY) return "Gmail is not connected — use request_user_info to ask the user for the link/code.";
				try {
					const refresh = await decryptKey(new Uint8Array(row.key_ciphertext), new Uint8Array(row.dek_wrapped), new Uint8Array(row.iv), env.KEY_ENCRYPTION_KEY);
					const token = await mintGmailAccessToken(env, refresh);
					const query = buildQuery({ from: q.from, subject: q.subject, withinDays: q.withinDays });
					const match = await findMatchingMessage(token, query);
					if (!match) return `No matching email yet (searched: ${query}). It may not have arrived — wait a few seconds and call read_email_link again.`;
					// Record the email in the activity log with a click-through to open it in
					// Gmail, so the user can see (and verify) exactly which message the agent read.
					await callRunner(conn, "/browser/event", { taskId, type: "job.email", message: `Read email: ${match.subject}`, data: { gmailUrl: gmailMessageUrl(match.id), subject: match.subject, from: match.from, date: match.date, purpose: "sign-in / verification" } }).catch(() => undefined);
					const ranked = rankConfirmationLinks(match.links, q.from);
					const code = extractCode(match.text);
					const parts = [`Email "${match.subject}" from ${match.from}.`];
					if (ranked[0]) parts.push(`Most likely sign-in link: ${ranked[0]}`);
					if (code) parts.push(`Verification code: ${code}`);
					if (!ranked[0] && !code) parts.push("No link or code found in it — try a different subject/from, or request_user_info.");
					return parts.join(" ");
				} catch (e) {
					return `Could not read email: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
				}
			}) as Promise<string>,
		};

		// Drive; on a CAPTCHA hand off to the human (same session), wait, resume,
		// and re-enter the loop until the application reaches a terminal outcome.
		let result: ApplyResult = { outcome: "failed", detail: "did not start", steps: 0 };
		const transcript: string[] = [];
		let solvedChallengeUrl: string | undefined; // page where a captcha was just solved
		const tokens = { input: 0, output: 0 }; // running total across ALL rounds (handoffs re-enter the loop)
		let filled = false; // did any field get typed in a prior round? carries the dry-run submit guard across handoffs
		await step.do("trace-start", async () => { await logEvent(env, { source: "apply", event: "apply.start", message: `Apply → ${host}${job.dryRun ? " (dry run)" : ""}`, userId, instanceId, traceId: taskId, context: { url: job.url, dryRun: !!job.dryRun } }).catch(() => undefined); return null; });
		for (let round = 0; round < 12; round++) {
			result = await runApplyLoop(deps, job, { maxSteps: 60, solvedChallengeUrl, tokens, filled });
			solvedChallengeUrl = undefined;
			filled = result.filled ?? filled; // once true, stays true for the rest of the application
			transcript.push(...(result.transcript ?? []));
			if (result.outcome !== "captcha" && result.outcome !== "stuck" && result.outcome !== "needs_input") break;

			// Three handoff kinds, one console takeover, one pause/resume:
			//  captcha → auto-resume when solved · stuck → resume on human "Resume"
			//  needs_input → resume when the user supplies the value (saved to Profile).
			const reason = result.outcome === "captcha" ? "challenge" : result.outcome === "needs_input" ? "needs_input" : "stuck";
			const label = result.outcome === "captcha" ? result.challenge ?? "captcha" : result.outcome === "needs_input" ? result.fieldNeeded ?? "a value" : result.detail ?? "this step";
			await step.do(`handoff-${round}`, () => callRunner<{ ok: boolean }>(conn, "/browser/handoff", { taskId, label, reason, challenge: result.challenge ?? undefined }));

			// Reach out to the user — an in-app notification + web push (+ Slack if set) —
			// so they know the application is paused waiting on THEM, instead of it sitting
			// silently in needs_human until they happen to look at the console.
			await step.do(`notify-${round}`, async () => {
				const link = `/console/instances/${instanceId}/board`;
				const host = atsHost(job.url) || "the job site";
				const { title, body } =
					reason === "needs_input"
						? { title: "🙋 Your job application needs an answer", body: `${label} — open to provide it and the agent continues (${host}).` }
						: reason === "challenge"
							? { title: "🔐 Verification needed on your application", body: `A human check (${label}) appeared on ${host} — take over to solve it and the agent continues.` }
							: { title: "✋ Your job application needs a hand", body: `Stuck on: ${label} (${host}). Take over that one step and the agent continues.` };
				// The whole point of this notification is that the user learns their application
				// is paused waiting on THEM. If every channel fails, that must not vanish silently —
				// record it so it's visible in the error log rather than a lost pause.
				await notifyUser(env, userId, "apply", title, body, link).catch(async (e) => {
					await logError(env, { source: "job-apply", userId, message: `handoff notify failed (${reason}): ${e instanceof Error ? e.message : String(e)}`.slice(0, 300), context: { instanceId, taskId, reason } }).catch(() => undefined);
				});
				return null;
			});

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
				// A 15-min handoff wait elapsing is an EXPECTED outcome (the user was notified
				// + can Retry from the board), not a system error — record it as a trace event
				// so it stops polluting /v1/errors and burying real bugs.
				await step.do(`log-timeout-${round}`, async () => { await logEvent(env, { source: "apply", event: "apply.handoff_timeout", message: `apply timed out: ${reason} not resolved in time`, userId, instanceId, traceId: taskId, context: { url: job.url, reason, steps: result.steps } }).catch(() => undefined); return null; });
				// Save the partial run's learnings (incl. what got stuck) before bailing (best-effort).
				if (transcript.length) await step.do(`save-cache-timeout-${round}`, async () => { await saveAtsCache(env, userId, host, transcript, result.outcome).catch(() => undefined); return null; });
				return { outcome: "failed", detail: `${reason} not resolved in time`, steps: result.steps };
			}
			// Persist a supplied value to the Profile + feed it into the run so it's never asked again.
			if (result.outcome === "needs_input" && providedValue && result.fieldNeeded) {
				const field = result.fieldNeeded;
				const value = providedValue;
				await step.do(`save-input-${round}`, async () => { await saveAskAndHoldAnswer(env, userId, field, value); return null; });
				job.providedAnswers = { ...(job.providedAnswers ?? {}), [field]: value };
			}
			// After a solved captcha, suppress re-detection on that SAME page (its
			// widget/text lingers) so the agent fills the form instead of looping.
			if (result.outcome === "captcha") solvedChallengeUrl = result.url;
			await step.do(`resume-${round}`, () => callRunner<{ ok: boolean }>(conn, "/browser/resume", { taskId }));
			// Any message the user sent while paused is picked up by deps.pollHint on the
			// next loop step (same channel as mid-flight steering) — no special-casing here.
		}

		// Complete the task FIRST so the board flips to Submitted immediately — the
		// confirmation-email lookup below runs AFTER, adding its link to the (already
		// completed) run's activity log a little later.
		await step.do("complete", () => callRunner<{ ok: boolean }>(conn, "/browser/complete", { taskId, outcome: result.outcome, detail: result.detail }));
		await step.do("trace-end", async () => { await logEvent(env, { source: "apply", event: "apply.end", level: result.outcome === "submitted" ? "info" : "warn", message: `Outcome: ${result.outcome}${result.detail ? ` — ${result.detail}` : ""}`, userId, instanceId, traceId: taskId, context: { outcome: result.outcome, steps: result.steps, url: job.url } }).catch(() => undefined); return null; });

		// On a successful submit, look up the employer's confirmation email in the
		// user's connected Gmail and record it in the activity log as a click-through
		// (they open the actual confirmation from the console). Best-effort: the email
		// may not have arrived yet (poll a little); Gmail may be off — never fail the
		// application over it.
		if (result.outcome === "submitted" && job.emailEnabled) {
			// The confirmation is sent from the ATS registrable domain (e.g. Xero via
			// ashbyhq.com), so hint on that rather than the full job host.
			const fromDomain = host.split(".").slice(-2).join(".");
			// Broad subject net — different ATS phrase it differently ("Thanks for
			// applying!", "Application received", "We received your application", …).
			const confirmSubjects = "application received OR application submitted OR thanks for applying OR thank you for applying OR thanks for your application OR we received your application OR we've received your application OR your application to OR application confirmation";
			const waits = ["8 seconds", "15 seconds", "25 seconds"] as const;
			for (let attempt = 0; attempt < waits.length; attempt++) {
				// Poll at ~8s, ~23s, ~48s — the email is usually near-instant but some
				// ATS (Dover/Workday) take up to a minute.
				await step.sleep(`confirm-wait-${attempt}`, waits[attempt]);
				const found = await step.do(`confirm-email-${attempt}`, async () => {
					try {
						const row = await env.DB.prepare("SELECT key_ciphertext, dek_wrapped, iv FROM user_api_keys WHERE user_id = ?1 AND provider = 'gmail'").bind(userId).first<{ key_ciphertext: ArrayBuffer; dek_wrapped: ArrayBuffer; iv: ArrayBuffer }>();
						if (!row || !env.KEY_ENCRYPTION_KEY) return true; // Gmail gone — stop polling
						const refresh = await decryptKey(new Uint8Array(row.key_ciphertext), new Uint8Array(row.dek_wrapped), new Uint8Array(row.iv), env.KEY_ENCRYPTION_KEY);
						const token = await mintGmailAccessToken(env, refresh);
						// Prefer a recent email FROM the ATS domain; fall back to a confirmation
						// SUBJECT match (some ATS, e.g. Dover, relay the confirmation from the
						// employer's own domain, so a from-only search would miss it).
						const match =
							(await findMatchingMessage(token, buildQuery({ from: fromDomain, withinDays: 1 }))) ??
							(await findMatchingMessage(token, buildQuery({ subject: confirmSubjects, withinDays: 1 })));
						if (!match) return false;
						await callRunner(conn, "/browser/event", { taskId, type: "job.confirmation_email", message: match.subject, data: { gmailUrl: gmailMessageUrl(match.id), subject: match.subject, from: match.from, date: match.date } }).catch(() => undefined);
						return true;
					} catch { return true; /* best-effort — don't spin on errors */ }
				});
				if (found) break;
			}
		}

		// Persist a non-success terminal outcome so an apply failure isn't only in events.
		// These run AFTER /browser/complete — they must be best-effort. If a D1 hiccup here
		// threw, the outer catch would fire /browser/complete AGAIN with "failed" and log a
		// phantom crash for an application that actually SUBMITTED. Swallow inside the step.
		if (["failed", "blocked", "expired", "max_steps"].includes(result.outcome)) {
			await step.do("log-outcome", async () => { await logError(env, { source: "job-apply", userId, message: `apply ${result.outcome}: ${result.detail ?? ""}`, context: { instanceId, taskId, url: job.url, outcome: result.outcome, steps: result.steps } }).catch(() => undefined); return null; });
		}

		// Remember this run's path (what worked AND what failed) for the next
		// application to this ATS + the transparency view — not just on submit.
		if (transcript.length) {
			await step.do("save-cache", async () => { await saveAtsCache(env, userId, host, transcript, result.outcome).catch(() => undefined); return null; });
		}
		return result;
	}
}

export type { RunnerConn };
