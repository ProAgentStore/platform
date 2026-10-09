/**
 * The Application Tailor (#956): approved lead → tailored résumé + cover letter on the owner's
 * machine → `job.application.materials_ready`, exactly once.
 *
 *   job.lead.apply_requested (#955, via the connection outbox)
 *     → startTailoring: claim the application on the event id (replay = the same record),
 *       dispatch `local_artifact.generate` to the owner's runner
 *     → syncTailorRun (on read + per-minute cron): pull the runner's events and result
 *     → settleApplication (compare-and-set out of `tailoring`, ready event written WITH it)
 *     → emitReady: the ready event into the outbox, keyed on its own id, so a repeat collapses.
 *
 * The API owns state; the runner holds nothing but the task. Not `JOB_APPLY` (a PAGS-brain
 * workflow), not `runtime: coding`: its own runtime, `local_artifact`, its own task and tables.
 */
import { HttpError } from "../auth.js";
import { syncApplicationCard } from "../applications/application-board.js";
import { workKeyForLead } from "../job-lead-triage.js";
import { claimQueuedDispatch, instancesWithQueuedRuns, nextDueQueuedRun, noteQueued } from "../applications/work-queue-store.js";
import { QUEUE_MAX_ATTEMPTS, refusalVerdict } from "../applications/work-queue.js";
import { moveApplication } from "../local-apply/store.js";
import { capabilitiesForInstance } from "../agent-capabilities.js";
import { deliverEvent } from "../connections.js";
import { readInstanceConfigPair } from "../instance-config.js";
import type { Env } from "../../types.js";
import { callRuntime, getLiveRuntime, runtimeJson } from "../../routes/instances-runtime.js";
import {
	LOCAL_ARTIFACT_CANCEL_PATH,
	LOCAL_ARTIFACT_RUN_PATH,
	LOCAL_ARTIFACT_STATUS_PATH,
	LOCAL_ARTIFACT_TASK_TYPE,
	MATERIALS_READY_EVENT,
	type LocalArtifactLead,
	type LocalArtifactTaskEnvelope,
	parseLocalArtifactEvent,
	parseLocalArtifactLead,
	parseLocalArtifactResult,
} from "./contract.js";
import {
	type ApplicationTailorSettings,
	type JobApplication,
	TAILOR_SETTINGS_KEY,
	type TailorRun,
	type TailorRunPolicy,
	type TraceEvent,
	activeTailorRuns,
	claimApplication,
	createTailorRun,
	effectiveTailorSettings,
	getApplication,
	getApplicationByKey,
	getApplicationByWorkKey,
	getTailorRun,
	isTerminalRun,
	markReadyEmitted,
	settleApplication,
	sourcesOf,
	unemittedReadyApplications,
	updateTailorRun,
} from "./store.js";

/** How long past its own time limit a run may go unheard from before PAGS stops waiting. */
export const LOST_RUNNER_GRACE_MS = 10 * 60_000;

export function notTailorMessage(runtime: string | null | undefined): string {
	return `This agent is not an Application Tailor (its capabilities.runtime is ${runtime ? `"${runtime}"` : "null"}). The creator declares capabilities.runtime "local_artifact" to enable it.`;
}

/** The `job.application.materials_ready` envelope — handles and hashes, never content. */
export interface MaterialsReadyEvent {
	eventType: typeof MATERIALS_READY_EVENT;
	eventId: string;
	applicationId: string;
	tailorInstanceId: string;
	sourceInstanceId: string;
	leadId: string;
	leadUrl: string;
	lifecycleVersion: number;
	leadEventId: string;
	tailoringRunId: string;
	profileVersion: string | null;
	generatedAt: string;
	artifacts: { resume: unknown; coverLetter: unknown };
	lead: LocalArtifactLead["lead"];
}

const iso = (now: number) => new Date(now).toISOString();
const str = (v: unknown) => (typeof v === "string" ? v : "");

export type StartTailoringOutcome = { kind: "started" | "existing" | "blocked"; application: JobApplication; run: TailorRun | null };

/**
 * Start tailoring for one approved lead — the ONE start path, for the connection action and the
 * owner's route alike. Replay-safe: the application is keyed on the lead event's id, so the same
 * event (an outbox retry, a replayed dead letter, a double click) returns what already exists.
 *
 * Throws 409 when this is not a tailor agent or the input is not a lead event at all, and 503 when
 * no runner is connected — BEFORE anything is recorded, so a connection delivery is retried by the
 * outbox's backoff rather than parking an application nobody can run.
 */
export async function startTailoring(env: Env, instanceId: string, uid: string, rawEvent: unknown, source: "connection" | "owner"): Promise<StartTailoringOutcome> {
	const caps = await capabilitiesForInstance(env, instanceId, uid);
	if (caps?.runtime !== "local_artifact") throw new HttpError(409, notTailorMessage(caps?.runtime));
	const raw = rawEvent && typeof rawEvent === "object" && !Array.isArray(rawEvent) ? (rawEvent as Record<string, unknown>) : null;
	const key = str(raw?.eventId).trim();
	if (!raw || !key || key.length > 300) throw new HttpError(400, "Not an approved lead: a job.lead.apply_requested event with an eventId is required.");

	const existing = await getApplicationByKey(env, instanceId, uid, key);
	if (existing) return { kind: "existing", application: existing, run: existing.tailoringRunId ? await getTailorRun(env, instanceId, uid, existing.tailoringRunId) : null };

	const now = Date.now();
	const parsed = parseLocalArtifactLead(raw);
	const base = {
		id: crypto.randomUUID(),
		instanceId,
		userId: uid,
		sourceInstanceId: str(raw.sourceInstanceId).slice(0, 100),
		leadId: str(raw.leadId).slice(0, 100),
		lifecycleVersion: typeof raw.lifecycleVersion === "number" && Number.isInteger(raw.lifecycleVersion) ? raw.lifecycleVersion : 0,
		key,
		now,
	};
	// A malformed lead pauses: recorded, visible, never sent to a CLI to guess around.
	if ("error" in parsed) {
		const claim = await claimApplication(env, { ...base, lead: raw, status: "blocked", blockReason: "malformed_lead", blockQuestions: [`The approved lead could not be read: ${parsed.error}. Re-approve it from the Scout.`] });
		return { kind: claim.created ? "blocked" : "existing", application: claim.app, run: null };
	}
	const lead = parsed.lead;
	// The event id protects a delivery replay.  The stable key protects a different
	// source event for the same posting, without crossing into another owner's instance.
	// Legacy handoffs are derivable from their canonical URL; a lead with neither is
	// blocked rather than starting a second, unidentifiable piece of work.
	const workKey = lead.workKey ?? workKeyForLead({
		url: lead.leadUrl || lead.lead.url,
		source: lead.lead.source,
	});
	if (!workKey) {
		const claim = await claimApplication(env, {
			...base,
			lead,
			status: "blocked",
			blockReason: "unverifiable_lead",
			blockQuestions: ["This lead has no stable, canonical posting identity. Validate the live job page before requesting materials."],
		});
		return { kind: claim.created ? "blocked" : "existing", application: claim.app, run: null };
	}
	// Return the existing durable work item before inspecting settings or a local runtime. This is
	// both the normal duplicate fast path and the observable guarantee that a duplicate event
	// cannot reset its status/evidence or create another runtime task.
	const existingWork = await getApplicationByWorkKey(env, instanceId, uid, workKey);
	if (existingWork) return { kind: "existing", application: existingWork, run: existingWork.tailoringRunId ? await getTailorRun(env, instanceId, uid, existingWork.tailoringRunId) : null };
	const pair = await readInstanceConfigPair(env, instanceId, uid);
	const settings = effectiveTailorSettings((pair?.config as Record<string, unknown> | undefined)?.[TAILOR_SETTINGS_KEY]);
	if ("error" in settings) {
		const claim = await claimApplication(env, { ...base, workKey, lead, status: "blocked", blockReason: "settings_invalid", blockQuestions: [`The Application Tailor settings are invalid: ${settings.error}. Fix them, then retry.`] });
		return { kind: claim.created ? "blocked" : "existing", application: claim.app, run: null };
	}
	const runtime = await getLiveRuntime(env, instanceId, uid);
	if (!runtime) throw new HttpError(503, "No runner is connected. Run `pags up` on the machine that holds your job materials; the lead will be tailored when it connects.");

	const claim = await claimApplication(env, { ...base, workKey, lead, status: "tailoring" });
	if (!claim.created) return { kind: "existing", application: claim.app, run: claim.app.tailoringRunId ? await getTailorRun(env, instanceId, uid, claim.app.tailoringRunId) : null };
	const run = await dispatchTailoring(env, instanceId, uid, claim.app.id, lead, settings.settings, key, source, runtime, now);
	return { kind: "started", application: (await getApplication(env, instanceId, uid, claim.app.id)) as JobApplication, run };
}

type LiveRuntime = NonNullable<Awaited<ReturnType<typeof getLiveRuntime>>>;

/**
 * Record a tailoring run for an application already in `tailoring`, and hand it to the runner.
 * `requestId` is the run's idempotency key on the runner — the lead event id for the first run,
 * a per-attempt key for a retry (#958).
 */
async function dispatchTailoring(
	env: Env,
	instanceId: string,
	uid: string,
	applicationId: string,
	lead: LocalArtifactLead,
	s: ApplicationTailorSettings,
	requestId: string,
	source: string,
	runtime: LiveRuntime,
	now: number,
): Promise<TailorRun> {
	const policy: TailorRunPolicy = { engine: s.engine, authMode: s.authMode, workspace: s.workspace, sources: sourcesOf(s), retainDays: s.retainDays, maxMinutes: s.maxMinutes };
	const runId = crypto.randomUUID();
	await createTailorRun(env, {
		id: runId,
		instanceId,
		userId: uid,
		applicationId,
		requestId,
		policy,
		trace: [{ type: "run.requested", at: iso(now), detail: { engine: s.engine, authMode: s.authMode, status: source } }],
		now,
	});
	let run = (await getTailorRun(env, instanceId, uid, runId)) as TailorRun;
	const envelope = tailorTaskEnvelope(run, lead, s);
	const fail = async (errorCode: string, error: string) => {
		run = (await updateTailorRun(env, run, { to: "failed", errorCode, error, events: [{ type: "run.ended", at: iso(now), detail: { status: "failed", reason: errorCode } }] }, now)) ?? run;
		await settleApplication(env, instanceId, uid, applicationId, runId, { to: "blocked", blockReason: errorCode, blockQuestions: [error] }, now);
	};
	let res: Response | null = null;
	try {
		res = await callRuntime(env, runtime, LOCAL_ARTIFACT_RUN_PATH, { method: "POST", body: JSON.stringify(envelope) });
	} catch (err) {
		await fail("runner_unreachable", `The runner did not answer: ${err instanceof Error ? err.message.slice(0, 300) : "unknown error"}`);
	}
	if (res) {
		const payload = (await runtimeJson(res)) as Record<string, unknown>;
		const refusal = res.ok ? { defer: false as const } : refusalVerdict({ status: res.status, error: typeof payload.error === "string" ? payload.error : undefined, code: typeof payload.code === "string" ? payload.code : undefined });
		if (res.status === 404) await fail("runner_unsupported", "The connected runner does not support the Application Tailor yet. Update the CLI (npm i -g @proagentstore/cli) and run `pags up` again.");
		// Busy is a WAIT (#974): the run stays `queued` and the sweep dispatches it when the machine's
		// one tailoring slot frees. This is the exact production failure — five approved leads, one
		// run, and four applications terminally `runner_rejected`.
		else if (refusal.defer) await noteQueued(env, "local_artifact_runs", runId, refusal.message, now);
		else if (!res.ok) await fail("runner_rejected", `The runner refused the run: ${typeof payload.error === "string" ? payload.error.slice(0, 500) : `HTTP ${res.status}`}`);
		else run = (await updateTailorRun(env, run, { to: "running", runnerNode: runtime.runner_node || null, events: [{ type: "runner.dispatched", at: iso(now), detail: { status: "running" } }] }, now)) ?? run;
		if (refusal.defer) run = (await getTailorRun(env, instanceId, uid, runId)) ?? run;
	}
	await syncApplicationCard(env, uid, run, "tailor");
	return run;
}

/**
 * Retry tailoring for an application whose tailoring ended without materials (#958) — blocked,
 * failed or cancelled, never filled, never submitted. Compare-and-set back into `tailoring` (with an
 * audit row), then a fresh run under a per-attempt key, so a repeated click finds the same run.
 */
export async function retryTailoring(env: Env, instanceId: string, uid: string, app: JobApplication, now = Date.now()): Promise<{ application: JobApplication; run: TailorRun }> {
	if (!["blocked", "failed", "cancelled"].includes(app.status) || app.fillRunId || app.submitAttemptedAt) {
		throw new HttpError(409, `Tailoring can be retried only for an application that stopped while tailoring; this one is ${app.status}${app.fillRunId ? " and has been filled" : ""}.`);
	}
	const parsed = parseLocalArtifactLead(app.lead);
	if ("error" in parsed) throw new HttpError(409, `The application's lead cannot be read (${parsed.error}); re-approve it from the Scout.`);
	const pair = await readInstanceConfigPair(env, instanceId, uid);
	const settings = effectiveTailorSettings((pair?.config as Record<string, unknown> | undefined)?.[TAILOR_SETTINGS_KEY]);
	if ("error" in settings) throw new HttpError(409, `The Application Tailor settings are invalid: ${settings.error}. Fix them, then retry.`);
	const runtime = await getLiveRuntime(env, instanceId, uid);
	if (!runtime) throw new HttpError(503, "No runner is connected. Run `pags up` on the machine that holds your job materials, then retry.");
	const moved = await moveApplication(env, app, uid, { to: "tailoring", actor: "owner", actorInstanceId: instanceId, reason: "retry_tailoring" }, now);
	if (!moved) throw new HttpError(409, "The application changed while retrying — reload it.");
	const run = await dispatchTailoring(env, instanceId, uid, app.id, parsed.lead, settings.settings, `${app.idempotencyKey}:retry:${app.stateVersion + 1}`, "retry", runtime, now);
	return { application: (await getApplication(env, instanceId, uid, app.id)) as JobApplication, run };
}

/** End a run's application when its result arrives — exactly once, by compare-and-set. */
async function settleFromResult(env: Env, uid: string, run: TailorRun, rawResult: unknown, now: number): Promise<TailorRun> {
	const checked = parseLocalArtifactResult(rawResult);
	const app = await getApplication(env, run.instanceId, uid, run.applicationId);
	if ("error" in checked || checked.result.runId !== run.id) {
		const error = "error" in checked ? `The runner sent a result PAGS cannot accept: ${checked.error}` : "The runner's result names another run.";
		const failed = await updateTailorRun(env, run, { to: "failed", errorCode: "runner_result_invalid", error }, now);
		if (failed && app) await settleApplication(env, run.instanceId, uid, app.id, run.id, { to: "failed", blockReason: "runner_result_invalid", blockQuestions: [error] }, now);
		return failed ?? run;
	}
	const r = checked.result;
	const to = r.outcome;
	const moved = await updateTailorRun(
		env,
		run,
		{ to, result: r, engineAuth: r.engineAuth, ...(to === "failed" ? { errorCode: "engine_failed", error: r.error ?? null } : {}), events: [{ type: "run.ended", at: iso(now), detail: { status: to, engineAuth: r.engineAuth, count: r.artifacts.length } }] },
		now,
	);
	if (!moved || !app) return moved ?? run;
	if (to === "completed") {
		const resume = r.artifacts.find((a) => a.kind === "resume");
		const coverLetter = r.artifacts.find((a) => a.kind === "cover_letter");
		const lead = app.lead as LocalArtifactLead;
		const generatedAt = r.generatedAt ?? iso(now);
		const readyEvent: MaterialsReadyEvent = {
			eventType: MATERIALS_READY_EVENT,
			eventId: `${run.instanceId}:${app.leadId}:${app.lifecycleVersion}:materials`,
			applicationId: app.id,
			tailorInstanceId: run.instanceId,
			sourceInstanceId: app.sourceInstanceId,
			leadId: app.leadId,
			leadUrl: lead.leadUrl,
			lifecycleVersion: app.lifecycleVersion,
			leadEventId: app.idempotencyKey,
			tailoringRunId: run.id,
			profileVersion: r.profileVersion,
			generatedAt,
			artifacts: { resume, coverLetter },
			lead: lead.lead,
		};
		const settled = await settleApplication(
			env,
			run.instanceId,
			uid,
			app.id,
			run.id,
			{ to: "materials_ready", resumeArtifact: resume, coverLetterArtifact: coverLetter, profileVersion: r.profileVersion, generatedAt, readyEvent: readyEvent as unknown as Record<string, unknown> },
			now,
		);
		if (settled) await emitReady(env, run.instanceId, uid, app.id);
	} else {
		await settleApplication(
			env,
			run.instanceId,
			uid,
			app.id,
			run.id,
			to === "needs_human"
				? { to: "blocked", blockReason: r.blockReason ?? "missing_information", blockQuestions: r.questions ?? [] }
				: { to: "failed", blockReason: r.engineAuth === "missing_login" ? "engine_not_signed_in" : "engine_failed", blockQuestions: r.error ? [r.error] : [] },
			now,
		);
	}
	return moved;
}

/**
 * Put a ready application's event into the connection outbox. Safe to call any number of times:
 * the event and its trace id are stable, so the outbox's idempotency key collapses a repeat.
 */
export async function emitReady(env: Env, instanceId: string, uid: string, applicationId: string): Promise<void> {
	const app = await getApplication(env, instanceId, uid, applicationId);
	if (app?.status !== "materials_ready" || !app.readyEvent || app.readyEmittedAt) return;
	await deliverEvent(env, instanceId, uid, MATERIALS_READY_EVENT, [app.readyEvent], { traceId: str(app.readyEvent.eventId) });
	await markReadyEmitted(env, app.id, Date.now());
}

async function endLost(env: Env, uid: string, run: TailorRun, error: string, now: number): Promise<TailorRun> {
	const failed = await updateTailorRun(env, run, { to: "failed", errorCode: "runner_lost", error, events: [{ type: "run.ended", at: iso(now), detail: { status: "failed", reason: "runner_lost" } }] }, now);
	if (failed) await settleApplication(env, run.instanceId, uid, run.applicationId, run.id, { to: "blocked", blockReason: "runner_lost", blockQuestions: [error] }, now);
	return failed ?? run;
}

/** Bring one run up to date from its runner. A runner that no longer holds it ends it, never "running" forever. */
export async function syncTailorRun(env: Env, uid: string, run: TailorRun, now = Date.now()): Promise<TailorRun> {
	if (run.status !== "running") return run;
	const silentSince = run.lastSyncedAt ?? run.startedAt ?? run.createdAt;
	const lostByTime = now - silentSince > run.policy.maxMinutes * 60_000 + LOST_RUNNER_GRACE_MS;
	const runtime = await getLiveRuntime(env, run.instanceId, uid).catch(() => null);
	if (!runtime) return lostByTime ? endLost(env, uid, run, "The runner went offline during tailoring and did not come back within its time limit.", now) : run;
	let res: Response;
	try {
		res = await callRuntime(env, runtime, LOCAL_ARTIFACT_STATUS_PATH, { method: "POST", body: JSON.stringify({ runId: run.id, afterSeq: run.runnerSeq }) });
	} catch {
		return run;
	}
	if (res.status === 404) return endLost(env, uid, run, "The runner no longer holds this run — it was restarted or updated. Retry tailoring.", now);
	if (!res.ok) return lostByTime ? endLost(env, uid, run, "The runner stopped answering for this run.", now) : run;
	const body = (await runtimeJson(res)) as { state?: unknown; events?: unknown; lastSeq?: unknown; result?: unknown };
	const events = (Array.isArray(body.events) ? body.events : []).map(parseLocalArtifactEvent).filter((e): e is NonNullable<typeof e> => e !== null) as TraceEvent[];
	const lastSeq = typeof body.lastSeq === "number" && body.lastSeq >= run.runnerSeq ? body.lastSeq : run.runnerSeq;
	let current = (await updateTailorRun(env, run, { events, runnerSeq: lastSeq }, now)) ?? (await getTailorRun(env, run.instanceId, uid, run.id)) ?? run;
	if (body.state === "ended" && body.result !== undefined && !isTerminalRun(current.status)) current = await settleFromResult(env, uid, current, body.result, now);
	// #978 — the tailoring run on the owner's normal board, through the one function every
	// runner-reported transition comes through.
	await syncApplicationCard(env, uid, current, "tailor");
	return current;
}

/** Cancel a run on its runner and close its application. Archive-style: nothing external is touched. */
export async function cancelTailoring(env: Env, uid: string, run: TailorRun, now = Date.now()): Promise<TailorRun> {
	if (isTerminalRun(run.status)) throw new HttpError(409, `The run has already ended (${run.status})`);
	const runtime = await getLiveRuntime(env, run.instanceId, uid).catch(() => null);
	if (runtime) await callRuntime(env, runtime, LOCAL_ARTIFACT_CANCEL_PATH, { method: "POST", body: JSON.stringify({ runId: run.id }) }).catch(() => null);
	const cancelled = await updateTailorRun(env, run, { to: "cancelled", errorCode: "cancelled", error: "Cancelled by the owner", events: [{ type: "run.ended", at: iso(now), detail: { status: "cancelled" } }] }, now);
	if (!cancelled) throw new HttpError(409, "The run changed while cancelling — reload it.");
	await settleApplication(env, run.instanceId, uid, run.applicationId, run.id, { to: "cancelled" }, now);
	return cancelled;
}

/** The cron tick: pull active runs, then put any ready event still missing from the outbox into it. */
/**
 * The task the runner is sent. One builder for the first dispatch and for a re-dispatch out of the
 * queue (#974), for the reason the Runner's has one: two constructions would be two answers to what
 * this run was asked to do.
 */
export function tailorTaskEnvelope(run: TailorRun, lead: LocalArtifactTaskEnvelope["lead"], s: ApplicationTailorSettings): LocalArtifactTaskEnvelope {
	return {
		type: LOCAL_ARTIFACT_TASK_TYPE,
		runId: run.id,
		requestId: run.requestId,
		instanceId: run.instanceId,
		engine: s.engine,
		authMode: s.authMode,
		workspace: s.workspace,
		sources: run.policy.sources,
		lead,
		policy: { retainDays: s.retainDays, maxMinutes: s.maxMinutes, maxConcurrent: 1 },
	};
}

/**
 * Dispatch this Tailor's next queued run when its one tailoring slot is free (#974) — the
 * counterpart of `dispatchNextQueuedFill`, with the same claim-before-asking rule and the same
 * bounded wait.
 */
export async function dispatchNextQueuedTailoring(env: Env, instanceId: string, uid: string, now = Date.now()): Promise<"dispatched" | "queued" | "idle" | "exhausted"> {
	const next = await nextDueQueuedRun(env, "local_artifact_runs", instanceId, uid, now);
	if (!next) return "idle";
	const run = await getTailorRun(env, instanceId, uid, next.id);
	const app = await getApplication(env, instanceId, uid, next.applicationId);
	if (!run || !app) return "idle";
	if (next.attempts >= QUEUE_MAX_ATTEMPTS) {
		await updateTailorRun(env, run, { to: "failed", errorCode: "runner_busy", error: `The machine never freed up for this application after ${next.attempts} attempts.`, events: [{ type: "run.ended", at: iso(now), detail: { status: "failed", reason: "runner_busy" } }] }, now);
		await settleApplication(env, instanceId, uid, next.applicationId, run.id, { to: "blocked", blockReason: "runner_busy", blockQuestions: ["Your machine stayed busy. Retry this application when a run has finished."] }, now);
		return "exhausted";
	}
	const parsed = parseLocalArtifactLead(app.lead);
	if ("error" in parsed) return "queued";
	if (!(await claimQueuedDispatch(env, "local_artifact_runs", next, now))) return "queued";
	const runtime = await getLiveRuntime(env, instanceId, uid).catch(() => null);
	if (!runtime) {
		await noteQueued(env, "local_artifact_runs", run.id, "No runner is connected — run `pags up` on the machine that holds your job materials.", now);
		return "queued";
	}
	const pair = await readInstanceConfigPair(env, instanceId, uid);
	const settings = effectiveTailorSettings((pair?.config as Record<string, unknown> | undefined)?.[TAILOR_SETTINGS_KEY]);
	if ("error" in settings) return "queued";
	let res: Response | null = null;
	try {
		res = await callRuntime(env, runtime, LOCAL_ARTIFACT_RUN_PATH, { method: "POST", body: JSON.stringify(tailorTaskEnvelope(run, parsed.lead, settings.settings)) });
	} catch {
		await noteQueued(env, "local_artifact_runs", run.id, "The runner did not answer; waiting to try again.", now);
		return "queued";
	}
	const payload = (await runtimeJson(res)) as Record<string, unknown>;
	if (res.ok) {
		await updateTailorRun(env, run, { to: "running", runnerNode: runtime.runner_node || null, events: [{ type: "runner.dispatched", at: iso(now), detail: { status: "running", from: "queue" } }] }, now);
		return "dispatched";
	}
	const refusal = refusalVerdict({ status: res.status, error: typeof payload.error === "string" ? payload.error : undefined, code: typeof payload.code === "string" ? payload.code : undefined });
	if (refusal.defer) {
		await noteQueued(env, "local_artifact_runs", run.id, refusal.message, now);
		return "queued";
	}
	await updateTailorRun(env, run, { to: "failed", errorCode: "runner_rejected", error: `The runner refused the run: ${typeof payload.error === "string" ? payload.error.slice(0, 500) : `HTTP ${res.status}`}`, events: [{ type: "run.ended", at: iso(now), detail: { status: "failed", reason: "runner_rejected" } }] }, now);
	await settleApplication(env, instanceId, uid, next.applicationId, run.id, { to: "blocked", blockReason: "runner_rejected", blockQuestions: [typeof payload.error === "string" ? payload.error.slice(0, 300) : `HTTP ${res.status}`] }, now);
	return "exhausted";
}

export async function syncActiveTailorRuns(env: Env, limit = 25): Promise<number> {
	const now = Date.now();
	let synced = 0;
	for (const r of await activeTailorRuns(env, limit)) {
		const run = await getTailorRun(env, r.instanceId, r.userId, r.id);
		if (!run) continue;
		await syncTailorRun(env, r.userId, run, now).catch(() => undefined);
		synced++;
	}
	for (const a of await unemittedReadyApplications(env, limit)) await emitReady(env, a.instanceId, a.userId, a.id).catch(() => undefined);
	// Move the line along (#974), after the pulls: a tailoring run that just finished frees the
	// machine in this tick, so the next approved lead starts immediately.
	for (const i of await instancesWithQueuedRuns(env, "local_artifact_runs", limit)) {
		await dispatchNextQueuedTailoring(env, i.instanceId, i.userId, now).catch(() => undefined);
	}
	return synced;
}
