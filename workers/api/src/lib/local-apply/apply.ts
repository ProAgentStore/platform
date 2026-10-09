/**
 * The Application Runner (#957): materials ready → a local CLI fills the application in a real
 * browser → the outcome written back to the application, by compare-and-set, with an audit row.
 *
 *   job.application.materials_ready (#956, via the connection outbox)
 *     → startApplicationFill: claim the run on the event id (replay = the same run), evaluate the
 *       submit gate, move the application materials_ready → filling, dispatch `local_browser.apply`
 *     → syncApplyRun (on read + per-minute cron): pull events; a pause mirrors to `blocked`, a
 *       resume back to `filling`; the result settles the application exactly once
 *     → awaiting_review | submitted (only with the site's confirmation) | blocked | failed.
 *
 * Not `JOB_APPLY` (a PAGS-brain workflow): its own runtime (`local_apply`), task, run table and
 * policy. The API owns state; the runner holds only the task.
 *
 * Never twice: a replayed event returns the existing run; an application leaves `materials_ready`
 * once; a submit attempt — confirmed, unconfirmed, or unknowable because the runner was lost
 * mid-run — sets `submit_attempted_at`, and nothing starts another fill after that.
 */
import { HttpError } from "../auth.js";
import { capabilitiesForInstance } from "../agent-capabilities.js";
import { readInstanceConfigPair } from "../instance-config.js";
import { type JobApplication, getOwnedApplication } from "../local-artifact/store.js";
import type { Env } from "../../types.js";
import { callRuntime, getLiveRuntime, runtimeJson } from "../../routes/instances-runtime.js";
import {
	LOCAL_APPLY_CANCEL_PATH,
	LOCAL_APPLY_CONTRACT_MIN_CLI,
	LOCAL_APPLY_DIRECTIVE_PATH,
	LOCAL_APPLY_PAUSE_REASONS,
	LOCAL_APPLY_RESUME_PATH,
	LOCAL_APPLY_RUN_PATH,
	LOCAL_APPLY_STATUS_PATH,
	LOCAL_APPLY_TASK_TYPE,
	type LocalApplyPause,
	type LocalApplyResultEnvelope,
	type LocalApplyTaskEnvelope,
	parseLocalApplyEvent,
	parseLocalApplyResult,
} from "./contract.js";
import { type ApplicationRunnerSettings, RUNNER_SETTINGS_KEY, effectiveRunnerSettings, evaluateSubmitGate, hostOfUrl } from "./policy.js";
import {
	type ApplicationMove,
	type ApplyRun,
	type ApplyRunPolicy,
	type ApplyTraceEvent,
	activeApplyRuns,
	applyRunCounts,
	getApplyRun,
	getApplyRunByRequest,
	insertApplyRun,
	isTerminalApplyRun,
	markSubmitAttempted,
	moveApplication,
	updateApplyRun,
} from "./store.js";
import { claimQueuedDispatch, instancesWithQueuedRuns, nextDueQueuedRun, noteQueued } from "../applications/work-queue-store.js";
import { QUEUE_MAX_ATTEMPTS, refusalVerdict } from "../applications/work-queue.js";
import { clipMarked } from "../clip-marked.js";
import { cliAtLeast } from "../runner-upgrade.js";
import { syncApplicationCard } from "../applications/application-board.js";
import { approvalStageOf, approvalState } from "./approval.js";
import { type AttentionDeps, requestOwnerAttention } from "../owner-attention.js";
import { notifyUser } from "../../routes/push.js";
import { parseAccountPreferences } from "../preferences.js";
import { consumeSubmitAuthorization, getSubmitAuthorization } from "./approval-store.js";
import { releaseApprovalIfNothingWasSent, upgradeQueuedRunPolicy } from "./approval-at-dispatch.js";
import { listSupervisorCheckpoints, noteSupervisorDirectiveDelivery, receiveSupervisorCheckpoint, sanitizeSupervisorFacts, type SupervisorDirective } from "./supervision.js";
import { directApplicationCheckpoint } from "./brain.js";

/** The event the Runner consumes — #956's readiness event. */
export const MATERIALS_READY_EVENT = "job.application.materials_ready";
export const LOST_RUNNER_GRACE_MS = 10 * 60_000;
export const PAUSED_RUNNER_GRACE_MS = 24 * 60 * 60_000;

export function notRunnerMessage(runtime: string | null | undefined): string {
	return `This agent is not an Application Runner (its capabilities.runtime is ${runtime ? `"${runtime}"` : "null"}). The creator declares capabilities.runtime "local_apply" to enable it.`;
}

const iso = (now: number) => new Date(now).toISOString();
const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * Put the DISPATCH of a decision on the application's own trace (#985).
 *
 * The directive row has always recorded `deliveryAttemptedAt` / `deliveredAt`, but the trace — the
 * timeline an owner and MCP actually read — showed only the decision, so "decided and never
 * dispatched", "dispatched and refused" and "dispatched, delivered, the CLI never acted" were one
 * indistinguishable silence. The run that #985 was filed from was in fact fully delivered; proving
 * that took a database read nobody outside the platform can make.
 *
 * RE-READS the run first, for the reason #982 records: `updateApplyRun` writes the trace wholesale
 * from the object it is handed, and the decision event was appended by `directApplicationCheckpoint`
 * against the same (now stale) object a moment ago. Appending from the stale copy would drop it.
 *
 * Bounded to two events per directive — the FIRST attempt, and the transition to delivered — so a
 * run parked for hours at one tick a minute cannot fill its own trace with retries.
 */
async function traceDirectiveDispatch(env: Env, uid: string, run: ApplyRun, directive: SupervisorDirective, outcome: { delivered: boolean; reason: string }, now: number): Promise<void> {
	const fresh = (await getApplyRun(env, run.instanceId, uid, run.id).catch(() => null)) ?? run;
	await updateApplyRun(
		env,
		fresh,
		{
			events: [
				{
					type: "policy.decision",
					at: iso(now),
					detail: {
						class: "checkpoint",
						checkpointId: directive.checkpointId,
						decision: directive.directive,
						dispatch: outcome.delivered ? "delivered" : "undelivered",
						reason: outcome.reason,
					},
				},
			],
		},
		now,
	).catch(() => undefined);
}

/** Deliver an already-persisted decision. A failed relay attempt stays durable and is retried on the next status pull. */
export async function deliverSupervisorDirective(env: Env, uid: string, run: ApplyRun, directive: SupervisorDirective, now = Date.now()): Promise<SupervisorDirective> {
	if (directive.deliveredAt) return directive;
	// First attempt, or a retry of one that has already been recorded as undelivered (#985): the
	// trace records the first and the one that finally lands, never every tick in between.
	const firstAttempt = !directive.deliveryAttemptedAt;
	const settle = async (ok: boolean, reason: string): Promise<SupervisorDirective> => {
		const noted = (await noteSupervisorDirectiveDelivery(env, directive, now, ok)) ?? directive;
		const delivered = !!noted.deliveredAt;
		if (firstAttempt || delivered) await traceDirectiveDispatch(env, uid, run, directive, { delivered, reason }, now);
		return noted;
	};
	const runtime = await getLiveRuntime(env, run.instanceId, uid).catch(() => null);
	if (!runtime) return settle(false, "runner_offline");
	try {
		const res = await callRuntime(env, runtime, LOCAL_APPLY_DIRECTIVE_PATH, {
			method: "POST",
			body: JSON.stringify({ runId: run.id, checkpointId: directive.checkpointId, schemaVersion: directive.schemaVersion, directive: directive.directive }),
		});
		return settle(res.ok, res.ok ? "acknowledged" : `runner_refused_${res.status}`);
	} catch {
		return settle(false, "runner_unreachable");
	}
}

/**
 * Why this machine must not fill an application yet, or null (#977, #989, #994).
 *
 * A runner capability changes only when a new CLI bundles it. #994 adds bounded post-submit
 * observation and SEEK's receipt vocabulary; the floor moves with that behaviour so an older
 * runner cannot silently report the old, opaque `submit_unconfirmed` state.
 *
 * The live regression this closes: #975's `bridge_unused` + diagnostic shipped and deployed, and a
 * real retry still recorded `blocked: incomplete` with `diagnostic: null` — because the connected
 * machine was running an older published CLI. An old runner does not fail loudly; it reports the
 * zero-bridge outcome in the PREVIOUS vocabulary, which is indistinguishable from a new-contract run
 * that had nothing to diagnose. Silent fallback to the older shape is the thing the issue forbids.
 *
 * So the cloud refuses before dispatch and says exactly what to do. An unreported version is not
 * judged — the convention `cliAtLeast` and every other MIN_CLI gate in this codebase follow, because
 * refusing on a fact we do not have is the worse failure.
 */
export function runnerContractProblem(runnerVersion: string | null | undefined, node: string | null | undefined): string | null {
	const version = runnerVersion?.trim();
	if (!version || cliAtLeast(version, LOCAL_APPLY_CONTRACT_MIN_CLI)) return null;
	return `The runner on ${node || "that machine"} is CLI ${version}, which predates this application contract (needs ${LOCAL_APPLY_CONTRACT_MIN_CLI} or newer): it cannot observe post-submit confirmation evidence or recognise SEEK's application-sent receipt, so a real submit can end as an opaque submit_unconfirmed state. Update it (npm i -g @proagentstore/cli, or runner_update) and restart \`pags up\`, then retry this application.`;
}

export type StartFillOutcome = { kind: "started" | "existing"; application: JobApplication; run: ApplyRun | null };

/** Move the application, re-reading it first — false when it is not where the move starts. */
async function move(env: Env, uid: string, applicationId: string, from: readonly string[], m: ApplicationMove, now: number): Promise<boolean> {
	const app = await getOwnedApplication(env, uid, applicationId);
	if (!app || !from.includes(app.status)) return false;
	return moveApplication(env, app, uid, m, now);
}

/**
 * Start filling one application — the ONE start path, for the connection action and the owner's
 * route. Throws 409 when this is not a Runner or the input is not a materials_ready event for one
 * of the owner's applications, and 503 when no runner is connected — before anything is recorded,
 * so the outbox retries.
 */
/** The gate's verdict for one application on one Runner — what dispatch uses and what the console previews (#958). */
export async function submitGateFor(
	env: Env,
	runnerInstanceId: string,
	uid: string,
	app: JobApplication,
	s: ApplicationRunnerSettings,
	now: number,
	/** See {@link applyRunCounts} — set only by the dequeue path (#993). */
	counting: { excludeRunId?: string; machineOnly?: boolean } = {},
) {
	const lead = (app.lead ?? {}) as { leadUrl?: string; lead?: { title?: string; company?: string; location?: string; match_rationale?: string } };
	const counts = await applyRunCounts(env, runnerInstanceId, uid, now, counting);
	// The owner's per-application approval (#973). Read here rather than passed in, so EVERY caller
	// of the gate — the queue rendering a card, a dispatch, a retry — sees the same verdict; a
	// surface that evaluated the gate without it would show the owner a different answer than the
	// one their approval actually produces.
	const auth = await getSubmitAuthorization(env, app.id, uid).catch(() => null);
	const approval = auth ? { id: auth.id, usable: approvalState(auth, app).usable } : null;
	const gate = evaluateSubmitGate({
		settings: s,
		approval,
		application: {
			profileVersion: app.profileVersion,
			resumeSha: app.resumeArtifact?.sha256 ?? null,
			coverLetterSha: app.coverLetterArtifact?.sha256 ?? null,
			blockReason: app.blockReason,
			submitAttemptedAt: app.submitAttemptedAt,
			leadUrl: str(lead.leadUrl),
			lead: lead.lead ?? {},
		},
		autoSubmitsToday: counts.autoSubmitsToday,
		activeRuns: counts.active,
	});
	return { ...gate, autoSubmitsToday: counts.autoSubmitsToday, dailyCap: s.autoSubmit.dailyCap, authorizationId: approval?.usable ? approval.id : null };
}

/** The Runner's effective settings, or why they cannot be used. */
export async function runnerSettingsFor(env: Env, runnerInstanceId: string, uid: string): Promise<ApplicationRunnerSettings> {
	const pair = await readInstanceConfigPair(env, runnerInstanceId, uid);
	const settings = effectiveRunnerSettings((pair?.config as Record<string, unknown> | undefined)?.[RUNNER_SETTINGS_KEY]);
	if ("error" in settings) throw new HttpError(409, `The Application Runner settings are invalid: ${settings.error}`);
	return settings.settings;
}

/**
 * The task the runner is sent, built from the run's OWN recorded policy (#974).
 *
 * One builder for the first dispatch and for a re-dispatch out of the queue: a second construction
 * of this envelope would be a second answer to "what was this run allowed to do", and the submit
 * mode and gate id live in it. Reading them off `run.policy` means a queued run that waits an hour
 * is dispatched as the decision that was recorded when the owner approved it.
 */
export function applyTaskEnvelope(run: ApplyRun, app: JobApplication, s: ApplicationRunnerSettings): LocalApplyTaskEnvelope {
	const lead = (app.lead ?? {}) as { leadUrl?: string; lead?: { title?: string; company?: string; location?: string } };
	return {
		type: LOCAL_APPLY_TASK_TYPE,
		runId: run.id,
		requestId: run.requestId,
		instanceId: run.instanceId,
		applicationId: run.applicationId,
		engine: s.engine,
		authMode: s.authMode,
		browserProfile: s.browserProfile,
		applicationUrl: str(lead.leadUrl),
		job: { title: str(lead.lead?.title) || "the job", ...(lead.lead?.company ? { company: lead.lead.company } : {}), ...(lead.lead?.location ? { location: lead.lead.location } : {}) },
		workspace: s.workspace,
		sources: (["profile", "answers"] as const).filter((r) => s.sources[r]).map((role) => ({ role, path: s.sources[role] as string })),
		artifacts: [app.resumeArtifact, app.coverLetterArtifact].filter((a): a is NonNullable<typeof a> => !!a).map((a) => ({ kind: a.kind, path: a.path, sha256: a.sha256 })),
		policy: { mode: run.policy.mode, allowDomains: run.policy.allowDomains, ...(run.policy.gate.gateId ? { submitGate: { gateId: run.policy.gate.gateId } } : {}) },
		limits: run.policy.limits,
	};
}

/**
 * `review: true` (#958 "Request review") pins the run to fill_and_review whatever the policy says:
 * the gate is still evaluated and recorded, with `review_requested` as a failing check.
 */
export async function startApplicationFill(env: Env, instanceId: string, uid: string, rawEvent: unknown, source: "connection" | "owner", opts: { review?: boolean } = {}): Promise<StartFillOutcome> {
	const caps = await capabilitiesForInstance(env, instanceId, uid);
	if (caps?.runtime !== "local_apply") throw new HttpError(409, notRunnerMessage(caps?.runtime));
	const ev = rawEvent && typeof rawEvent === "object" && !Array.isArray(rawEvent) ? (rawEvent as Record<string, unknown>) : null;
	const key = str(ev?.eventId).trim();
	const applicationId = str(ev?.applicationId).trim();
	if (!ev || !key || key.length > 300 || !applicationId) throw new HttpError(400, `Not a ${MATERIALS_READY_EVENT} event: eventId and applicationId are required.`);

	const existing = await getApplyRunByRequest(env, instanceId, uid, key);
	const app = await getOwnedApplication(env, uid, applicationId);
	// Everything about the application comes from the owner's own record, never from the payload.
	if (!app || app.instanceId !== str(ev.tailorInstanceId)) throw new HttpError(404, "That application does not exist, or is not one of yours.");
	if (existing) return { kind: "existing", application: app, run: existing };
	if (app.status !== "materials_ready") {
		const run = app.fillRunId ? await getApplyRun(env, instanceId, uid, app.fillRunId) : null;
		return { kind: "existing", application: app, run };
	}
	if (app.submitAttemptedAt) throw new HttpError(409, "A final submit was already attempted for this application; it will not be filled again automatically.");

	const s = await runnerSettingsFor(env, instanceId, uid);
	const lead = (app.lead ?? {}) as { leadUrl?: string; lead?: { title?: string; company?: string; location?: string; match_rationale?: string } };
	const leadUrl = str(lead.leadUrl);
	const jobHost = hostOfUrl(leadUrl);
	if (!jobHost) throw new HttpError(409, "The application's lead has no http(s) URL to apply at.");
	const runtime = await getLiveRuntime(env, instanceId, uid);
	if (!runtime) throw new HttpError(503, "No runner is connected. Run `pags up` on the machine that holds your job materials; the application will be filled when it connects.");
	// #977 — refused HERE, before the application leaves materials_ready and before a run row
	// exists, so an outdated machine costs the owner nothing and the application stays retryable.
	// 409 rather than 503: the outbox must not retry this on a loop, because only a person updating
	// the CLI can change the answer.
	const contractProblem = runnerContractProblem(runtime.runner_version, runtime.runner_node);
	if (contractProblem) throw new HttpError(409, contractProblem);

	const now = Date.now();
	const verdict = await submitGateFor(env, instanceId, uid, app, s, now);
	const gate = opts.review
		? { allowed: false, checks: [...verdict.checks, { check: "review_requested", ok: false, why: "the owner asked to review the filled form before anything is sent" }] }
		: { allowed: verdict.allowed, checks: verdict.checks };
	const runId = crypto.randomUUID();
	const intendedMode = gate.allowed ? "auto_submit" : "fill_and_review";

	// The application leaves materials_ready exactly once: the move IS the claim.
	const claimed = await moveApplication(env, app, uid, { to: "filling", actor: "runner", actorInstanceId: instanceId, runId, bindRun: runId, reason: intendedMode }, now);
	if (!claimed) {
		const fresh = (await getOwnedApplication(env, uid, applicationId)) ?? app;
		return { kind: "existing", application: fresh, run: fresh.fillRunId ? await getApplyRun(env, instanceId, uid, fresh.fillRunId) : null };
	}

	// Spend the owner's approval on THIS run, after the claim and before anything is built from the
	// verdict (#973). Conditional on it still being unspent, so two dispatches racing for one
	// approval cannot both proceed to submit — and the loser is DOWNGRADED here rather than after
	// the fact: `mode`, `gateId` and the recorded gate all derive from the outcome below, because
	// the envelope the runner receives is built from them. Mutating the stored policy afterwards
	// would have left the runner's own copy still saying `auto_submit`.
	const spentApproval = gate.allowed && verdict.authorizationId ? await consumeSubmitAuthorization(env, verdict.authorizationId, uid, runId, now) : null;
	const lostApprovalRace = gate.allowed && !!verdict.authorizationId && !spentApproval;
	const allowed = gate.allowed && !lostApprovalRace;
	const checks = lostApprovalRace
		? [...gate.checks, { check: "submission_approved", ok: false, why: "another run spent this application's approval first" }]
		: gate.checks;
	const gateId = allowed ? crypto.randomUUID() : null;
	const mode = allowed ? "auto_submit" : "fill_and_review";
	const policy: ApplyRunPolicy = {
		engine: s.engine,
		authMode: s.authMode,
		browserProfile: s.browserProfile,
		mode,
		allowDomains: [...new Set([jobHost, ...s.allowDomains])],
		limits: { maxMinutes: s.maxMinutes, maxPages: s.maxPages, maxActions: s.maxActions },
		gate: { allowed, gateId, checks },
	};
	const failing = checks.filter((c) => !c.ok).map((c) => c.check);
	const trace: ApplyTraceEvent[] = [
		{ type: "run.requested", at: iso(now), detail: { engine: s.engine, authMode: s.authMode, status: source } },
		{ type: "policy.submit_gate", at: iso(now), detail: { mode, decision: allowed ? "allowed" : "refused", ...(gateId ? { gateId } : { reason: failing.join(",").slice(0, 300) }) } },
	];
	if (spentApproval) trace.push({ type: "policy.decision", at: iso(now), detail: { class: "submit", decision: "allowed", basis: "application_approval", authorizationId: spentApproval.id } });
	if (lostApprovalRace) trace.push({ type: "policy.decision", at: iso(now), detail: { class: "submit", decision: "refused", reason: "approval_already_spent" } });
	// The version that actually executes this run, from the machine's own registration (#977) — an
	// old runner cannot annotate its result, so the fact has to be taken here.
	await insertApplyRun(env, { id: runId, instanceId, userId: uid, applicationId, requestId: key, policy, trace, now, runnerVersion: runtime.runner_version ?? null });
	let run = (await getApplyRun(env, instanceId, uid, runId)) as ApplyRun;

	const envelope = applyTaskEnvelope(run, app, s);
	const fail = async (errorCode: string, error: string) => {
		// The machine never took it, so nothing was sent and the approval goes back (#993).
		await releaseApprovalIfNothingWasSent(env, uid, run).catch(() => undefined);
		run = (await updateApplyRun(env, run, { to: "failed", errorCode, error, events: [{ type: "run.ended", at: iso(now), detail: { status: "failed", reason: errorCode } }] }, now)) ?? run;
		await move(env, uid, applicationId, ["filling"], { to: "blocked", actor: "system", actorInstanceId: instanceId, runId, expectRun: runId, reason: errorCode, questions: [error] }, now);
	};
	let res: Response | null = null;
	try {
		res = await callRuntime(env, runtime, LOCAL_APPLY_RUN_PATH, { method: "POST", body: JSON.stringify(envelope) });
	} catch (err) {
		await fail("runner_unreachable", `The runner did not answer: ${err instanceof Error ? err.message.slice(0, 300) : "unknown error"}`);
	}
	if (res) {
		const payload = (await runtimeJson(res)) as Record<string, unknown>;
		const refusal = res.ok ? { defer: false as const } : refusalVerdict({ status: res.status, error: typeof payload.error === "string" ? payload.error : undefined, code: typeof payload.code === "string" ? payload.code : undefined });
		if (res.status === 404) await fail("runner_unsupported", "The connected runner cannot fill applications yet. Update the CLI (npm i -g @proagentstore/cli) and run `pags up` again.");
		// The machine is busy with the owner's OTHER application, which is a WAIT, not a failure
		// (#974). The run stays `queued` — it already is the queue entry — and the per-minute sweep
		// dispatches it when the slot frees. Before this, five leads approved at once left one run
		// and four dead applications for the owner to retry by hand.
		else if (refusal.defer) await noteQueued(env, "local_apply_runs", runId, refusal.message, now);
		else if (!res.ok) await fail("runner_rejected", `The runner refused the run: ${typeof payload.error === "string" ? payload.error.slice(0, 500) : `HTTP ${res.status}`}`);
		else run = (await updateApplyRun(env, run, { to: "running", runnerNode: runtime.runner_node || null, events: [{ type: "runner.dispatched", at: iso(now), detail: { status: "running", mode } }] }, now)) ?? run;
		if (refusal.defer) run = (await getApplyRun(env, instanceId, uid, runId)) ?? run;
	}
	// #978: on the board the moment it starts, not when it ends.
	await syncApplicationCard(env, uid, run, "fill");
	return { kind: "started", application: (await getOwnedApplication(env, uid, applicationId)) as JobApplication, run };
}

/** Keep the deterministic submission gate when replaying a persisted runner result. */
function acceptedResult(run: ApplyRun, rawResult: unknown): LocalApplyResultEnvelope | null {
	const checked = parseLocalApplyResult(rawResult);
	if ("error" in checked || checked.result.runId !== run.id) return null;
	let r = checked.result;
	// A submit PAGS did not gate is not a submission PAGS records — whatever the runner says.
	if (r.outcome === "submitted" && (run.policy.mode !== "auto_submit" || r.submitted?.gateId !== run.policy.gate.gateId)) {
		r = { ...r, outcome: "blocked", blockReason: "submit_unconfirmed", questions: ["The runner reported a submission this run's policy did not permit. Check the employer's site before anything else is done."], submitted: undefined };
	}
	return r;
}

/** Project a typed, already-durable result onto the application. Safe to replay after a crash. */
async function reconcileResultOutcome(env: Env, uid: string, run: ApplyRun, r: LocalApplyResultEnvelope, now: number, replayOnly = false): Promise<void> {
	if (replayOnly) {
		const app = await getOwnedApplication(env, uid, run.applicationId);
		// The result was already projected (or the application moved on) if it no longer has the
		// in-flight state. Do not replay notifications/history on every scheduled sweep.
		if (app?.status !== "filling") return;
	}
	const attempted = run.trace.some((e) => e.type === "submit.attempted") || r.submitAttempted === true;
	if (attempted) await markSubmitAttempted(env, run.applicationId, uid, now);
	const base = { actor: "runner" as const, actorInstanceId: run.instanceId, runId: run.id, expectRun: run.id };
	const to = r.outcome;
	const unavailable = r.outcome === "blocked" && (r.blockReason as string | undefined) === "job_unavailable";
	// The contract carries structured evidence for this condition. Keep it opaque here: the
	// contract parser is the trust boundary, while this layer only persists and relays it.
	const unavailableEvidence = r.unavailable;
	const from = ["filling", "blocked"] as const;
	if (unavailable) {
		await move(env, uid, run.applicationId, from, {
			...base,
			to: "archived",
			reason: "job_unavailable",
			archiveReason: "job_unavailable",
			archiveEvidence: unavailableEvidence,
		}, now);
	} else if (to === "submitted" && r.submitted) await move(env, uid, run.applicationId, from, { ...base, to: "submitted", submitted: { at: r.submitted.at, url: r.submitted.url } }, now);
	else if (to === "awaiting_review") await move(env, uid, run.applicationId, from, { ...base, to: "awaiting_review" }, now);
	else if (to === "blocked") await move(env, uid, run.applicationId, from, { ...base, to: "blocked", reason: r.blockReason ?? "incomplete", questions: r.questions ?? [] }, now);
	else await move(env, uid, run.applicationId, from, { ...base, to: "failed", reason: r.engineAuth === "missing_login" ? "engine_not_signed_in" : "engine_failed" }, now);
	// #993: an `auto_submit` run that ended without asking the employer must not take the owner's
	// one-time approval with it. `review.ready` is the live case — the form was filled (or not even
	// that) and the run stopped for a human — and the retry the card offers is only a continuation
	// if the approval it needs still exists. Guarded inside on `submit.attempted`, so a run that
	// DID attempt stays spent and terminal.
	if (to !== "submitted") await releaseApprovalIfNothingWasSent(env, uid, run).catch(() => undefined);
	// #991: a run that stopped at something it may not do without the owner is WAITING on them, and
	// nothing told them. The first consumer of the generic owner-attention policy
	// (`lib/owner-attention.ts`) rather than an apply-specific push: the event is
	// `approval_required`, and any other agent raises the same one.
	if (to === "blocked" || to === "awaiting_review") await askForApprovalIfWaiting(env, uid, run).catch(() => undefined);
}

/** End a run's application from its result — result receipt precedes outcome projection. */
async function settleFromResult(env: Env, uid: string, run: ApplyRun, rawResult: unknown, now: number): Promise<ApplyRun> {
	const attempted = run.trace.some((e) => e.type === "submit.attempted") || (rawResult as { submitAttempted?: unknown } | null)?.submitAttempted === true;
	if (attempted) await markSubmitAttempted(env, run.applicationId, uid, now);
	const base = { actor: "runner" as const, actorInstanceId: run.instanceId, runId: run.id, expectRun: run.id };
	const r = acceptedResult(run, rawResult);
	if (!r) {
		const checked = parseLocalApplyResult(rawResult);
		const error = "error" in checked ? `The runner sent a result PAGS cannot accept: ${checked.error}` : "The runner's result names another run.";
		const failed = await updateApplyRun(env, run, { to: "failed", errorCode: "runner_result_invalid", error, pause: null, events: [{ type: "run.ended", at: iso(now), detail: { status: "failed", reason: "runner_result_invalid" } }] }, now);
		if (failed) await move(env, uid, run.applicationId, ["filling", "blocked"], { ...base, to: "blocked", reason: attempted ? "submit_state_unknown" : "runner_result_invalid", questions: [error] }, now);
		return failed ?? run;
	}
	const to = r.outcome;
	const moved = await updateApplyRun(
		env,
		run,
		{ to, pause: null, result: r, engineAuth: r.engineAuth, ...(to === "failed" ? { errorCode: "engine_failed", error: r.error ?? null } : {}), events: [{ type: "run.ended", at: iso(now), detail: { status: to, engineAuth: r.engineAuth, count: r.filled, ...(r.blockReason ? { reason: r.blockReason } : {}) } }] },
		now,
	);
	if (!moved) return run;
	await reconcileResultOutcome(env, uid, moved, r, now);
	return moved;
}

/**
 * How this consumer reaches the delivery stack (#991).
 *
 * Injected rather than imported inside `requestOwnerAttention` so the policy module stays testable
 * without the push stack, and so the push OUTCOME is read from the row that was written rather than
 * assumed: `notifyUser` is best-effort about the push by design, so "did it actually go" is a
 * question only the notifications table can answer.
 */
const attentionDeps: AttentionDeps<Env> = {
	notify: (env, userId, type, title, body, url, opts) => notifyUser(env, userId, type, title, body, url, opts),
	pushed: async (env, userId, ids) => {
		// Read the row that was just written, by the key the notifications table actually stores.
		// `pushed_at` is set when an interruption was RAISED, and an attention event is an `alert`,
		// which no per-type mute can suppress — so a null there means the 10-minute duplicate
		// window swallowed it, and that is the one case worth telling the owner apart.
		const row = await env.DB.prepare("SELECT pushed_at FROM notifications WHERE user_id = ?1 AND dedupe_key = ?2 ORDER BY created_at DESC LIMIT 1")
			.bind(userId, ids.dedupeKey)
			.first<{ pushed_at: string | null }>()
			.catch(() => null);
		if (!row) return "unavailable";
		if (!row.pushed_at) return "deduped";
		// An interruption was raised; whether a device received it depends on there being one. No
		// subscription means the owner has nothing to buzz, and saying "notified" would be the lie.
		const device = await env.DB.prepare("SELECT 1 FROM push_subscriptions WHERE user_id = ?1 LIMIT 1")
			.bind(userId)
			.first()
			.catch(() => null);
		return device ? "sent" : "unavailable";
	},
	preferences: async (env, userId) => {
		const row = await env.DB.prepare("SELECT preferences FROM users WHERE id = ?1").bind(userId).first<{ preferences: string | null }>();
		const prefs = parseAccountPreferences(row?.preferences);
		// `parseAccountPreferences` has already sanitized both sections — this is the stored account,
		// read through the one parser, not a second interpretation of the same JSON.
		return { notifications: prefs.notifications, attention: prefs.attention };
	},
};

/**
 * Tell the owner when an application is waiting for THEIR decision, and only then (#991).
 *
 * Raised from the one place that knows an application has just stopped, and gated on exactly the
 * rule that decides whether the approval action is reachable — `approvalStageOf` plus "no
 * authorization yet, nothing attempted". So the notification cannot say "approve this" in a state
 * where the Board, the queue and MCP do not offer an approval; that pairing is what #991 was filed
 * about, from the other direction.
 *
 * Best-effort and deliberately swallowed by the caller: a notification that fails must never fail
 * the settle that noticed. The in-app row is the log; the push outcome is reported truthfully by
 * `requestOwnerAttention` and is not asserted here.
 */
async function askForApprovalIfWaiting(env: Env, uid: string, run: ApplyRun): Promise<void> {
	const app = await getOwnedApplication(env, uid, run.applicationId);
	if (!app || app.submitAttemptedAt) return;
	// The run that just settled, passed in rather than re-read: a run belongs to a RUNNER instance
	// and the application row names the TAILOR's, so looking it up by `app.instanceId` finds
	// nothing — and a null context reads as "the fill ended", which would raise "approve to send"
	// over a run still paused on an unanswered question. The authority on this run is this run.
	const context = app.fillRunId === run.id ? { status: run.status, pauseReason: run.pause?.reason ?? null } : null;
	if (approvalStageOf(app, context) !== "post_fill") return;
	const existing = await getSubmitAuthorization(env, app.id, uid).catch(() => null);
	// Already approved: the owner has decided, and the thing to do next is a retry they can see.
	if (existing && approvalState(existing, app).usable) return;
	const lead = (app.lead ?? {}) as { lead?: { title?: unknown; company?: unknown } };
	const role = typeof lead.lead?.title === "string" ? lead.lead.title : "A job application";
	const company = typeof lead.lead?.company === "string" ? ` at ${lead.lead.company}` : "";
	// The Runner's own Board: the queue it shows is the same from every member of the pipeline, and
	// this is the instance the owner was just watching work.
	const runner = run.instanceId;
	await requestOwnerAttention(
		env,
		{
			event: "approval_required",
			userId: uid,
			instanceId: runner,
			subject: { kind: "application", instanceId: runner, applicationId: app.id },
			// The state is in the identity, so one stop is one notification however many times a sweep
			// re-reads it — and a stop AFTER the owner retries is a new one (#991's dedupe rule).
			about: { kind: "application", id: app.id, state: app.stateVersion },
			notificationType: "apply",
			title: `Approve to send: ${role}${company}`.slice(0, 120),
			// The owner's own sentence from the run. Marked rather than head-cut (#898): a shortened
			// question read as complete is how a person decides on half a condition.
			body: clipMarked(app.blockQuestions?.[0] ?? "This application is filled and waiting for your decision; nothing has been sent.", 300, { within: true }),
		},
		attentionDeps,
	);
}

/**
 * The runner lost the run. If it was allowed to submit, nobody can say whether it did — so the
 * application is marked as a possible submit and blocked, never left looking like it is safe to retry.
 */
async function endLost(env: Env, uid: string, run: ApplyRun, error: string, now: number): Promise<ApplyRun> {
	const unknown = run.policy.mode === "auto_submit";
	const failed = await updateApplyRun(env, run, { to: "failed", errorCode: "runner_lost", error, pause: null, events: [{ type: "run.ended", at: iso(now), detail: { status: "failed", reason: "runner_lost" } }] }, now);
	if (!failed) return run;
	if (unknown) await markSubmitAttempted(env, run.applicationId, uid, now);
	await move(
		env,
		uid,
		run.applicationId,
		["filling", "blocked"],
		{ actor: "system", actorInstanceId: run.instanceId, runId: run.id, expectRun: run.id, to: "blocked", reason: unknown ? "submit_state_unknown" : "runner_lost", questions: [unknown ? `${error} It was allowed to submit, so check the employer's site before anything is retried.` : error] },
		now,
	);
	return failed;
}

/**
 * The Runner is deliberately the browser/CLI executor, not the authority that can extend a run.
 * A responsive but wedged CLI used to keep advancing `last_synced_at` forever, so the Worker
 * never enforced the maxMinutes policy it dispatched.  The cloud owns this terminal decision:
 * give a just-finished structured result a chance to arrive, then stop the local task and leave
 * auto-submit runs conservative about whether a click may have happened.
 */
async function endTimedOut(env: Env, uid: string, run: ApplyRun, error: string, now: number): Promise<ApplyRun> {

	const unknown = run.policy.mode === "auto_submit";
	const failed = await updateApplyRun(
		env,
		run,
		{ to: "failed", errorCode: "run_timed_out", error, pause: null, events: [{ type: "run.ended", at: iso(now), detail: { status: "failed", reason: "run_timed_out" } }] },
		now,
	);
	if (!failed) return run;
	if (unknown) await markSubmitAttempted(env, run.applicationId, uid, now);
	await move(
		env,
		uid,
		run.applicationId,
		["filling", "blocked"],
		{
			actor: "system",
			actorInstanceId: run.instanceId,
			runId: run.id,
			expectRun: run.id,
			to: "blocked",
			reason: unknown ? "submit_state_unknown" : "run_timed_out",
			questions: [unknown ? `${error} This run was allowed to submit, so check the employer's site before anything is retried.` : error],
		},
		now,
	);
	return failed;
}

async function stopTimedOutRun(env: Env, runtime: Awaited<ReturnType<typeof getLiveRuntime>>, uid: string, run: ApplyRun, now: number): Promise<ApplyRun> {
	if (runtime) await callRuntime(env, runtime, LOCAL_APPLY_CANCEL_PATH, { method: "POST", body: JSON.stringify({ runId: run.id }) }).catch(() => undefined);
	return endTimedOut(env, uid, run, `The application exceeded its ${run.policy.limits.maxMinutes}-minute limit and PAGS stopped the local runner.`, now);
}

/** Bring one run up to date from its runner, mirroring a pause onto the application. */
export async function syncApplyRun(env: Env, uid: string, run: ApplyRun, now = Date.now()): Promise<ApplyRun> {
	// A run recorded but never handed over (the Worker died between the two) is not left queued forever.
	if (run.status === "queued") return now - run.createdAt > LOST_RUNNER_GRACE_MS ? endLost(env, uid, run, "The run was never handed to the runner.", now) : run;
	if (run.status !== "running" && run.status !== "paused") {
		// Receipt is intentionally separate from projection. If a Worker stopped after saving the
		// runner's typed result but before its application CAS, the scheduled sweep replays only this
		// deterministic projection — it never contacts the runner or repeats browser work.
		const result = run.result === null ? null : acceptedResult(run, run.result);
		if (result) {
			await reconcileResultOutcome(env, uid, run, result, now, true);
			await syncApplicationCard(env, uid, run, "fill");
		}
		return run;
	}
	const startedAt = run.startedAt ?? run.createdAt;
	const timeLimitReached = run.status === "running" && now - startedAt >= run.policy.limits.maxMinutes * 60_000;
	const silentSince = run.lastSyncedAt ?? startedAt;
	const lostByTime = run.status === "running" ? now - silentSince > run.policy.limits.maxMinutes * 60_000 + LOST_RUNNER_GRACE_MS : now - silentSince > PAUSED_RUNNER_GRACE_MS;
	const runtime = await getLiveRuntime(env, run.instanceId, uid).catch(() => null);
	if (!runtime) {
		if (timeLimitReached) return stopTimedOutRun(env, null, uid, run, now);
		return lostByTime ? endLost(env, uid, run, "The runner went offline during the application and did not come back in time.", now) : run;
	}
	let res: Response;
	try {
		res = await callRuntime(env, runtime, LOCAL_APPLY_STATUS_PATH, { method: "POST", body: JSON.stringify({ runId: run.id, afterSeq: run.runnerSeq }) });
	} catch {
		return timeLimitReached ? stopTimedOutRun(env, runtime, uid, run, now) : run;
	}
	if (res.status === 404) return endLost(env, uid, run, "The runner no longer holds this run — it was restarted or updated.", now);
	if (!res.ok) {
		if (timeLimitReached) return stopTimedOutRun(env, runtime, uid, run, now);
		return lostByTime ? endLost(env, uid, run, "The runner stopped answering for this run.", now) : run;
	}
	const body = (await runtimeJson(res)) as { state?: unknown; pause?: unknown; events?: unknown; lastSeq?: unknown; result?: unknown };
	const events = (Array.isArray(body.events) ? body.events : []).map(parseLocalApplyEvent).filter((e): e is NonNullable<typeof e> => e !== null) as ApplyTraceEvent[];
	const lastSeq = typeof body.lastSeq === "number" && body.lastSeq >= run.runnerSeq ? body.lastSeq : run.runnerSeq;
	// A submit attempt is recorded the moment PAGS sees it, before anything else can go wrong.
	if (events.some((e) => e.type === "submit.attempted")) await markSubmitAttempted(env, run.applicationId, uid, now);

	const p = body.pause && typeof body.pause === "object" ? (body.pause as Record<string, unknown>) : null;
	const rawCheckpoint = p?.checkpoint && typeof p.checkpoint === "object" && !Array.isArray(p.checkpoint) ? (p.checkpoint as Record<string, unknown>) : null;
	const checkpointFacts = rawCheckpoint ? sanitizeSupervisorFacts(rawCheckpoint.facts) : null;
	const checkpoint = rawCheckpoint && rawCheckpoint.schemaVersion === 1 && typeof rawCheckpoint.checkpointId === "string" && checkpointFacts
		? { schemaVersion: 1 as const, checkpointId: rawCheckpoint.checkpointId, facts: checkpointFacts }
		: null;
	const pause: LocalApplyPause | null =
		body.state === "paused" && p && LOCAL_APPLY_PAUSE_REASONS.includes(p.reason as never)
			? {
				reason: p.reason as LocalApplyPause["reason"],
				...(typeof p.url === "string" ? { url: p.url.slice(0, 2000) } : {}),
				...(typeof p.domain === "string" ? { domain: p.domain.slice(0, 253) } : {}),
				...(typeof p.question === "string" ? { question: p.question.slice(0, 300) } : {}),
				...(p.reason === "supervisor_checkpoint" && checkpoint ? { checkpoint } : {}),
			}
			: null;
	// Receipt is durable before a cloud brain can see the pause. The checkpoint has no prose or
	// form values — only runner-derived facts validated by `sanitizeSupervisorFacts` above.
	if (pause?.reason === "supervisor_checkpoint" && pause.checkpoint) {
		await receiveSupervisorCheckpoint(env, run, uid, { ...pause.checkpoint, runnerSeq: lastSeq }, now);
	}
	const to = body.state === "paused" && pause ? "paused" : body.state === "running" ? "running" : run.status;
	let current = (await updateApplyRun(env, run, { to, events, runnerSeq: lastSeq, ...(to !== run.status || to === "paused" ? { pause: to === "paused" ? pause : null } : {}) }, now)) ?? (await getApplyRun(env, run.instanceId, uid, run.id)) ?? run;
	const base = { actor: "runner" as const, actorInstanceId: run.instanceId, runId: run.id, expectRun: run.id };
	if (current.status === "paused" && run.status !== "paused" && pause) {
		await move(env, uid, run.applicationId, ["filling"], { ...base, to: "blocked", reason: pause.reason, questions: pause.question ? [pause.question] : [] }, now);
	} else if (current.status === "running" && run.status === "paused") {
		await move(env, uid, run.applicationId, ["blocked"], { ...base, to: "filling", reason: "resumed" }, now);
	}
	if (body.state === "ended" && body.result !== undefined && !isTerminalApplyRun(current.status)) current = await settleFromResult(env, uid, current, body.result, now);
	// A result is authoritative if it arrived at the deadline.  Otherwise a still-running CLI
	// cannot turn status polling into an unbounded lease; PAGS stops and settles it itself.
	if (timeLimitReached && current.status === "running") current = await stopTimedOutRun(env, runtime, uid, current, now);
	// Delivery is deliberately best-effort: the directive was persisted first. A later pull retries
	// an unacknowledged directive with exactly the same checkpoint and decision.
	if (current.status === "paused" && current.pause?.reason === "supervisor_checkpoint") {
		let runnerStateMayHaveChanged = false;
		for (const checkpoint of await listSupervisorCheckpoints(env, current)) {
			// This is the existing Runner instance's brain, not a second agent: its only authority is
			// the durable directive for this exact checkpoint. A retry sees the same row and relays it.
			const directive = checkpoint.directive ?? await directApplicationCheckpoint(env, uid, current, checkpoint, now);
			if (directive && !directive.deliveredAt) {
				const delivered = await deliverSupervisorDirective(env, uid, current, directive, now);
				runnerStateMayHaveChanged ||= !!delivered.deliveredAt;
			}
		}
		// `continue`, `request_review` and `stop` all change the local runtime synchronously. Pull
		// once more so this API read does not return a stale `paused` application for another minute.
		// RE-READ before re-entering. `updateApplyRun` writes the trace wholesale from the run object
		// it is handed, so passing this stale `current` would silently drop anything the loop above
		// just wrote — including the checkpoint decision's own rationale (#982).
		if (runnerStateMayHaveChanged) return syncApplyRun(env, uid, (await getApplyRun(env, current.instanceId, uid, current.id)) ?? current, now);
	}
	// #978 — the card follows the run through every transition this function makes: running, the
	// checkpoint pause (with the checkpoint and its directive, which is what the board shows as
	// "awaiting review"), and each terminal outcome. One choke point, because every runner-reported
	// change comes through here; wiring the individual settle paths is how a stale card happens.
	const cardCheckpoint = current.status === "paused" && current.pause?.reason === "supervisor_checkpoint"
		? (await listSupervisorCheckpoints(env, current).catch(() => []))
				.map((c) => ({ checkpointId: c.checkpointId, phase: c.facts.phase, directive: c.directive?.directive ?? null }))
				.at(-1) ?? null
		: null;
	await syncApplicationCard(env, uid, current, "fill", { checkpoint: cardCheckpoint });
	return current;
}

/** The owner handled the pause: send their answers / newly allowed sites, release the run, read it back. */
export async function resumeApplyRun(env: Env, uid: string, run: ApplyRun, body: unknown, now = Date.now()): Promise<ApplyRun> {
	if (run.status !== "paused") throw new HttpError(409, `Only a paused run can be resumed; this one is ${run.status}`);
	const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
	// Refused, not cut: a truncated answer would be grounding the owner never wrote.
	const rawAnswers = Array.isArray(b.answers) ? b.answers : [];
	const answers = rawAnswers.filter((a): a is { question: string; answer: string } => !!a && typeof a === "object" && typeof (a as Record<string, unknown>).question === "string" && typeof (a as Record<string, unknown>).answer === "string");
	if (answers.length !== rawAnswers.length || answers.length > 20 || answers.some((a) => a.question.length > 300 || a.answer.length > 2000)) {
		throw new HttpError(400, "answers must be up to 20 { question (≤300 chars), answer (≤2000 chars) } objects");
	}
	const rawDomains = Array.isArray(b.allowDomains) ? b.allowDomains : [];
	const allowDomains = rawDomains.map((d) => (typeof d === "string" ? hostOfUrl(`https://${d}`) : null));
	if (rawDomains.length > 10 || allowDomains.some((d) => !d)) throw new HttpError(400, "allowDomains must be up to 10 hostnames");
	const runtime = await getLiveRuntime(env, run.instanceId, uid).catch(() => null);
	if (!runtime) throw new HttpError(409, "No runner is connected. Run `pags up` on that machine, then resume.");
	const res = await callRuntime(env, runtime, LOCAL_APPLY_RESUME_PATH, { method: "POST", body: JSON.stringify({ runId: run.id, answers, allowDomains: allowDomains as string[] }) }).catch(() => null);
	if (!res) throw new HttpError(409, "The runner did not answer. Check `pags up` on that machine and try again.");
	if (res.status === 404) return endLost(env, uid, run, "The runner no longer holds this run — it was restarted or updated.", now);
	if (!res.ok) throw new HttpError(409, `The runner refused to resume: HTTP ${res.status}`);
	return syncApplyRun(env, uid, (await getApplyRun(env, run.instanceId, uid, run.id)) ?? run, now);
}

/** Stop the run. Touches PAGS records and the local CLI only — nothing on the employer's site. */
export async function cancelApplyRun(env: Env, uid: string, run: ApplyRun, now = Date.now()): Promise<ApplyRun> {
	if (isTerminalApplyRun(run.status)) throw new HttpError(409, `The run has already ended (${run.status})`);
	const runtime = await getLiveRuntime(env, run.instanceId, uid).catch(() => null);
	if (runtime) await callRuntime(env, runtime, LOCAL_APPLY_CANCEL_PATH, { method: "POST", body: JSON.stringify({ runId: run.id }) }).catch(() => null);
	const cancelled = await updateApplyRun(env, run, { to: "cancelled", errorCode: "cancelled", error: "Cancelled by the owner", pause: null, events: [{ type: "run.ended", at: iso(now), detail: { status: "cancelled" } }] }, now);
	if (!cancelled) throw new HttpError(409, "The run changed while cancelling — reload it.");
	await move(env, uid, run.applicationId, ["filling", "blocked"], { actor: "owner", actorInstanceId: run.instanceId, runId: run.id, expectRun: run.id, to: "blocked", reason: "cancelled_by_owner", questions: ["You cancelled this application run."] }, now);
	return cancelled;
}

/**
 * Retry a fill that stopped (#958): blocked or failed after a fill run, and NEVER after any submit
 * attempt. The application goes back to `materials_ready` (audited), and a fresh run starts under a
 * per-attempt key, so a repeated click finds the run it started.
 */
export async function retryFill(env: Env, runnerInstanceId: string, uid: string, app: JobApplication, opts: { review?: boolean } = {}): Promise<StartFillOutcome> {
	// `awaiting_review` joined the list at #981, and it is the one the whole ticket turns on: that
	// application's run STOPPED, nothing was sent, and the browser session that held its filled form
	// is gone — so a fresh run is the only way to carry the owner's approval to the employer. It is
	// as safe as the other two for the same reason: the guard below refuses any application that has
	// already attempted a submit, and the approval it spends is single-use.
	if (!app.fillRunId || !["blocked", "failed", "awaiting_review"].includes(app.status)) throw new HttpError(409, `A fill can be retried only after a fill run stopped; this application is ${app.status}${app.fillRunId ? "" : " and has not been filled"}.`);
	if (app.submitAttemptedAt) throw new HttpError(409, "A final submit was already attempted for this application; it will not be filled again. Check the employer's site.");
	const ready = app.readyEvent as { eventId?: unknown } | null;
	if (!ready || typeof ready.eventId !== "string") throw new HttpError(409, "The application has no materials_ready event to fill from.");
	const moved = await moveApplication(env, app, uid, { to: "materials_ready", actor: "owner", actorInstanceId: runnerInstanceId, reason: "retry_fill" }, Date.now());
	if (!moved) throw new HttpError(409, "The application changed while retrying — reload it.");
	return startApplicationFill(env, runnerInstanceId, uid, { eventId: `${ready.eventId}:retry:${app.stateVersion + 1}`, applicationId: app.id, tailorInstanceId: app.instanceId }, "owner", opts);
}

/**
 * Dispatch this Runner's next queued fill, if its machine slot is free and the wait is up (#974).
 *
 * Returns what happened, so a sweep can report it. The claim comes BEFORE the machine is asked
 * (`claimQueuedDispatch` is conditional on the attempt count), so two sweeps overlapping on one
 * instance cannot both dispatch the same run — and a dispatch that dies mid-flight leaves the row
 * due again later rather than claimed forever.
 *
 * Attempts are bounded: a machine that never frees settles the application as blocked, with the
 * reason the owner can act on, instead of waiting in silence for ever.
 */
export async function dispatchNextQueuedFill(env: Env, instanceId: string, uid: string, now = Date.now()): Promise<"dispatched" | "queued" | "idle" | "exhausted"> {
	const next = await nextDueQueuedRun(env, "local_apply_runs", instanceId, uid, now);
	if (!next) return "idle";
	const run = await getApplyRun(env, instanceId, uid, next.id);
	const app = await getOwnedApplication(env, uid, next.applicationId);
	if (!run || !app) return "idle";
	if (next.attempts >= QUEUE_MAX_ATTEMPTS) {
		await releaseApprovalIfNothingWasSent(env, uid, run).catch(() => undefined);
		const failed = await updateApplyRun(env, run, { to: "failed", errorCode: "runner_busy", error: `The machine never freed up for this application after ${next.attempts} attempts.`, events: [{ type: "run.ended", at: iso(now), detail: { status: "failed", reason: "runner_busy" } }] }, now);
		if (failed) await move(env, uid, run.applicationId, ["filling"], { to: "blocked", actor: "system", actorInstanceId: instanceId, runId: run.id, expectRun: run.id, reason: "runner_busy", questions: ["Your machine stayed busy. Retry this application when a run has finished."] }, now);
		return "exhausted";
	}
	if (!(await claimQueuedDispatch(env, "local_apply_runs", next, now))) return "queued";
	const runtime = await getLiveRuntime(env, instanceId, uid).catch(() => null);
	if (!runtime) {
		await noteQueued(env, "local_apply_runs", run.id, "No runner is connected — run `pags up` on the machine that holds your job materials.", now);
		return "queued";
	}
	const s = await runnerSettingsFor(env, instanceId, uid).catch(() => null);
	if (!s) return "queued";
	// #993: the mode is decided HERE, not when the run was queued. `dispatched` is the run whose
	// envelope the machine receives, so the policy it carries and the policy stored on the row are
	// the same object — the property `settleFromResult` relies on when it checks a reported submit
	// against `run.policy.gate.gateId`.
	// #993: the mode is decided HERE, not when the run was queued. The queue has already proven no
	// run holds the machine (`nextDueQueuedRun`) and a run must not count itself — without both,
	// `concurrency` refuses for ever. See `approval-at-dispatch.ts` for the rest.
	const { run: dispatched, upgraded } = await upgradeQueuedRunPolicy(
		env,
		uid,
		run,
		() => submitGateFor(env, instanceId, uid, app, s, now, { excludeRunId: run.id, machineOnly: true }),
		now,
	).catch(() => ({ run, upgraded: false }));
	let res: Response | null = null;
	try {
		res = await callRuntime(env, runtime, LOCAL_APPLY_RUN_PATH, { method: "POST", body: JSON.stringify(applyTaskEnvelope(dispatched, app, s)) });
	} catch {
		await noteQueued(env, "local_apply_runs", run.id, "The runner did not answer; waiting to try again.", now);
		return "queued";
	}
	const payload = (await runtimeJson(res)) as Record<string, unknown>;
	if (res.ok) {
		await updateApplyRun(env, dispatched, { to: "running", runnerNode: runtime.runner_node || null, events: [{ type: "runner.dispatched", at: iso(now), detail: { status: "running", mode: dispatched.policy.mode, from: "queue" } }] }, now);
		return "dispatched";
	}
	const refusal = refusalVerdict({ status: res.status, error: typeof payload.error === "string" ? payload.error : undefined, code: typeof payload.code === "string" ? payload.code : undefined });
	if (refusal.defer) {
		// Still waiting. Hand back only an approval THIS attempt just claimed for an upgrade: the
		// run goes back in line and the next attempt re-earns it. A run that has been `auto_submit`
		// since an earlier attempt keeps both its mode and the approval behind it (#993).
		if (upgraded) await releaseApprovalIfNothingWasSent(env, uid, dispatched).catch(() => undefined);
		await noteQueued(env, "local_apply_runs", run.id, refusal.message, now);
		return "queued";
	}
	// A refusal that is NOT a wait ends the run, exactly as the first dispatch would have.
	await releaseApprovalIfNothingWasSent(env, uid, dispatched).catch(() => undefined);
	const failed = await updateApplyRun(env, dispatched, { to: "failed", errorCode: "runner_rejected", error: `The runner refused the run: ${typeof payload.error === "string" ? payload.error.slice(0, 500) : `HTTP ${res.status}`}`, events: [{ type: "run.ended", at: iso(now), detail: { status: "failed", reason: "runner_rejected" } }] }, now);
	if (failed) await move(env, uid, run.applicationId, ["filling"], { to: "blocked", actor: "system", actorInstanceId: instanceId, runId: run.id, expectRun: run.id, reason: "runner_rejected", questions: [typeof payload.error === "string" ? payload.error.slice(0, 300) : `HTTP ${res.status}`] }, now);
	return "exhausted";
}

export async function syncActiveApplyRuns(env: Env, limit = 25): Promise<number> {
	const now = Date.now();
	let synced = 0;
	for (const r of await activeApplyRuns(env, limit)) {
		const run = await getApplyRun(env, r.instanceId, r.userId, r.id);
		if (!run) continue;
		await syncApplyRun(env, r.userId, run, now).catch(() => undefined);
		synced++;
	}
	// Then move the line along (#974). AFTER the pulls above, so a run that just ended has already
	// released the machine slot in this same tick and the next queued application starts now rather
	// than a minute later. Each instance is independent: one that cannot dispatch must not stop the rest.
	for (const i of await instancesWithQueuedRuns(env, "local_apply_runs", limit)) {
		await dispatchNextQueuedFill(env, i.instanceId, i.userId, now).catch(() => undefined);
	}
	return synced;
}
