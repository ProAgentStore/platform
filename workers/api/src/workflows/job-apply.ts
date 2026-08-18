import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { decideAction, describeAction, dryRunBlockReason, runApplyLoop, type ApplyDecision, type ApplyDeps, type ApplyJob, type ApplyResult, type PageSnapshot } from "../lib/apply-loop.js";
import { decideWithinBudget } from "../lib/apply-decide-budget.js";
import { callRunner, getBoundRunnerConn, type RunnerConn } from "../lib/runner-client.js";
import { atsHost, getAtsCacheHint, saveAtsCache } from "../lib/apply-cache.js";
import { commitGuardSpec } from "../lib/commit-guard.js";
import { fabricationBlockReason } from "../lib/fabrication-guard.js";
import { saveAskAndHoldAnswer } from "../lib/profile.js";
import { decryptKey } from "../lib/crypto.js";
import { instanceRunLink } from "../lib/console-links.js";
import { logError } from "../lib/error-log.js";
import { logEvent } from "../lib/events.js";
import { isTransientInfraError } from "../lib/transient-error.js";
import { browserRunAdvance, browserRunPark, browserRunTick, BROWSER_RUN_ROUNDS, finishBrowserRun, handoffGiveUpAt } from "../lib/browser-run.js";
import { runShotKey } from "../lib/run-shots.js";
import { collectJobSecrets, makeSecretRedactor } from "../lib/redact-secrets.js";
import { notifyUser } from "../routes/push.js";
import { buildQuery, extractCode, findMatchingMessage, gmailMessageUrl, mintGmailAccessToken, rankConfirmationLinks } from "../lib/gmail.js";
import type { Env } from "../types.js";

export interface JobApplyParams {
	instanceId: string;
	userId: string;
	/** The runner task id this application drives (created by the trigger route). */
	taskId: string;
	job: ApplyJob;
	/**
	 * Delegation budget this run draws against (#516), mirroring `CodingSessionParams`.
	 *
	 * Optional so an older queued run (or a test) still executes — `decideWithinBudget` runs the
	 * decide untouched when it is absent. `startJobApply` always opens one: unlike the Pilot, whose
	 * pool is only opened for a DELEGATED run, every apply is unattended by construction, so there
	 * is no "human is watching this one" path to leave unmetered.
	 */
	budgetId?: string | null;
	/** Depth in the supervision tree; the budget refuses past its cap. */
	depth?: number;
	/**
	 * The `agent_loop_runs` row this application is recorded as (#560) — what makes it stoppable.
	 *
	 * #516 gave this workflow a spend pool and left it with no cancel path, which is half a fix: the
	 * owner could watch an unattended run spend and had nothing that could end it. `stop_work`
	 * resolves through `agent_loop_runs`, so this id is the whole of the reach.
	 *
	 * Optional so an application queued before this shipped still runs — every consumer no-ops on
	 * null and degrades to the old behaviour (cancellable only through a live runner).
	 */
	loopRunId?: string | null;
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
			await logError(this.env, { source: "job-apply", userId, status: 500, message: `apply workflow crashed: ${msg}`, context: { instanceId, taskId, url: job?.url, stack: err instanceof Error ? String(err.stack || "").slice(0, 1500) : undefined } });
			// Best-effort: don't leave the task stuck "running" after a crash.
			try {
				const conn = await getBoundRunnerConn(this.env, instanceId, userId);
				if (conn) await callRunner(conn, "/browser/complete", { taskId, outcome: "failed", detail: msg.slice(0, 300) });
			} catch {
				/* best-effort */
			}
			// AFTER the transient rethrow above, never before it: a run the platform is about to
			// replay must not be filed as dead (#546). Only a genuine crash closes the record.
			const crashed: ApplyResult = { outcome: "failed", detail: msg, steps: 0 };
			await finishBrowserRun(this.env, event.payload.loopRunId ?? null, crashed);
			return crashed;
		}
	}

	private async runInner(event: WorkflowEvent<JobApplyParams>, step: WorkflowStep): Promise<ApplyResult> {
		const { instanceId, userId, taskId, job } = event.payload;
		const env = this.env;
		const loopRunId = event.payload.loopRunId ?? null;

		// Resolved fresh (not journaled) so the runner token never lands in state.
		const conn = await getBoundRunnerConn(env, instanceId, userId);
		if (!conn) {
			// The runner task was ALREADY created and mirrored as `running` before this workflow
			// booted, and this return skips `/browser/complete` — the only thing that closes it.
			// Nothing else ever would: `expireOrphanedRuntimeTasks` deliberately exempts
			// `job.apply_agent`. So a WiFi blip in the ~200ms between the pre-flight check and the
			// workflow starting left the row `running` forever, and the single-flight claim in
			// `/apply` matched it — every future application 409'd "already in progress" for the
			// full 4h STALE_APPLY_MS window, for an application that never took a step.
			await step.do("no-runner-close", async () => {
				// The PAYLOAD too, not just the status column. The board renders
				// `parsePayload(row.payload)`, so updating the column alone freed the single-flight
				// claim (which reads the column) while leaving a live-looking "running" apply card
				// on the board forever, with a Cancel button acting on a task no workflow owns.
				const row = await env.DB.prepare(
					"SELECT payload FROM instance_runtime_tasks WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3",
				)
					.bind(taskId, instanceId, userId)
					.first<{ payload: string }>()
					.catch(() => null);
				let payload: Record<string, unknown> = {};
				try {
					payload = row?.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : {};
				} catch {
					/* a corrupt payload still gets a terminal status below */
				}
				const now = new Date().toISOString();
				payload = { ...payload, id: taskId, status: "failed", error: "No browser runner connected. Start it with: pags up", updatedAt: now, completedAt: now };
				// NOT best-effort: this write is the only thing that closes the task, and everything
				// the paragraph above describes comes back the moment it is skipped — a permanently
				// "running" card with a Cancel button owned by nothing, and a single-flight claim
				// that 409s every application for the next four hours. Let it throw so the step
				// RETRIES; a workflow step is the one place where that is free.
				await env.DB.prepare(
					"UPDATE instance_runtime_tasks SET status = 'failed', payload = ?4, updated_at = datetime('now') WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3",
				)
					.bind(taskId, instanceId, userId, JSON.stringify(payload))
					.run();
				return null;
			});
			const noRunner: ApplyResult = { outcome: "failed", detail: "No browser runner connected. Start it with: pags up", steps: 0 };
			await finishBrowserRun(env, loopRunId, noRunner);
			return noRunner;
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
		// #631: `agent.shot` is written from inside `act`, so it does NOT pass through the
		// loop's redacting `emit` — and it was the sink where 9 of the 18 leaked production
		// rows landed, all but one with an empty control name that no field-name rule could catch.
		// Redact the shot message here with the same job-derived value redactor.
		const redact = makeSecretRedactor(collectJobSecrets(job));
		// The page the CURRENT decision was made from — see the snapshot dep below (#627).
		let lastSnapshot = "";
		// The policy that travels with every action so the runner can enforce it where the click
		// actually happens. Null on a real application: there is nothing to block.
		const guard = job.dryRun ? commitGuardSpec("apply_dry_run") : undefined;
		const deps: ApplyDeps = {
			// The durable cancel is read HERE, beside the runner's own flag, so both answers meet at
			// the one place `runApplyLoop` already halts on (#560) — no second way for an
			// application to stop. `browserRunTick` also heartbeats, which keeps `sweepStaleRuns`
			// off an application that is legitimately taking a while.
			snapshot: () => step.do(`s${n++}-snapshot`, retry, async () => {
				const snap = await callRunner<PageSnapshot>(conn, "/browser/snapshot", { taskId });
				const stopped = await browserRunTick(env, loopRunId);
				return stopped ? { ...snap, cancelled: true } : snap;
			}).then((snap) => {
				// Kept for the guard below: the snapshot is the page's OWN account of every element
				// (role, accessible name, [ref=eNN]), so resolving the brain's `ref` against it is
				// how the dry-run block stops depending on a label the brain wrote and the runner
				// never reads (#627). Set outside the journaled step, from its (replayed) value, so
				// a resumed workflow rebuilds it deterministically.
				lastSnapshot = (snap as PageSnapshot)?.snapshot ?? "";
				return snap as PageSnapshot;
			}),
			// The spend gate lives in `apply-decide-budget.ts` — the LLM call is the only place this
			// loop spends money, so it is the only place the budget has to sit (#516). Reserve and
			// settle both happen INSIDE this step, so no reservation is ever held across a handoff:
			// the captcha/stuck/needs_input pauses below (up to CAPTCHA_WAIT_POLLS × 5s = 15 min of
			// `step.sleep`) all happen after `runApplyLoop` has returned, with the pool at rest.
			decide: (p) =>
				step.do(`s${n++}-decide`, retry, () =>
					decideWithinBudget(env, { userId, instanceId, budgetId: event.payload.budgetId, depth: event.payload.depth }, () =>
						decideAction(env, userId, p, { kind: "apply", instanceId }),
					),
				) as Promise<ApplyDecision>,
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
				// One stateless guard, shared with the pure loop's module so it is testable without a
				// Workflow — including the nameless-click case, which slipped past BOTH guards and
				// really submitted an application during a test run.
				const blocked = job.dryRun ? dryRunBlockReason(a as { action?: string; name?: string }, lastSnapshot) : null;
				if (blocked) {
					return { url: "", challenge: null as string | null, error: blocked };
				}
				// The OTHER promise the prompt made alone (#643): "NEVER invent data" and the EEO
				// decline rule were sentences in `applySystemPrompt` and nothing else — `job.candidate`
				// was read in exactly one place in the Worker, the line that renders it INTO that
				// prompt. This is the same shape as the block above and for the same stated reason: a
				// prompt cannot verify a prompt, and this one lands on a real employer's form under
				// the owner's name. Deliberately NOT gated on `job.dryRun` like the block above: a
				// rehearsal is not when fabrication matters, a real submission is.
				//
				// It REFUSES rather than substituting a correct value. A silent correction would be a
				// second invisible behaviour on the exact path this exists to make visible; a refusal
				// is a fact the loop already knows how to act on (it comes back as a failed action,
				// which the prompt answers with `request_user_info`).
				const unsourced = fabricationBlockReason(a, job, lastSnapshot);
				if (unsourced) {
					// Observable, through the channel this path already writes to (#643): the refusal
					// comes back as an action error, which the loop emits as `agent.action_failed` —
					// but that reads as "Playwright couldn't", not "the agent made this up". So the
					// unsourced case gets its own `agent_events` row, at `warn`, carrying the value it
					// tried to write. Redacted like every other sink here (#631), and best-effort: an
					// events blip must not fail the step whose refusal already happened.
					await logEvent(env, {
						source: "apply",
						event: "apply.unsourced_value",
						level: "warn",
						message: redact(`Refused an unsourced value: ${describeAction(a)}`).slice(0, 300),
						userId,
						instanceId,
						traceId: taskId,
						context: { action: a.action, name: a.name ?? "", value: redact(String(a.text ?? "")).slice(0, 120), reason: unsourced.slice(0, 200) },
					}).catch(() => undefined);
					return { url: "", challenge: null as string | null, error: unsourced };
				}
				try {
					// Pass resumePath so the runner arms file-chooser auto-attach (résumé
					// uploads never pop a blocking native dialog, whatever the ATS DOM).
					// `guard` goes with it: this pre-filter reads a label the brain wrote, and the
					// runner is the only party that can read the ELEMENT (#627). A runner too old
					// to know the field ignores it, which is exactly the state this leaves the
					// field in until the CLI is upgraded.
					const r = await callRunner<{ url: string; challenge: string | null; feedback?: string; screenshot?: string }>(conn, "/browser/act", { ...a, resumePath: job.resumePath, ...(guard ? { guard } : {}) });
					// Persist a screenshot of the resulting page so the run can be REPLAYED
					// visually. The blob goes to R2 keyed by step; the event carries only the
					// key + the action (the events feed stays small). Best-effort — a shot
					// failure must never fail the application step.
					if (r.screenshot && env.STORAGE) {
						const key = runShotKey(userId, instanceId, taskId, sn);
						await env.STORAGE.put(key, b64ToBytes(r.screenshot), { httpMetadata: { contentType: "image/jpeg" } }).catch(() => undefined);
						await callRunner(conn, "/browser/event", { taskId, type: "agent.shot", message: redact(describeAction(a)), data: { seq: sn, key, action: a.action, name: a.name ?? "", url: r.url ?? "" } }).catch(() => undefined);
					}
					return { url: r.url ?? "", challenge: r.challenge ?? null, error: undefined as string | undefined, feedback: r.feedback };
				} catch (e) {
					// Return the failure to the brain instead of throwing (which would retry the same dead click).
					return { url: "", challenge: null as string | null, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
				}
			}) as Promise<{ url: string; challenge: string | null; error?: string }>; },
			onEvent: (type, message, data) => step.do(`s${n++}-event`, async () => {
				await callRunner(conn, "/browser/event", { taskId, type, message: redact(message), data }).catch(() => undefined);
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
					await callRunner(conn, "/browser/event", { taskId, type: "job.email", message: redact(`Read email: ${match.subject}`), data: { gmailUrl: gmailMessageUrl(match.id), subject: match.subject, from: match.from, date: match.date, purpose: "sign-in / verification" } }).catch(() => undefined);
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
		for (let round = 0; round < BROWSER_RUN_ROUNDS; round++) {
			// The run row's iteration is the ROUND, not `runApplyLoop`'s step counter — that one
			// restarts at zero every handoff, so recording it would freeze progress rather than
			// advance it (see `lib/browser-run.ts`).
			await browserRunAdvance(env, loopRunId, round + 1);
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
				// The run, not the Board (#349): the Board shows a card SAYING it is waiting on you;
				// the takeover overlay and the input box that answer the wait are on the run page.
				const link = instanceRunLink(instanceId, taskId);
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
				// The run is PAUSED on a human: `alert`, so no mute can hide it. The key is the
				// pause itself (this task, this reason, this round), not the prose — a workflow
				// step that replays must not buzz twice for one pause, and the NEXT round's pause
				// is a different event that must still get through.
				await notifyUser(env, userId, "apply", title, body, link, {
					key: `apply-handoff:${taskId}:${reason}:${round}`,
					kind: "alert",
				}).catch(async (e) => {
					await logError(env, { source: "job-apply", userId, message: `handoff notify failed (${reason}): ${e instanceof Error ? e.message : String(e)}`.slice(0, 300), context: { instanceId, taskId, reason } }).catch(() => undefined);
				});
				return null;
			});

			let solved = false;
			let stopped = false;
			let providedValue: string | undefined;
			for (let poll = 0; poll < CAPTCHA_WAIT_POLLS && !solved && !stopped; poll++) {
				await step.sleep(`wait-${round}-${poll}`, "5 seconds");
				const status = await step.do(`hstatus-${round}-${poll}`, async () => {
					const s = await callRunner<{ solved: boolean; value?: string }>(conn, "/browser/handoff-status", { taskId });
					// The 15-minute blind spot `cc17c1d` recorded and left (#560): this poll had no
					// cancellation awareness, so a stop arriving while the application waited on a
					// human was not seen until the wait expired — and an unanswered captcha or
					// `needs_input` is exactly the wedge an owner wants to end. The park is written
					// here too, so the run reports as WAITING with a give-up time rather than as
					// working (#459/#596).
					const cancelled = await browserRunPark(env, loopRunId, handoffGiveUpAt(Date.now(), CAPTCHA_WAIT_POLLS - poll));
					return { ...s, cancelled };
				});
				solved = status.solved;
				stopped = status.cancelled;
				if (solved) providedValue = status.value;
			}
			if (stopped) {
				const cancelled: ApplyResult = { outcome: "cancelled", detail: "stopped by the user", steps: result.steps };
				await step.do(`complete-cancelled-${round}`, () => callRunner<{ ok: boolean }>(conn, "/browser/complete", { taskId, outcome: "cancelled", detail: "stopped by the user" }));
				// The partial run's learnings are still worth keeping — what got as far as the
				// handoff is the same evidence a timeout saves (best-effort, as there).
				if (transcript.length) await step.do(`save-cache-cancelled-${round}`, async () => { await saveAtsCache(env, userId, host, transcript, "cancelled").catch(() => undefined); return null; });
				await finishBrowserRun(env, loopRunId, cancelled);
				return cancelled;
			}
			if (!solved) {
				await step.do(`complete-timeout-${round}`, () => callRunner<{ ok: boolean }>(conn, "/browser/complete", { taskId, outcome: "failed", detail: `${reason} not resolved in time` }));
				// A 15-min handoff wait elapsing is an EXPECTED outcome (the user was notified
				// + can Retry from the board), not a system error — record it as a trace event
				// so it stops polluting /v1/errors and burying real bugs.
				await step.do(`log-timeout-${round}`, async () => { await logEvent(env, { source: "apply", event: "apply.handoff_timeout", message: `apply timed out: ${reason} not resolved in time`, userId, instanceId, traceId: taskId, context: { url: job.url, reason, steps: result.steps } }).catch(() => undefined); return null; });
				// Save the partial run's learnings (incl. what got stuck) before bailing (best-effort).
				if (transcript.length) await step.do(`save-cache-timeout-${round}`, async () => { await saveAtsCache(env, userId, host, transcript, result.outcome).catch(() => undefined); return null; });
				// Recorded under the reason it actually stopped for, so the run lands in "Needs you"
				// rather than "Failed" (#553): nobody answered — nothing failed. The runner task's
				// own outcome above stays `failed`, which is that vocabulary, not the run's.
				await finishBrowserRun(env, loopRunId, { outcome: reason === "challenge" ? "captcha" : reason === "needs_input" ? "needs_input" : "stuck", detail: `${reason} not resolved in time`, steps: result.steps });
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
						await callRunner(conn, "/browser/event", { taskId, type: "job.confirmation_email", message: redact(match.subject), data: { gmailUrl: gmailMessageUrl(match.id), subject: match.subject, from: match.from, date: match.date } }).catch(() => undefined);
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
		await finishBrowserRun(env, loopRunId, result);
		return result;
	}
}

export type { RunnerConn };
