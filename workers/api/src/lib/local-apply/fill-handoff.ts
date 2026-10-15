import type { Env } from "../../types.js";
import { HttpError } from "../auth.js";
import { applicationCardId } from "../applications/application-board.js";
import { getOwnedApplication } from "../local-artifact/store.js";
import { callRuntime, getLiveRuntime, runtimeJson } from "../../routes/instances-runtime.js";
import { resumeApplyRun, syncApplyRun } from "./apply.js";
import { LOCAL_APPLY_HANDOFF_PATH, LOCAL_APPLY_HANDOFF_STATUS_PATH, type LocalApplyHandoffStatus } from "./contract.js";
import { type ApplyRun, type LocalApplyHandoff, createLocalApplyHandoff, getApplyRun, getLocalApplyHandoffForRun, isTerminalApplyRun, markLocalApplyHandoff, usableLocalApplyHandoff } from "./store.js";

/**
 * The live browser handoff of a paused Application Runner FILL (#1013), as one module both entry points use:
 * the application-run routes (`/application-runs/:runId/handoff…`) and — #1100 — the generic runtime-task
 * takeover routes (`/takeover/:taskId/{frame,input,resume}`), reached from a run's task page and from a
 * `runtime_task` takeover an owner opens on their phone.
 *
 * #1100: an application's board card IS a runtime task (`app-<applicationId>`), and a takeover is recorded
 * against it — but its live page was never in the runner's per-task takeover map. A fill's page is
 * reachable only through this handoff, keyed `local-apply:<handoffId>` on the runner. So the generic frame
 * route asked the runner for `app-…`, got "No active human-takeover session for this task", and the
 * owner saw an error beside a takeover the record called active. `fillRunForCard` is the binding.
 */
export const HANDOFF_TTL_MS = 10 * 60_000;

export type HandoffSuffix = "frame" | "input" | "resume" | "end";
export const runnerHandoffPath = (suffix: HandoffSuffix) => `/local-apply/handoff/${suffix}`;

export function handoffRequest(handoff: { continuityId: string; runId: string; applicationId: string; browserProfile: string }) {
	return { handoffId: handoff.continuityId, runId: handoff.runId, applicationId: handoff.applicationId, browserProfile: handoff.browserProfile };
}

/** The fill run behind an application's board card on THIS Runner instance, or null when the task is not one. */
export async function fillRunForCard(env: Env, instanceId: string, userId: string, taskId: string): Promise<ApplyRun | null> {
	if (!taskId.startsWith("app-")) return null;
	const app = await getOwnedApplication(env, userId, taskId.slice("app-".length));
	if (!app?.fillRunId || applicationCardId(app.id) !== taskId) return null;
	const run = await getApplyRun(env, instanceId, userId, app.fillRunId);
	// Read from the runner only when the stored row does not already say it waits on a person: the frame
	// is polled, and a run already recorded paused is re-checked by the handoff itself.
	if (!run || fillGate(run)?.waiting || isTerminalApplyRun(run.status)) return run;
	return syncApplyRun(env, userId, run).catch(() => run);
}

/** What the takeover gate needs to know about a card's fill: does it wait on a person right now. */
export function fillGate(run: ApplyRun | null): { waiting: boolean } | undefined {
	return run ? { waiting: run.status === "paused" && (run.pause?.reason === "login_required" || run.pause?.reason === "captcha") } : undefined;
}

/**
 * Create (or read back) the one handoff for this still-live apply run and make it ready on the runner.
 * `ready: false` is a handoff that exists but is closed — the caller reports it. Throws for the refusals.
 */
export async function ensureFillHandoff(env: Env, userId: string, instanceId: string, stored: ApplyRun): Promise<{ handoff: LocalApplyHandoff; ready: boolean }> {
	const run = await syncApplyRun(env, userId, stored);
	const app = await getOwnedApplication(env, userId, run.applicationId);
	if (!app || app.fillRunId !== run.id) throw new HttpError(409, "This application is no longer bound to that exact Runner run.");
	if (run.status !== "paused" || !(["login_required", "captcha"] as const).includes(run.pause?.reason as "login_required" | "captcha")) {
		throw new HttpError(409, "A live browser handoff is available only while this exact run is paused for site login or a CAPTCHA.");
	}
	const now = Date.now();
	let handoff = await createLocalApplyHandoff(env, { run, app, userId, browserProfile: run.policy.browserProfile, expiresAt: now + HANDOFF_TTL_MS }, now);
	if (!handoff) throw new HttpError(409, "The handoff could not be bound to this application run.");
	if (!usableLocalApplyHandoff(handoff, now)) return { handoff, ready: false };
	const runtime = await getLiveRuntime(env, instanceId, userId).catch(() => null);
	if (!runtime) {
		await markLocalApplyHandoff(env, { continuityId: handoff.continuityId, instanceId, userId, state: "closed", terminalReason: "runner_restarted" }, now);
		throw new HttpError(409, "The Runner is disconnected; this handoff is closed rather than treated as complete.");
	}
	const path = handoff.state === "requested" ? LOCAL_APPLY_HANDOFF_PATH : LOCAL_APPLY_HANDOFF_STATUS_PATH;
	const res = await callRuntime(env, runtime, path, { method: "POST", body: JSON.stringify(handoffRequest(handoff)) }).catch(() => null);
	if (!res) {
		await markLocalApplyHandoff(env, { continuityId: handoff.continuityId, instanceId, userId, state: "closed", terminalReason: "runner_restarted" }, now);
		throw new HttpError(409, "The Runner did not answer; this handoff is closed rather than treated as complete.");
	}
	const body = (await runtimeJson(res)) as LocalApplyHandoffStatus & { error?: string };
	if (!res.ok || body.state !== "ready") {
		const terminal = body.terminalReason ?? "unavailable";
		handoff = (await markLocalApplyHandoff(env, { continuityId: handoff.continuityId, instanceId, userId, state: "closed", terminalReason: terminal }, now)) ?? handoff;
		return { handoff, ready: false };
	}
	handoff = (await markLocalApplyHandoff(env, { continuityId: handoff.continuityId, instanceId, userId, state: "ready" }, now)) ?? handoff;
	return { handoff, ready: true };
}

/** Relay one live-view operation through a usable handoff of this run. Resume also resumes the run. */
export async function relayFillHandoff(env: Env, userId: string, instanceId: string, run: ApplyRun, handoff: LocalApplyHandoff, suffix: HandoffSuffix, input?: unknown): Promise<unknown> {
	const continuityId = handoff.continuityId;
	const now = Date.now();
	if (!usableLocalApplyHandoff(handoff, now)) throw new HttpError(409, `This application handoff is closed (${handoff.terminalReason ?? handoff.state}).`);
	const runtime = await getLiveRuntime(env, instanceId, userId).catch(() => null);
	if (!runtime) {
		await markLocalApplyHandoff(env, { continuityId, instanceId, userId, state: "closed", terminalReason: "runner_restarted" }, now);
		throw new HttpError(409, "The Runner is disconnected; this handoff is closed rather than complete.");
	}
	const res = await callRuntime(env, runtime, runnerHandoffPath(suffix), {
		method: "POST",
		body: JSON.stringify({ ...handoffRequest(handoff), ...(suffix === "input" ? { input } : {}) }),
	}).catch(() => null);
	if (!res) {
		await markLocalApplyHandoff(env, { continuityId, instanceId, userId, state: "closed", terminalReason: "runner_restarted" }, now);
		throw new HttpError(409, "The Runner did not answer; this handoff is closed rather than complete.");
	}
	const payload = await runtimeJson(res);
	if (!res.ok) {
		await markLocalApplyHandoff(env, { continuityId, instanceId, userId, state: "closed", terminalReason: "page_lost" }, now);
		throw new HttpError(409, "The live handoff page is no longer available.");
	}
	if (suffix === "end") await markLocalApplyHandoff(env, { continuityId, instanceId, userId, state: "closed", terminalReason: "unavailable" }, now);
	if (suffix === "resume") {
		await markLocalApplyHandoff(env, { continuityId, instanceId, userId, state: "closed", terminalReason: "unavailable" }, now);
		return { run: await resumeApplyRun(env, userId, run, {}) };
	}
	return payload;
}

/**
 * #1100: the generic runtime-task takeover routes, for an application card. Frame and input open (or reuse)
 * the fill's handoff and relay through it; resume relays and resumes the fill. A card whose fill is not
 * paused for a login or CAPTCHA is refused with that reason — never answered as "no session".
 */
export async function relayCardTakeover(env: Env, userId: string, instanceId: string, run: ApplyRun, suffix: "frame" | "input" | "resume", input?: unknown): Promise<unknown> {
	const now = Date.now();
	let handoff = await getLocalApplyHandoffForRun(env, run.id, instanceId, userId);
	if (handoff?.state !== "ready" || !usableLocalApplyHandoff(handoff, now)) {
		if (suffix === "resume" && !handoff) throw new HttpError(409, "No live handoff is open for this application's fill; open the live view first.");
		const ensured = await ensureFillHandoff(env, userId, instanceId, run);
		if (!ensured.ready) throw new HttpError(409, `This application handoff is closed (${ensured.handoff.terminalReason ?? ensured.handoff.state}).`);
		handoff = ensured.handoff;
	}
	return relayFillHandoff(env, userId, instanceId, run, handoff, suffix, input);
}
