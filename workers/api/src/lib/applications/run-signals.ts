/**
 * What the owner hears while an application is being prepared and sent (#1107).
 *
 * The Tailor and the Runner already record every step on their run's trace (redacted, #1069), and
 * `application_trace` reads it back. What was missing was the PUSH: the owner heard nothing between
 * "started" and the final result. This module turns a run's trace into three kinds of signal, each
 * through the owner-attention policy (#991/#992), so every one is controllable per instance, event
 * and channel:
 *
 *   - `run_progress` — one update per STAGE reached (on the page, signing in, filling, uploading, at
 *     a checkpoint, submitting): the stage, the last action and the elapsed time. Never one per
 *     field. In-app by default; it only buzzes a phone if the owner turns push on (`pushDefault`).
 *   - a BLOCKER, immediately, for the stops nothing announced: the listing expired, a consent wall,
 *     a run that ended not knowing whether it submitted, a Tailor that needs the owner's answers.
 *     The stops that were already announced (a sign-in or CAPTCHA pause, an unconfirmed submit,
 *     the final outcome) keep their own notification and are not repeated here.
 *   - `run_stalled` — once per run, when no new event arrived within the stall threshold.
 *
 * Every signal is CLAIMED on the run row first (migration 0248) with a compare-and-set, so the
 * per-minute sweep and an owner's read syncing the same run announce it once. Text carries stage
 * names, counts and reason codes only — never a URL, never a field's value.
 */
import { clipMarked } from "../clip-marked.js";
import { getOwnedApplication } from "../local-artifact/store.js";
import type { TailorRun } from "../local-artifact/store.js";
import type { ApplyRun, ApplyTraceEvent } from "../local-apply/store.js";
import { type OwnerAttentionEvent, requestOwnerAttention } from "../owner-attention.js";
import { attentionDeps as defaultDeps } from "./attention-deps.js";
import type { AttentionDeps } from "../owner-attention.js";
import type { Env } from "../../types.js";

// ── Stages ────────────────────────────────────────────────────────────────────────────────────

/** The Runner's stages, in order. A run's stage is the furthest one its trace reached. */
export const RUNNER_STAGES = ["started", "on_listing", "signing_in", "signed_in", "filling", "uploading", "checkpoint", "submitting"] as const;
export type RunnerStage = (typeof RUNNER_STAGES)[number];
/** The Tailor's stages, in order. */
export const TAILOR_STAGES = ["started", "reading_sources", "writing"] as const;
export type TailorStage = (typeof TAILOR_STAGES)[number];

const STAGE_LABEL: Record<string, string> = {
	started: "started",
	on_listing: "on the job listing",
	signing_in: "waiting at a sign-in",
	signed_in: "signed in",
	filling: "filling the form",
	uploading: "uploading documents",
	checkpoint: "at a checkpoint",
	submitting: "submitting",
	reading_sources: "reading your sources",
	writing: "writing the materials",
};

/** What one event did, in words — a kind, never a value. */
function actionLabel(e: { type: string; pauseReason?: string; detail?: Record<string, unknown> }): string {
	switch (e.type) {
		case "browser.navigated":
			return "opened a page";
		case "field.filled":
			return "filled a field";
		case "artifact.uploaded":
			return `uploaded ${e.detail?.kind === "cover_letter" ? "the cover letter" : e.detail?.kind === "resume" ? "the résumé" : "a document"}`;
		case "run.paused":
			return `paused (${e.pauseReason ?? "waiting"})`;
		case "run.resumed":
			return "resumed";
		case "supervisor.checkpoint":
			return "reached a checkpoint";
		case "review.ready":
			return "filled the form for review";
		case "submit.attempted":
			return "pressed submit";
		case "source.read":
			return "read a source";
		case "artifact.written":
			return "wrote a document";
		case "claims.checked":
			return "checked the claims";
		default:
			return e.type.replace(/[._]/g, " ");
	}
}

export interface StageReading<S extends string> {
	stage: S;
	lastAction: string;
	filled: number;
	uploaded: number;
}

/** The furthest Runner stage a trace reached, the last thing it did, and the counts. Pure. */
export function runnerStage(trace: readonly ApplyTraceEvent[]): StageReading<RunnerStage> | null {
	let rank = -1;
	let filled = 0;
	let uploaded = 0;
	let waitingSignIn = false;
	let last: ApplyTraceEvent | null = null;
	const reach = (s: RunnerStage) => {
		rank = Math.max(rank, RUNNER_STAGES.indexOf(s));
	};
	for (const e of trace) {
		if (e.type === "run.requested" || e.type === "runner.dispatched" || e.type === "policy.submit_gate" || e.type === "screenshot.captured" || e.type === "note") continue;
		last = e;
		if (e.type === "engine.started" || e.type === "engine.auth_checked" || e.type === "source.read") reach("started");
		else if (e.type === "browser.navigated") reach("on_listing");
		else if (e.type === "run.paused" && e.pauseReason === "login_required") {
			waitingSignIn = true;
			reach("signing_in");
		} else if (e.type === "run.resumed" && waitingSignIn) {
			waitingSignIn = false;
			reach("signed_in");
		} else if (e.type === "field.filled") {
			filled++;
			reach("filling");
		} else if (e.type === "artifact.uploaded") {
			uploaded++;
			reach("uploading");
		} else if (e.type === "supervisor.checkpoint" || e.type === "review.ready") reach("checkpoint");
		else if (e.type === "submit.attempted") reach("submitting");
	}
	if (rank < 0 || !last) return null;
	return { stage: RUNNER_STAGES[rank], lastAction: actionLabel(last), filled, uploaded };
}

/** The furthest Tailor stage a trace reached. Pure. */
export function tailorStage(trace: readonly { type: string; at: string }[]): StageReading<TailorStage> | null {
	let rank = -1;
	let last: { type: string } | null = null;
	for (const e of trace) {
		if (e.type === "run.requested" || e.type === "runner.dispatched" || e.type === "note") continue;
		last = e;
		if (e.type === "engine.started" || e.type === "engine.auth_checked") rank = Math.max(rank, 0);
		else if (e.type === "source.read" || e.type === "claims.checked") rank = Math.max(rank, 1);
		else if (e.type === "artifact.written") rank = Math.max(rank, 2);
	}
	if (rank < 0 || !last) return null;
	return { stage: TAILOR_STAGES[rank], lastAction: actionLabel(last), filled: 0, uploaded: 0 };
}

// ── Stall threshold ───────────────────────────────────────────────────────────────────────────

export const MIN_STALL_MINUTES = 5;
export const MAX_AUTO_STALL_MINUTES = 10;

/** The stall threshold: the owner's setting, or half the run's time limit, capped at 10 and never under 5. */
export function stallMinutesFor(maxMinutes: number, setting: number | null | undefined): number {
	if (typeof setting === "number" && setting > 0) return setting;
	return Math.max(MIN_STALL_MINUTES, Math.min(MAX_AUTO_STALL_MINUTES, Math.floor(maxMinutes / 2)));
}

/** When the run last made progress: its newest event, else when it started. */
export function lastProgressAt(trace: readonly { at: string }[], startedAt: number): number {
	let newest = startedAt;
	for (const e of trace) {
		const t = Date.parse(e.at);
		if (Number.isFinite(t) && t > newest) newest = t;
	}
	return newest;
}

export const elapsed = (ms: number): string => {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

/** A terminal blocker is announced only for a run that ended this recently, so opening an old run never re-announces it. */
export const FRESH_END_MS = 30 * 60_000;

// ── Claims ────────────────────────────────────────────────────────────────────────────────────

type RunTable = "local_apply_runs" | "local_artifact_runs";

async function readSignals(env: Env, table: RunTable, id: string): Promise<{ progress_stage: string | null; blocker_alerted: string | null; stall_alerted_at: number | null } | null> {
	return env.DB.prepare(`SELECT progress_stage, blocker_alerted, stall_alerted_at FROM ${table} WHERE id = ?1`)
		.bind(id)
		.first<{ progress_stage: string | null; blocker_alerted: string | null; stall_alerted_at: number | null }>()
		.catch(() => null);
}

/** Compare-and-set one signal column; true when THIS call won it. */
async function claim(env: Env, table: RunTable, id: string, column: "progress_stage" | "blocker_alerted" | "stall_alerted_at", from: string | number | null, to: string | number): Promise<boolean> {
	const res = await env.DB.prepare(`UPDATE ${table} SET ${column} = ?2 WHERE id = ?1 AND ${column} IS ?3`)
		.bind(id, to, from)
		.run()
		.catch(() => null);
	return (res?.meta?.changes ?? 0) > 0;
}

// ── Delivery ──────────────────────────────────────────────────────────────────────────────────

async function roleAt(env: Env, uid: string, applicationId: string): Promise<string> {
	const app = await getOwnedApplication(env, uid, applicationId).catch(() => null);
	const lead = (app?.lead ?? {}) as { lead?: { title?: unknown; company?: unknown } };
	const role = typeof lead.lead?.title === "string" && lead.lead.title.trim() ? lead.lead.title.trim() : "an application";
	const company = typeof lead.lead?.company === "string" && lead.lead.company.trim() ? ` at ${lead.lead.company.trim()}` : "";
	return `${role}${company}`;
}

async function raise(
	env: Env,
	deps: AttentionDeps<Env>,
	r: { event: OwnerAttentionEvent; uid: string; instanceId: string; applicationId: string; aboutId: string; state: string; title: string; body: string },
): Promise<void> {
	await requestOwnerAttention(
		env,
		{
			event: r.event,
			userId: r.uid,
			instanceId: r.instanceId,
			subject: { kind: "application", instanceId: r.instanceId, applicationId: r.applicationId },
			about: { kind: "run", id: r.aboutId, state: r.state },
			notificationType: "apply",
			title: clipMarked(r.title, 120, { within: true }),
			body: clipMarked(r.body, 300, { within: true }),
		},
		deps,
	).catch(() => undefined);
}

/** The Runner's blocker this trace or end state shows that nothing else announces, with the claim it is announced under. */
export function runnerBlocker(run: Pick<ApplyRun, "status" | "pause" | "result" | "errorCode" | "policy" | "trace" | "endedAt">, now: number): { reason: "job_unavailable" | "consent_required" | "submit_state_unknown"; key: string } | null {
	const ended = run.endedAt !== null && run.endedAt !== undefined;
	const fresh = !ended || now - (run.endedAt as number) <= FRESH_END_MS;
	if (!fresh) return null;
	const expired = run.trace.find((e) => e.type === "job.unavailable") ?? ((run.result as { blockReason?: unknown } | null)?.blockReason === "job_unavailable" ? { at: "end" } : null);
	if (expired) return { reason: "job_unavailable", key: "job_unavailable" };
	if (run.status === "paused" && run.pause?.reason === "consent_required") {
		// Keyed on WHEN it paused, so a second consent wall later in the same run is still announced.
		const at = [...run.trace].reverse().find((e) => e.type === "run.paused" && e.pauseReason === "consent_required")?.at ?? "";
		return { reason: "consent_required", key: `consent_required:${at}` };
	}
	if (run.status === "failed" && (run.errorCode === "runner_lost" || run.errorCode === "run_timed_out") && run.policy.mode === "auto_submit") return { reason: "submit_state_unknown", key: "submit_state_unknown" };
	return null;
}

const BLOCKER_TEXT: Record<string, { event: OwnerAttentionEvent; title: (role: string) => string; body: string }> = {
	job_unavailable: {
		event: "blocker_required",
		title: (role) => `Listing no longer available: ${role}`,
		body: "The employer's listing has expired or been taken down, so the application was archived. Nothing was submitted.",
	},
	consent_required: {
		event: "blocker_required",
		title: (role) => `A consent step needs you: ${role}`,
		body: "The site is asking for a consent the Runner may not give for you. The run is paused and waiting; open the application to see where it stopped. Nothing has been submitted.",
	},
	submit_state_unknown: {
		event: "decision_required",
		title: (role) => `Check whether it was sent: ${role}`,
		body: "The run stopped before it could report back, and it was allowed to submit — so nobody can say whether it did. It will not be retried. Open it to check the employer's site before deciding what happens next.",
	},
};

/** Signals for one Application Runner run, after it was synced. Best-effort: never fails the sync. */
export async function applyRunSignals(env: Env, uid: string, run: ApplyRun, now = Date.now(), deps: AttentionDeps<Env> = defaultDeps): Promise<void> {
	const marks = await readSignals(env, "local_apply_runs", run.id);
	if (!marks) return;
	const base = { uid, instanceId: run.instanceId, applicationId: run.applicationId, aboutId: run.id };
	const startedAt = run.startedAt ?? run.createdAt;

	const blocker = runnerBlocker(run, now);
	if (blocker && marks.blocker_alerted !== blocker.key && (await claim(env, "local_apply_runs", run.id, "blocker_alerted", marks.blocker_alerted, blocker.key))) {
		const text = BLOCKER_TEXT[blocker.reason];
		await raise(env, deps, { ...base, event: text.event, state: blocker.key, title: text.title(await roleAt(env, uid, run.applicationId)), body: text.body });
	}
	if (run.status !== "running") return;

	const reading = runnerStage(run.trace);
	if (reading) {
		const had = marks.progress_stage ? RUNNER_STAGES.indexOf(marks.progress_stage as RunnerStage) : -1;
		const now_ = RUNNER_STAGES.indexOf(reading.stage);
		if (now_ > had && (await claim(env, "local_apply_runs", run.id, "progress_stage", marks.progress_stage, reading.stage))) {
			const counts = [reading.filled ? `${reading.filled} field${reading.filled === 1 ? "" : "s"} filled` : "", reading.uploaded ? `${reading.uploaded} uploaded` : ""].filter(Boolean).join(", ");
			await raise(env, deps, {
				...base,
				event: "run_progress",
				state: reading.stage,
				title: `Runner ${STAGE_LABEL[reading.stage]}: ${await roleAt(env, uid, run.applicationId)}`,
				body: `Stage: ${STAGE_LABEL[reading.stage]}. Last action: ${reading.lastAction}${counts ? ` (${counts})` : ""}. Elapsed: ${elapsed(now - startedAt)}.`,
			});
		}
	}
	await stallCheck(env, deps, "local_apply_runs", { ...base, who: "Runner", stall: run.policy.limits.stallMinutes, maxMinutes: run.policy.limits.maxMinutes }, marks.stall_alerted_at, lastProgressAt(run.trace, startedAt), startedAt, reading?.stage ?? "started", now);
}

/** Signals for one Application Tailor run, after it was synced. Best-effort. */
export async function tailorRunSignals(env: Env, uid: string, run: TailorRun, now = Date.now(), deps: AttentionDeps<Env> = defaultDeps): Promise<void> {
	const marks = await readSignals(env, "local_artifact_runs", run.id);
	if (!marks) return;
	const base = { uid, instanceId: run.instanceId, applicationId: run.applicationId, aboutId: run.id };
	const startedAt = run.startedAt ?? run.createdAt;
	const fresh = run.endedAt === null || run.endedAt === undefined || now - run.endedAt <= FRESH_END_MS;
	if (run.status === "needs_human" && fresh && marks.blocker_alerted !== "needs_human" && (await claim(env, "local_artifact_runs", run.id, "blocker_alerted", marks.blocker_alerted, "needs_human"))) {
		await raise(env, deps, {
			...base,
			event: "input_required",
			state: "needs_human",
			title: `The Tailor needs your answers: ${await roleAt(env, uid, run.applicationId)}`,
			body: "Tailoring stopped because it needs something only you have — an answer or a source it could not find. Open the application to see what it asks. Nothing was sent anywhere.",
		});
	}
	if (run.status !== "running") return;
	const reading = tailorStage(run.trace);
	if (reading) {
		const had = marks.progress_stage ? TAILOR_STAGES.indexOf(marks.progress_stage as TailorStage) : -1;
		if (TAILOR_STAGES.indexOf(reading.stage) > had && (await claim(env, "local_artifact_runs", run.id, "progress_stage", marks.progress_stage, reading.stage))) {
			await raise(env, deps, {
				...base,
				event: "run_progress",
				state: reading.stage,
				title: `Tailor ${STAGE_LABEL[reading.stage]}: ${await roleAt(env, uid, run.applicationId)}`,
				body: `Stage: ${STAGE_LABEL[reading.stage]}. Last action: ${reading.lastAction}. Elapsed: ${elapsed(now - startedAt)}.`,
			});
		}
	}
	await stallCheck(env, deps, "local_artifact_runs", { ...base, who: "Tailor", stall: run.policy.stallMinutes, maxMinutes: run.policy.maxMinutes }, marks.stall_alerted_at, lastProgressAt(run.trace, startedAt), startedAt, reading?.stage ?? "started", now);
}

async function stallCheck(
	env: Env,
	deps: AttentionDeps<Env>,
	table: RunTable,
	r: { uid: string; instanceId: string; applicationId: string; aboutId: string; who: string; stall: number | null | undefined; maxMinutes: number },
	alertedAt: number | null,
	lastAt: number,
	startedAt: number,
	stage: string,
	now: number,
): Promise<void> {
	if (alertedAt !== null) return;
	const minutes = stallMinutesFor(r.maxMinutes, r.stall);
	if (now - lastAt < minutes * 60_000) return;
	if (!(await claim(env, table, r.aboutId, "stall_alerted_at", null, now))) return;
	await raise(env, deps, {
		...r,
		event: "run_stalled",
		state: "stalled",
		title: `${r.who} stalled: ${await roleAt(env, r.uid, r.applicationId)}`,
		body: `No progress for ${elapsed(now - lastAt)} (threshold ${minutes} min). Stage: ${STAGE_LABEL[stage] ?? stage}. Elapsed: ${elapsed(now - startedAt)}. Its machine may be asleep or the run may be stuck — nothing has been retried.`,
	});
}
