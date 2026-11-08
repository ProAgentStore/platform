/** Exact-attempt, owner-scoped reconciliation persistence; never infers submission from missing events. */
import { HttpError } from "../auth.js";
import { trustedDocumentPreflightFailure } from "./preflight-failure.js";
import { runLogProvesNoSubmission } from "./run-log-proof.js";
import type { Env } from "../../types.js";
import type { JobApplication } from "../local-artifact/store.js";
import { fingerprintOf, jobIdentityOf, sameFingerprint, type ApprovalFingerprint } from "./approval.js";
import type { LocalApplyHandoffTerminalReason } from "./handoff-contract.js";
import { type ApplyRun, type LocalApplyHandoffState, getApplyRun, isTerminalApplyRun, moveApplication } from "./store.js";
type DB = Pick<Env, "DB"> & Partial<Pick<Env, "AGENT">>;

export type LocalApplyReconciliationState = "requested" | "no_submission_proven" | "submission_confirmed" | "ambiguous" | "unavailable" | "rejected";
/** A proof kind has no free text/evidence payload, by design. */
export type LocalApplyReconciliationProofKind = "authorized_site_history_no_submission" | "authorized_site_receipt_confirmed" | "ambiguous_site_history" | "authorized_profile_unavailable" | "run_native_call_log_no_submission";

export interface LocalApplyReconciliation {
	id: string;
	runId: string;
	applicationId: string;
	instanceId: string;
	state: LocalApplyReconciliationState;
	proofKind: LocalApplyReconciliationProofKind | null;
	/** Canonical application identity, not an employer URL. */
	jobIdentity: string;
	materialFingerprint: ApprovalFingerprint;
	requestedAt: number;
	resolvedAt: number | null;
}

interface ReconciliationRow {
	id: string;
	run_id: string;
	application_id: string;
	instance_id: string;
	reconciliation_state: LocalApplyReconciliationState;
	proof_kind: LocalApplyReconciliationProofKind | null;
	job_identity: string;
	material_lead_version: number | null;
	material_profile_version: string | null;
	material_resume_sha: string | null;
	material_cover_letter_sha: string | null;
	requested_at: number;
	resolved_at: number | null;
}

const presentReconciliation = (r: ReconciliationRow): LocalApplyReconciliation => ({
	id: r.id,
	runId: r.run_id,
	applicationId: r.application_id,
	instanceId: r.instance_id,
	state: r.reconciliation_state,
	proofKind: r.proof_kind,
	jobIdentity: r.job_identity,
	materialFingerprint: {
		leadVersion: r.material_lead_version,
		profileVersion: r.material_profile_version,
		resumeSha: r.material_resume_sha,
		coverLetterSha: r.material_cover_letter_sha,
	},
	requestedAt: r.requested_at,
	resolvedAt: r.resolved_at,
});

/** Native code may have external effects even when no supervised submit was observed. */
export function fullUnverifiedAttempt(run: ApplyRun, app?: Pick<JobApplication, "submitAttemptedAt">): boolean {
	const result = run.result;
	const submitted = !!result && typeof result === "object" && "outcome" in result && result.outcome === "submitted";
	return run.policy.toolAccess === "full" && isTerminalApplyRun(run.status) && run.status !== "submitted" && !submitted && (app?.submitAttemptedAt != null || !trustedDocumentPreflightFailure(run));
}

const uncertainAttemptBinding = (app: JobApplication, run: ApplyRun): boolean =>
	app.id === run.applicationId && app.fillRunId === run.id && (
		app.status === "blocked" && app.blockReason === "submit_unconfirmed" && app.submitAttemptedAt !== null && run.status === "blocked" ||
		["blocked", "failed", "awaiting_review", "cancelled", "materials_ready", "deferred"].includes(app.status) && fullUnverifiedAttempt(run, app)
	);

// Recheck the same conditions in SQL, atomically with persistence; stale in-memory bindings cannot grant proof.
const UNCERTAIN_SQL = `(a.status = 'blocked' AND a.block_reason = 'submit_unconfirmed' AND a.submit_attempted_at IS NOT NULL AND r.status = 'blocked'
 OR (a.status IN ('blocked','failed','awaiting_review','cancelled','materials_ready','deferred') AND r.status IN ('blocked','failed','awaiting_review','cancelled')
 AND json_extract(r.policy, '$.toolAccess') = 'full' AND COALESCE(json_extract(r.result, '$.outcome'), '') <> 'submitted'))`;

/** Proof is exact-run/material bound. Owner assertions and absent submit events cannot clear Full-mode uncertainty. */
export async function fullSubmissionNeedsReconciliation(env: DB, uid: string, app: JobApplication, run: ApplyRun | null): Promise<boolean> {
	if (!run) return !!app.fillRunId;
	if (!fullUnverifiedAttempt(run, app) || app.fillRunId !== run.id) return false;
	if (reconciliationProvesNoSubmission(await getLocalApplyReconciliation(env, run.id, run.instanceId, uid), app, run)) return false;
	return !reconciliationProvesNoSubmission(await proveNoSubmissionFromRunLog(env, uid, app, run), app, run);
}

/**
 * #1579: the run's own complete, retained native-call log is exact-run proof that nothing was sent.
 * Persisted as an ordinary reconciliation record bound to the run and the current materials. It may
 * replace an inconclusive (ambiguous/unavailable/requested) record but never a proven or confirmed one.
 */
export async function proveNoSubmissionFromRunLog(env: DB, uid: string, app: JobApplication, run: ApplyRun, now = Date.now()): Promise<LocalApplyReconciliation | null> {
	const existing = await getLocalApplyReconciliation(env, run.id, run.instanceId, uid);
	if (existing && (existing.state === "no_submission_proven" || existing.state === "submission_confirmed")) return existing;
	if (!uncertainAttemptBinding(app, run) || !(await runLogProvesNoSubmission(env, uid, app, run))) return existing;
	const requested = existing ?? await requestLocalApplyReconciliation(env, { app, run, userId: uid, actor: "system" }, now);
	if (!requested || requested.jobIdentity !== jobIdentityOf(app)) return existing;
	if (requested.state !== "requested") {
		const fp = fingerprintOf(app);
		const reset = await env.DB.prepare(
			`UPDATE local_apply_reconciliations SET reconciliation_state = 'requested', proof_kind = NULL, resolved_at = NULL, updated_at = ?1,
			   material_lead_version = ?2, material_profile_version = ?3, material_resume_sha = ?4, material_cover_letter_sha = ?5
			 WHERE id = ?6 AND run_id = ?7 AND user_id = ?8 AND reconciliation_state IN ('ambiguous', 'unavailable', 'rejected')`,
		).bind(now, fp.leadVersion, fp.profileVersion, fp.resumeSha, fp.coverLetterSha, requested.id, run.id, uid).run();
		if ((reset.meta?.changes ?? 0) === 0) return existing;
	}
	const fresh = await getLocalApplyReconciliation(env, run.id, run.instanceId, uid);
	if (!fresh) return existing;
	return (await recordLocalApplyReconciliationProof(env, { reconciliation: fresh, app, run, userId: uid, state: "no_submission_proven", proofKind: "run_native_call_log_no_submission", actor: "system" }, now)) ?? existing;
}

export async function assertFullSubmissionReconciled(env: DB, uid: string, app: JobApplication): Promise<void> {
	if (!app.fillRunId) return;
	const prior = await env.DB.prepare("SELECT instance_id FROM local_apply_runs WHERE id = ?1 AND user_id = ?2 AND application_id = ?3").bind(app.fillRunId, uid, app.id).first<{ instance_id: string }>();
	if (!prior) throw new HttpError(409, "The previous fill attempt could not be verified. Reload and reconcile its exact owner/application binding before another fill.");
	const run = await getApplyRun(env, prior.instance_id, uid, app.fillRunId);
	if (await fullSubmissionNeedsReconciliation(env, uid, app, run)) throw new HttpError(409, "The previous Full browser run has unverified external effects. Reconcile this exact attempt before approving or starting another fill; no observed submit is not proof that nothing was sent.");
}

/** The owner can request site-history reconciliation only for the exact ended uncertain attempt. */
export async function requestLocalApplyReconciliation(
	env: DB,
	input: { app: JobApplication; run: ApplyRun; userId: string; actor?: "owner" | "system" },
	now: number,
): Promise<LocalApplyReconciliation | null> {
	if (!uncertainAttemptBinding(input.app, input.run)) return null;
	const fp = fingerprintOf(input.app);
	const identity = jobIdentityOf(input.app);
	const id = crypto.randomUUID();
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO local_apply_reconciliations
			   (id, run_id, application_id, instance_id, user_id, reconciliation_state, job_identity,
			    material_lead_version, material_profile_version, material_resume_sha, material_cover_letter_sha,
			    requested_at, created_at, updated_at)
			 SELECT ?1, ?2, ?3, ?4, ?5, 'requested', ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?11
			   FROM local_apply_runs r
			  WHERE r.id = ?2 AND r.instance_id = ?4 AND r.user_id = ?5 AND r.application_id = ?3
			    AND EXISTS (
			      SELECT 1 FROM job_applications a
			       WHERE a.id = ?3 AND a.user_id = ?5 AND a.fill_run_id = ?2
			         AND ${UNCERTAIN_SQL}
			         AND ?6 = json_object('sourceInstanceId', a.source_instance_id, 'leadId', a.lead_id, 'workKey', a.work_key, 'lifecycleVersion', a.lifecycle_version)
			         AND a.lifecycle_version IS ?7 AND a.profile_version IS ?8
			         AND json_extract(a.resume_artifact, '$.sha256') IS ?9 AND json_extract(a.cover_letter_artifact, '$.sha256') IS ?10
			    )
			 ON CONFLICT(run_id) DO NOTHING`,
		)
			.bind(id, input.run.id, input.app.id, input.run.instanceId, input.userId, identity, fp.leadVersion, fp.profileVersion, fp.resumeSha, fp.coverLetterSha, now),
		env.DB.prepare(
			`INSERT OR IGNORE INTO local_apply_reconciliation_events (id, reconciliation_id, user_id, actor, event_type, created_at)
			 SELECT ?1, ?2, ?3, ?4, 'requested', ?5
			 WHERE EXISTS (SELECT 1 FROM local_apply_reconciliations WHERE id = ?2)`,
		)
			.bind(crypto.randomUUID(), id, input.userId, input.actor ?? "owner", now),
	]);
	const row = await env.DB.prepare("SELECT * FROM local_apply_reconciliations WHERE run_id = ?1 AND instance_id = ?2 AND user_id = ?3 AND application_id = ?4")
		.bind(input.run.id, input.run.instanceId, input.userId, input.app.id)
		.first<ReconciliationRow>();
	return row ? presentReconciliation(row) : null;
}

export async function getLocalApplyReconciliation(env: DB, runId: string, instanceId: string, userId: string): Promise<LocalApplyReconciliation | null> {
	const row = await env.DB.prepare("SELECT * FROM local_apply_reconciliations WHERE run_id = ?1 AND instance_id = ?2 AND user_id = ?3")
		.bind(runId, instanceId, userId)
		.first<ReconciliationRow>();
	return row ? presentReconciliation(row) : null;
}

/**
 * Bounded cron input for reconciliation runtime cleanup.  The browser owns the actual deadline;
 * this lets the cloud pull its terminal, closed-vocabulary result into the audited CAS record even
 * when the owner has closed Console and never polls the handoff again.
 */
export async function activeLocalApplyReconciliations(env: DB, limit: number): Promise<Array<{ id: string; runId: string; applicationId: string; instanceId: string; userId: string }>> {
	const { results } = await env.DB.prepare(
		"SELECT id, run_id, application_id, instance_id, user_id FROM local_apply_reconciliations WHERE reconciliation_state = 'requested' ORDER BY requested_at LIMIT ?1",
	).bind(limit).all<{ id: string; run_id: string; application_id: string; instance_id: string; user_id: string }>();
	return (results ?? []).map((r) => ({ id: r.id, runId: r.run_id, applicationId: r.application_id, instanceId: r.instance_id, userId: r.user_id }));
}

/** Opaque mobile-control metadata for the separately-authorized reconciliation browser only. */
export interface LocalApplyReconciliationHandoff {
	continuityId: string; reconciliationId: string; runId: string; applicationId: string; instanceId: string;
	browserProfile: string; state: LocalApplyHandoffState; terminalReason: LocalApplyHandoffTerminalReason | null; expiresAt: number;
}
interface ReconciliationHandoffRow { continuity_id: string; reconciliation_id: string; run_id: string; application_id: string; instance_id: string; browser_profile: string; state: LocalApplyHandoffState; terminal_reason: LocalApplyHandoffTerminalReason | null; expires_at: number; }
const presentReconciliationHandoff = (r: ReconciliationHandoffRow): LocalApplyReconciliationHandoff => ({ continuityId: r.continuity_id, reconciliationId: r.reconciliation_id, runId: r.run_id, applicationId: r.application_id, instanceId: r.instance_id, browserProfile: r.browser_profile, state: r.state, terminalReason: r.terminal_reason, expiresAt: r.expires_at });

export async function createLocalApplyReconciliationHandoff(env: DB, input: { reconciliation: LocalApplyReconciliation; run: ApplyRun; app: JobApplication; userId: string; browserProfile: string; expiresAt: number }, now: number): Promise<LocalApplyReconciliationHandoff | null> {
	if (!uncertainAttemptBinding(input.app, input.run) || input.reconciliation.state !== "requested" || input.reconciliation.applicationId !== input.app.id || input.reconciliation.runId !== input.run.id || input.reconciliation.instanceId !== input.run.instanceId || !sameFingerprint(input.reconciliation.materialFingerprint, fingerprintOf(input.app)) || input.reconciliation.jobIdentity !== jobIdentityOf(input.app) || input.browserProfile !== input.run.policy.browserProfile || input.expiresAt <= now) return null;
	await env.DB.prepare(
		`INSERT INTO local_apply_reconciliation_handoffs (id, continuity_id, reconciliation_id, run_id, application_id, instance_id, user_id, browser_profile, state, expires_at, created_at, updated_at)
		 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'requested', ?9, ?10, ?10
		 WHERE EXISTS (SELECT 1 FROM local_apply_reconciliations WHERE id = ?3 AND run_id = ?4 AND application_id = ?5 AND instance_id = ?6 AND user_id = ?7 AND reconciliation_state = 'requested')
		 ON CONFLICT(reconciliation_id) DO NOTHING`,
	).bind(crypto.randomUUID(), crypto.randomUUID(), input.reconciliation.id, input.run.id, input.app.id, input.run.instanceId, input.userId, input.browserProfile, input.expiresAt, now).run();
	return getLocalApplyReconciliationHandoff(env, input.reconciliation.id, input.run.instanceId, input.userId);
}
export async function getLocalApplyReconciliationHandoff(env: DB, reconciliationId: string, instanceId: string, userId: string): Promise<LocalApplyReconciliationHandoff | null> {
	const row = await env.DB.prepare("SELECT * FROM local_apply_reconciliation_handoffs WHERE reconciliation_id = ?1 AND instance_id = ?2 AND user_id = ?3").bind(reconciliationId, instanceId, userId).first<ReconciliationHandoffRow>();
	return row ? presentReconciliationHandoff(row) : null;
}
export async function getLocalApplyReconciliationHandoffById(env: DB, instanceId: string, userId: string, continuityId: string): Promise<LocalApplyReconciliationHandoff | null> {
	const row = await env.DB.prepare("SELECT * FROM local_apply_reconciliation_handoffs WHERE continuity_id = ?1 AND instance_id = ?2 AND user_id = ?3").bind(continuityId, instanceId, userId).first<ReconciliationHandoffRow>();
	return row ? presentReconciliationHandoff(row) : null;
}
export async function markLocalApplyReconciliationHandoff(env: DB, input: { continuityId: string; reconciliationId: string; instanceId: string; userId: string; state: Exclude<LocalApplyHandoffState, "requested">; terminalReason?: LocalApplyHandoffTerminalReason }, now: number): Promise<LocalApplyReconciliationHandoff | null> {
	if ((input.state === "closed") !== !!input.terminalReason) return null;
	const result = await env.DB.prepare(
		`UPDATE local_apply_reconciliation_handoffs SET state = ?1, terminal_reason = ?2, activated_at = CASE WHEN ?1 = 'ready' AND activated_at IS NULL THEN ?3 ELSE activated_at END, ended_at = CASE WHEN ?1 = 'closed' THEN ?3 ELSE ended_at END, updated_at = ?3
		 WHERE continuity_id = ?4 AND reconciliation_id = ?5 AND instance_id = ?6 AND user_id = ?7 AND state IN ('requested','ready') AND (?1 <> 'ready' OR expires_at > ?3)`,
	).bind(input.state, input.terminalReason ?? null, now, input.continuityId, input.reconciliationId, input.instanceId, input.userId).run();
	if ((result.meta?.changes ?? 0) === 0) return null;
	return getLocalApplyReconciliationHandoff(env, input.reconciliationId, input.instanceId, input.userId);
}

function validReconciliationProof(state: LocalApplyReconciliationState, proofKind: LocalApplyReconciliationProofKind): boolean {
	return (state === "no_submission_proven" && (proofKind === "authorized_site_history_no_submission" || proofKind === "run_native_call_log_no_submission")) ||
		(state === "submission_confirmed" && proofKind === "authorized_site_receipt_confirmed") ||
		(state === "ambiguous" && proofKind === "ambiguous_site_history") ||
		(state === "unavailable" && proofKind === "authorized_profile_unavailable");
}

/**
 * Records a closed-vocabulary reconciliation result.  This deliberately cannot clear
 * `submit_attempted_at`, restart a run, grant an approval, or write a receipt URL.  Consumers must
 * separately make an explicit audited owner decision before any future continuation.
 */
export async function recordLocalApplyReconciliationProof(
	env: DB,
	input: { reconciliation: LocalApplyReconciliation; app: JobApplication; run: ApplyRun; userId: string; state: Exclude<LocalApplyReconciliationState, "requested" | "rejected">; proofKind: LocalApplyReconciliationProofKind; actor?: "owner" | "runner" | "system" },
	now: number,
): Promise<LocalApplyReconciliation | null> {
	if (!validReconciliationProof(input.state, input.proofKind) || !uncertainAttemptBinding(input.app, input.run)) return null;
	if (input.reconciliation.applicationId !== input.app.id || input.reconciliation.runId !== input.run.id || input.reconciliation.instanceId !== input.run.instanceId || input.reconciliation.jobIdentity !== jobIdentityOf(input.app) || !sameFingerprint(input.reconciliation.materialFingerprint, fingerprintOf(input.app))) return null;
	const res = await env.DB.prepare(
		`UPDATE local_apply_reconciliations
		    SET reconciliation_state = ?1, proof_kind = ?2, resolved_at = ?3, updated_at = ?3
		  WHERE id = ?4 AND run_id = ?5 AND application_id = ?6 AND instance_id = ?7 AND user_id = ?8
		    AND reconciliation_state = 'requested'
		    AND job_identity = ?9
		    AND material_lead_version IS ?10 AND material_profile_version IS ?11
		    AND material_resume_sha IS ?12 AND material_cover_letter_sha IS ?13
		    AND EXISTS (
		      SELECT 1 FROM local_apply_runs r JOIN job_applications a ON a.id = r.application_id
		       WHERE r.id = ?5 AND r.instance_id = ?7 AND r.user_id = ?8 AND r.application_id = ?6
		         AND a.user_id = ?8 AND a.fill_run_id = ?5 AND ${UNCERTAIN_SQL}
		         AND ?9 = json_object('sourceInstanceId', a.source_instance_id, 'leadId', a.lead_id, 'workKey', a.work_key, 'lifecycleVersion', a.lifecycle_version)
		         AND a.lifecycle_version IS ?10 AND a.profile_version IS ?11
		         AND json_extract(a.resume_artifact, '$.sha256') IS ?12 AND json_extract(a.cover_letter_artifact, '$.sha256') IS ?13
		    )`,
	)
		.bind(input.state, input.proofKind, now, input.reconciliation.id, input.run.id, input.app.id, input.run.instanceId, input.userId, input.reconciliation.jobIdentity, input.reconciliation.materialFingerprint.leadVersion, input.reconciliation.materialFingerprint.profileVersion, input.reconciliation.materialFingerprint.resumeSha, input.reconciliation.materialFingerprint.coverLetterSha)
		.run();
	if ((res.meta?.changes ?? 0) === 0) return null;
	await env.DB.prepare(
		"INSERT INTO local_apply_reconciliation_events (id, reconciliation_id, user_id, actor, event_type, reason_code, created_at) VALUES (?1, ?2, ?3, ?4, 'proof_recorded', ?5, ?6)",
	)
		.bind(crypto.randomUUID(), input.reconciliation.id, input.userId, input.actor ?? "runner", input.proofKind, now)
		.run();
	return getLocalApplyReconciliation(env, input.run.id, input.run.instanceId, input.userId);
}

/**
 * Strict prerequisite for a later owner-authorized continuation.  It is intentionally only a
 * predicate: it never creates a run, replaces an approval, or makes an uncertain attempt retryable.
 */
export function reconciliationProvesNoSubmission(reconciliation: LocalApplyReconciliation | null, app: JobApplication, run: ApplyRun): boolean {
	return !!reconciliation && reconciliation.state === "no_submission_proven" && (reconciliation.proofKind === "authorized_site_history_no_submission" || reconciliation.proofKind === "run_native_call_log_no_submission") && uncertainAttemptBinding(app, run) && reconciliation.applicationId === app.id && reconciliation.runId === run.id && reconciliation.instanceId === run.instanceId && reconciliation.jobIdentity === jobIdentityOf(app) && sameFingerprint(reconciliation.materialFingerprint, fingerprintOf(app));
}

/**
 * Make the resolution visible in the application's ordinary, append-only lifecycle audit.  It is
 * deliberately a `blocked → blocked` move: the original `submit_unconfirmed` event is retained,
 * `submit_attempted_at` remains set, and this operation neither creates a retry nor changes any
 * submit authorization.  A caller must still require a new explicit owner decision for anything
 * beyond this historical reconciliation record.
 */
export async function auditReconciledNoSubmission(
	env: DB,
	input: { reconciliation: LocalApplyReconciliation; app: JobApplication; run: ApplyRun; userId: string; actorInstanceId?: string },
	now: number,
): Promise<boolean> {
	if (!reconciliationProvesNoSubmission(input.reconciliation, input.app, input.run)) return false;
	const durable = await getLocalApplyReconciliation(env, input.run.id, input.run.instanceId, input.userId);
	if (!durable || durable.id !== input.reconciliation.id || !reconciliationProvesNoSubmission(durable, input.app, input.run)) return false;
	const moved = await moveApplication(
		env,
		input.app,
		input.userId,
		{
			to: "blocked",
			actor: "owner",
			actorInstanceId: input.actorInstanceId,
			runId: input.run.id,
			expectRun: input.run.id,
			reason: "submit_unconfirmed_reconciled_no_submission",
			questions: ["The authorized profile recorded no submission. This application remains blocked: its original submit attempt marker is retained and any future action requires a separate explicit owner decision."],
		},
		now,
	);
	if (!moved) return false;
	await env.DB.prepare(
		"INSERT INTO local_apply_reconciliation_events (id, reconciliation_id, user_id, actor, event_type, reason_code, created_at) VALUES (?1, ?2, ?3, 'owner', 'state_transition', 'no_submission_proven', ?4)",
	)
		.bind(crypto.randomUUID(), input.reconciliation.id, input.userId, now)
		.run();
	return true;
}
