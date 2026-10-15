import type { Env } from "../../types.js";
import { HttpError } from "../auth.js";
import { applicationCardId, applicationCardLabel } from "../applications/application-board.js";
import type { BrowserTakeover } from "../browser-takeover-types.js";
import { getOwnedApplication } from "../local-artifact/store.js";
import { callRuntime, getLiveRuntime, runtimeJson } from "../../routes/instances-runtime.js";
import { resumeApplyRun, retryFill, syncApplyRun } from "./apply.js";
import {
	LOCAL_APPLY_HANDOFF_PATH,
	LOCAL_APPLY_HANDOFF_STATUS_PATH,
	LOCAL_APPLY_SIGN_IN_END_PATH,
	LOCAL_APPLY_SIGN_IN_FRAME_PATH,
	LOCAL_APPLY_SIGN_IN_INPUT_PATH,
	LOCAL_APPLY_SIGN_IN_PATH,
	type LocalApplyHandoffStatus,
	type LocalApplySignInStatus,
} from "./contract.js";
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

/**
 * A fill that ENDED `blocked` because the site needed a sign-in (#1094's gate, not answered before the
 * run's time ran out). #1100 round 2: the reported run paused at 11:32, ended at 11:53, and the owner's
 * takeover came at 11:57 — so its fill handoff was gone, and only a sign-in with no run can help.
 */
export function blockedOnSignIn(run: ApplyRun): boolean {
	return run.status === "blocked" && (run.result as { blockReason?: unknown } | null)?.blockReason === "login_required";
}

/** What the takeover gate needs to know about a card's fill: does it wait on a person right now, and for what. */
export function fillGate(run: ApplyRun | null): { waiting: boolean; reason?: "login_required" | "captcha" } | undefined {
	if (!run) return undefined;
	if (blockedOnSignIn(run)) return { waiting: true, reason: "login_required" };
	const reason = run.status === "paused" && (run.pause?.reason === "login_required" || run.pause?.reason === "captcha") ? run.pause.reason : undefined;
	return reason ? { waiting: true, reason } : { waiting: false };
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

/** The runner's id for the sign-in a takeover opens: one per durable takeover, so the record IS its bound. */
export const signInIdFor = (takeoverId: string) => `sign-in-${takeoverId}`;

/**
 * #1100 round 2: the live view of a card whose fill ended blocked on a sign-in. There is no paused run to
 * relay to, so the runner opens the run's own application profile at the job's page (`sign-in-runtime.ts`
 * on the runner) for exactly as long as the takeover lives:
 *
 *  - frame / input go to that page. When the runner has none — first poll, a runner restart, a tab the
 *    owner closed — it is opened (idempotent per takeover) and the call made once more, so every poll in
 *    the takeover window keeps a real page behind the view;
 *  - resume ("I'm done") records the sign-in in the profile's ledger, closes the page and retries the
 *    fill, which now passes the session gate that blocked it;
 *  - end closes the page and records nothing.
 */
async function relaySignIn(env: Env, userId: string, instanceId: string, run: ApplyRun, takeover: Pick<BrowserTakeover, "id">, suffix: HandoffSuffix, input?: unknown): Promise<unknown> {
	const runtime = await getLiveRuntime(env, instanceId, userId).catch(() => null);
	if (!runtime) throw new HttpError(409, "The Runner is disconnected. Start it (pags up) and take over again to sign in.");
	const signInId = signInIdFor(takeover.id);
	const post = (path: string, body: unknown) => callRuntime(env, runtime, path, { method: "POST", body: JSON.stringify(body) }).catch(() => null);

	if (suffix === "end" || suffix === "resume") {
		const res = await post(LOCAL_APPLY_SIGN_IN_END_PATH, { signInId, complete: suffix === "resume" });
		const status = res?.ok ? ((await runtimeJson(res)) as LocalApplySignInStatus) : null;
		if (suffix === "end") return status ?? { signInId, state: "closed" };
		if (!status?.signedIn) throw new HttpError(409, "The sign-in was not recorded: its page had already closed on the Runner. Open the live view, sign in, then press done.");
		const app = await getOwnedApplication(env, userId, run.applicationId);
		if (!app || app.fillRunId !== run.id) throw new HttpError(409, "The sign-in was recorded, but this application has moved on from that run; retry it from the board.");
		const retried = await retryFill(env, instanceId, userId, app);
		return { signIn: status, retry: { outcome: retried.kind, runId: retried.run?.id ?? null } };
	}

	const path = suffix === "frame" ? LOCAL_APPLY_SIGN_IN_FRAME_PATH : LOCAL_APPLY_SIGN_IN_INPUT_PATH;
	const body = suffix === "input" ? { signInId, input } : { signInId };
	const first = await post(path, body);
	if (first?.ok) return runtimeJson(first);
	const app = await getOwnedApplication(env, userId, run.applicationId);
	const url = app ? applicationCardLabel(app).url : "";
	if (!app || app.fillRunId !== run.id || !url) throw new HttpError(409, "This application has no job page to sign in on.");
	const opened = await post(LOCAL_APPLY_SIGN_IN_PATH, { signInId, browserProfile: run.policy.browserProfile, url });
	if (!opened) throw new HttpError(409, "The Runner did not answer; take over again once it is back.");
	if (opened.status === 404) {
		throw new HttpError(409, `This machine's runner${run.runnerVersion ? ` (${run.runnerVersion})` : ""} cannot open a sign-in after a run has ended. Update it (pags update) and take over again.`);
	}
	const status = (await runtimeJson(opened)) as LocalApplySignInStatus & { error?: string };
	if (!opened.ok) throw new HttpError(409, status.error ?? "The Runner refused to open the sign-in page.");
	if (status.state !== "ready") throw new HttpError(409, `The Runner could not open the application browser (${status.terminalReason ?? "unavailable"}).`);
	const again = await post(path, body);
	if (!again?.ok) throw new HttpError(409, "The sign-in page opened but is not answering; take over again.");
	return runtimeJson(again);
}

/**
 * #1100: the generic runtime-task takeover routes, for an application card. A fill paused for a login or
 * CAPTCHA is reached through its handoff (frame and input open or reuse it; resume relays and resumes the
 * fill). A fill that already ENDED blocked on a sign-in is reached through a sign-in with no run
 * (`relaySignIn`). Anything else is refused with its reason — never answered as "no session".
 */
export async function relayCardTakeover(env: Env, userId: string, instanceId: string, run: ApplyRun, takeover: Pick<BrowserTakeover, "id">, suffix: "frame" | "input" | "resume", input?: unknown): Promise<unknown> {
	if (blockedOnSignIn(run)) return relaySignIn(env, userId, instanceId, run, takeover, suffix, input);
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

/** Let go of a card's live view. Never gated and never fails the caller: a person must always be able to stop. */
export async function endCardTakeover(env: Env, userId: string, instanceId: string, run: ApplyRun, takeover: Pick<BrowserTakeover, "id">): Promise<void> {
	if (blockedOnSignIn(run)) {
		await relaySignIn(env, userId, instanceId, run, takeover, "end").catch(() => undefined);
		return;
	}
	const handoff = await getLocalApplyHandoffForRun(env, run.id, instanceId, userId);
	if (handoff && usableLocalApplyHandoff(handoff, Date.now())) await relayFillHandoff(env, userId, instanceId, run, handoff, "end").catch(() => undefined);
}
