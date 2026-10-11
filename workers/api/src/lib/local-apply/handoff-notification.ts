/**
 * The notification half of a bounded local-apply handoff. The durable state and the page remain
 * separate: this module only joins an already-paused run to the existing owner-attention policy.
 */
import type { Env } from "../../types.js";
import { callRuntime, getLiveRuntime, runtimeJson } from "../../routes/instances-runtime.js";
import { type AttentionDeps, requestOwnerAttention } from "../owner-attention.js";
import { getOwnedApplication } from "../local-artifact/store.js";
import { LOCAL_APPLY_HANDOFF_PATH, LOCAL_APPLY_HANDOFF_STATUS_PATH, type LocalApplyHandoffStatus, type LocalApplyPause } from "./contract.js";
import { type ApplyRun, createLocalApplyHandoff, markLocalApplyHandoff, usableLocalApplyHandoff } from "./store.js";

const HANDOFF_TTL_MS = 10 * 60_000;

/**
 * A login or CAPTCHA pause may open one exact-page handoff for the existing owner browser. It
 * never wakes a profile, carries browser material to the cloud, or treats a redirect as proof of
 * a completed site step.
 */
export async function notifyLiveBrowserBlocker(
	env: Env,
	uid: string,
	run: ApplyRun,
	pause: LocalApplyPause,
	now: number,
	attentionDeps: AttentionDeps<Env>,
): Promise<void> {
	if (!( ["login_required", "captcha"] as const).includes(pause.reason as "login_required" | "captcha")) return;
	if (run.policy.browserProfile !== "default") return;
	const app = await getOwnedApplication(env, uid, run.applicationId);
	if (!app || app.fillRunId !== run.id) return;
	let handoff = await createLocalApplyHandoff(env, { run, app, userId: uid, browserProfile: run.policy.browserProfile, expiresAt: now + HANDOFF_TTL_MS }, now);
	if (!handoff || !usableLocalApplyHandoff(handoff, now)) return;
	const runtime = await getLiveRuntime(env, run.instanceId, uid).catch(() => null);
	if (!runtime) {
		await markLocalApplyHandoff(env, { continuityId: handoff.continuityId, instanceId: run.instanceId, userId: uid, state: "closed", terminalReason: "runner_restarted" }, now);
		return;
	}
	const request = { handoffId: handoff.continuityId, runId: run.id, applicationId: run.applicationId, browserProfile: run.policy.browserProfile };
	const path = handoff.state === "requested" ? LOCAL_APPLY_HANDOFF_PATH : LOCAL_APPLY_HANDOFF_STATUS_PATH;
	const res = await callRuntime(env, runtime, path, { method: "POST", body: JSON.stringify(request) }).catch(() => null);
	if (!res) {
		await markLocalApplyHandoff(env, { continuityId: handoff.continuityId, instanceId: run.instanceId, userId: uid, state: "closed", terminalReason: "runner_restarted" }, now);
		return;
	}
	const status = await runtimeJson(res) as LocalApplyHandoffStatus;
	if (!res.ok || status.state !== "ready") {
		await markLocalApplyHandoff(env, {
			continuityId: handoff.continuityId,
			instanceId: run.instanceId,
			userId: uid,
			state: "closed",
			terminalReason: status.terminalReason ?? "unavailable",
		}, now);
		return;
	}
	handoff = (await markLocalApplyHandoff(env, { continuityId: handoff.continuityId, instanceId: run.instanceId, userId: uid, state: "ready" }, now)) ?? handoff;
	const title = pause.reason === "captcha" ? "A CAPTCHA needs your help" : "Sign in to continue an application";
	await requestOwnerAttention(env, {
		event: "blocker_required",
		userId: uid,
		instanceId: run.instanceId,
		subject: { kind: "application-handoff", instanceId: run.instanceId, handoffId: handoff.continuityId },
		about: { kind: "application-handoff", id: handoff.continuityId, state: run.id },
		notificationType: "apply",
		title,
		body: "Open the live Application Runner browser on this device, complete the site step, then choose Resume. This does not submit the application.",
	}, attentionDeps);
}
