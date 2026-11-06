/** Scoped authorization delivery to one still-live owner review; never recovers an ended run. */
import type { Env } from "../../types.js";
import { HttpError } from "../auth.js";
import { getOwnedApplication, type JobApplication } from "../local-artifact/store.js";
import { cliAtLeast } from "../runner-upgrade.js";
import { getLiveRuntime } from "../../routes/instances-runtime.js";
import { runnerSettingsFor } from "./runner-settings.js";
import { fingerprintOf, sameFingerprint, type SubmitAuthorization } from "./approval.js";
import { getSubmitAuthorization } from "./approval-store.js";
import type { LocalApplyDirectiveRequest } from "./contract.js";
import { submitGateFor } from "./submission-gate.js";
import { getApplyRun, updateApplyRun, type ApplyRun } from "./store.js";
import { getSupervisorCheckpoint, type SupervisorDirective } from "./supervision.js";

const minimum = "0.4.231";
function refused(why: string): never { throw new HttpError(409, `The live review cannot continue: ${why}. No new fill was started.`); }

export function liveReviewCheckpoint(run: ApplyRun): string | null {
	return run.status === "paused" && run.pause?.reason === "supervisor_checkpoint" && run.pause.checkpoint?.facts.reviewWait
		? run.pause.checkpoint.checkpointId : null;
}

function assertBinding(app: JobApplication | null, run: ApplyRun | null, auth: SubmitAuthorization | null, checkpointId: string, now: number): asserts app is JobApplication {
	if (!app || !run || !auth || app.id !== run.applicationId || app.fillRunId !== run.id || auth.applicationId !== app.id) refused("application/run binding changed");
	if (liveReviewCheckpoint(run) !== checkpointId || (run.pause?.checkpoint?.facts.reviewWait?.expiresAt ?? 0) <= now) refused("the exact review checkpoint ended or expired");
	if (app.status !== "awaiting_review" || app.submitAttemptedAt || auth.revokedAt || !sameFingerprint(auth.fingerprint, fingerprintOf(app))) refused("approval or materials changed");
	if (auth.consumedRunId && auth.consumedRunId !== run.id) refused("another run already holds this approval");
}

/** Persist the grant's exact-run claim and policy before any relay delivery. */
export async function prepareLiveReviewApproval(env: Env, uid: string, app: JobApplication, run: ApplyRun, auth: SubmitAuthorization, now: number): Promise<ApplyRun> {
	const checkpointId = liveReviewCheckpoint(run);
	if (!checkpointId) return run;
	const current = await getOwnedApplication(env, uid, app.id);
	let fresh = await getApplyRun(env, run.instanceId, uid, run.id);
	const grant = await getSubmitAuthorization(env, app.id, uid);
	assertBinding(current, fresh, grant, checkpointId, now);
	if (current.stateVersion !== app.stateVersion || grant!.id !== auth.id) refused("the reviewed version changed");
	const runtime = await getLiveRuntime(env, run.instanceId, uid);
	if (!runtime || !cliAtLeast(runtime.runner_version, minimum)) refused(`the connected runner must be ${minimum} or newer`);
	if (grant!.consumedRunId !== run.id) {
		const settings = await runnerSettingsFor(env, run.instanceId, uid);
		const gate = await submitGateFor(env, run.instanceId, uid, current, { ...settings, allowDomains: run.policy.allowDomains }, now, { excludeRunId: run.id });
		if (!gate.allowed || gate.authorizationId !== grant!.id) refused(`submission checks failed (${gate.checks.filter(c => !c.ok).map(c => c.check).join(", ")})`);
		// Bind the claim atomically to the same application revision, materials, run and checkpoint.
		await env.DB.batch([env.DB.prepare(`UPDATE job_application_submit_authorizations SET consumed_at = ?1, consumed_run_id = ?2
		 WHERE id = ?3 AND user_id = ?4 AND consumed_at IS NULL AND revoked_at IS NULL AND approval_kind = 'standard'
		 AND EXISTS (SELECT 1 FROM job_applications a JOIN local_apply_runs r ON r.id = a.fill_run_id
		 WHERE a.id = ?5 AND a.user_id = ?4 AND a.state_version = ?6 AND a.status = 'awaiting_review'
		 AND a.submit_attempted_at IS NULL AND r.id = ?2 AND r.instance_id = ?7 AND r.user_id = ?4 AND r.status = 'paused'
		 AND json_extract(r.pause, '$.checkpoint.checkpointId') = ?8 AND json_extract(r.pause, '$.checkpoint.facts.reviewWait.expiresAt') > ?1
		 AND a.lifecycle_version IS fingerprint_lead_version AND a.profile_version IS fingerprint_profile
		 AND json_extract(a.resume_artifact, '$.sha256') IS fingerprint_resume_sha AND json_extract(a.cover_letter_artifact, '$.sha256') IS fingerprint_cover_sha)`)
			.bind(now, run.id, grant!.id, uid, app.id, app.stateVersion, run.instanceId, checkpointId),
			env.DB.prepare(`UPDATE local_apply_runs SET policy = ?1, updated_at = ?2 WHERE id = ?3 AND instance_id = ?4 AND user_id = ?5 AND status = 'paused'
			 AND json_extract(pause, '$.checkpoint.checkpointId') = ?6
			 AND EXISTS (SELECT 1 FROM job_application_submit_authorizations WHERE id = ?7 AND user_id = ?5 AND consumed_run_id = ?3 AND consumed_at = ?2 AND revoked_at IS NULL)`)
				.bind(JSON.stringify({ ...fresh!.policy, mode: "auto_submit", gate: { allowed: true, gateId: grant!.id, checks: gate.checks } }), now, run.id, run.instanceId, uid, checkpointId, grant!.id),
		]);
		const spent = await getSubmitAuthorization(env, app.id, uid);
		if (spent?.id !== grant!.id || spent.consumedRunId !== run.id || spent.revokedAt) refused("the approval claim changed");
		fresh = await getApplyRun(env, run.instanceId, uid, run.id);
		assertBinding(await getOwnedApplication(env, uid, app.id), fresh, spent, checkpointId, now);
		if (fresh!.policy.mode !== "auto_submit" || fresh!.policy.gate.gateId !== spent.id) refused("the policy claim was not recorded");
		await updateApplyRun(env, fresh!, { events: [{ type: "policy.submit_gate", at: new Date(now).toISOString(), detail: { mode: "auto_submit", decision: "allowed", gateId: spent.id, basis: "live_review_approval", checkpointId } }] }, now);
	}
	// The claim and policy are one transaction; a repeated response cannot mint another gate.
	if (fresh!.policy.mode !== "auto_submit" || !fresh!.policy.gate.allowed || fresh!.policy.gate.gateId !== grant!.id) refused("the recorded submission policy does not match this approval");
	return fresh!;
}

/** Rebuild a delivery only from the durable exact grant; prose or generic continue is insufficient. */
export async function reviewDirectiveAuthorization(env: Env, uid: string, run: ApplyRun, directive: SupervisorDirective, version: string | null, _now: number): Promise<LocalApplyDirectiveRequest["submitAuthorization"]> {
	const checkpoint = await getSupervisorCheckpoint(env, run, directive.checkpointId);
	if (!checkpoint?.facts.reviewWait || directive.directive !== "continue") return undefined;
	if (!cliAtLeast(version, minimum)) refused(`the connected runner must be ${minimum} or newer`);
	const app = await getOwnedApplication(env, uid, run.applicationId);
	const current = await getApplyRun(env, run.instanceId, uid, run.id);
	const auth = await getSubmitAuthorization(env, run.applicationId, uid);
	// A lost relay response can arrive after status sync has observed the same run resume.
	// Reconstruct only the already-consumed grant; the runtime checks first delivery expiry
	// and recognizes an identical replay without granting a second submission.
	if (!app || !current || !auth || app.id !== current.applicationId || app.fillRunId !== current.id || auth.applicationId !== app.id) refused("application/run binding changed");
	if (current.status !== "running" && liveReviewCheckpoint(current) !== directive.checkpointId) refused("the exact review run ended or moved to another checkpoint");
	if (!["awaiting_review", "filling"].includes(app.status) || auth.revokedAt || !sameFingerprint(auth.fingerprint, fingerprintOf(app))) refused("approval or materials changed");
	if (!auth.consumedAt || auth.consumedAt >= checkpoint.facts.reviewWait.expiresAt) refused("the grant was not consumed within the review deadline");
	if (directive.idempotencyKey !== `continue:${auth!.id}` || auth!.consumedRunId !== run.id || current!.policy.mode !== "auto_submit" || !current!.policy.gate.allowed || current!.policy.gate.gateId !== auth!.id) refused("no scoped submission authorization is bound to this directive");
	return { id: auth!.id, gateId: auth!.id, instanceId: run.instanceId, applicationId: app.id, artifacts: [{ kind: "resume", sha256: app.resumeArtifact!.sha256 }, { kind: "cover_letter", sha256: app.coverLetterArtifact!.sha256 }] };
}
