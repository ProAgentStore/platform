/**
 * The per-application submission authorization in D1 (#973, migration 0190).
 *
 * The RULES are pure and live in `approval.ts`; this is the store around them. Two operations here
 * are atomic on purpose, because both are the difference between one submission and two:
 *
 *   · granting   — `INSERT … ON CONFLICT DO NOTHING` then read back. A double-clicked button, a
 *                  replayed MCP call and a redelivered event all converge on the row that exists
 *                  rather than minting a second authorization.
 *   · consuming  — `UPDATE … WHERE consumed_at IS NULL`, and the caller only treats the
 *                  authorization as spent when that update changed a row. Two dispatches racing for
 *                  one approval therefore cannot both believe they hold it.
 */
import type { Env } from "../../types.js";
import { type ApprovableApplication, type ApprovalFingerprint, type SubmitAuthorization, fingerprintOf } from "./approval.js";

type DB = Pick<Env, "DB">;

interface Row {
	id: string;
	application_id: string;
	instance_id: string;
	approved_by: string;
	approved_at: number;
	approved_state_version: number;
	approved_status: string;
	idempotency_key: string;
	fingerprint_lead_version: number | null;
	fingerprint_profile: string | null;
	fingerprint_resume_sha: string | null;
	fingerprint_cover_sha: string | null;
	consumed_at: number | null;
	consumed_run_id: string | null;
	revoked_at: number | null;
	revoked_reason: string | null;
}

const view = (r: Row): SubmitAuthorization => ({
	id: r.id,
	applicationId: r.application_id,
	instanceId: r.instance_id,
	approvedBy: r.approved_by,
	approvedAt: r.approved_at,
	approvedStateVersion: r.approved_state_version,
	approvedStatus: r.approved_status,
	idempotencyKey: r.idempotency_key,
	fingerprint: {
		leadVersion: r.fingerprint_lead_version,
		profileVersion: r.fingerprint_profile,
		resumeSha: r.fingerprint_resume_sha,
		coverLetterSha: r.fingerprint_cover_sha,
	},
	consumedAt: r.consumed_at,
	consumedRunId: r.consumed_run_id,
	revokedAt: r.revoked_at,
	revokedReason: r.revoked_reason,
});

/** The application's authorization, spent or live — the card and the gate both read this. */
export async function getSubmitAuthorization(env: DB, applicationId: string, userId: string): Promise<SubmitAuthorization | null> {
	const row = await env.DB.prepare("SELECT * FROM job_application_submit_authorizations WHERE application_id = ?1 AND user_id = ?2")
		.bind(applicationId, userId)
		.first<Row>();
	return row ? view(row) : null;
}

export type GrantOutcome = { kind: "granted" | "existing"; authorization: SubmitAuthorization };

/**
 * Grant one authorization for one application, idempotently.
 *
 * `existing` is returned for ANY prior row — including one whose idempotency key differs. The
 * unique constraint is on the application, so the alternative would be to report a conflict the
 * caller can do nothing about; the pure `approvalEligibility` has already refused the cases where a
 * second grant would be wrong (a live approval, or one a run already spent).
 */
export async function grantSubmitAuthorization(
	env: DB,
	input: { app: ApprovableApplication; instanceId: string; userId: string; approvedBy: string; idempotencyKey: string },
	now: number,
): Promise<GrantOutcome> {
	const fp: ApprovalFingerprint = fingerprintOf(input.app);
	const id = crypto.randomUUID();
	await env.DB.prepare(
		`INSERT INTO job_application_submit_authorizations
		   (id, application_id, instance_id, user_id, approved_by, approved_at, approved_state_version, approved_status,
		    idempotency_key, fingerprint_lead_version, fingerprint_profile, fingerprint_resume_sha, fingerprint_cover_sha)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
		 ON CONFLICT DO NOTHING`,
	)
		.bind(
			id,
			input.app.id,
			input.instanceId,
			input.userId,
			input.approvedBy,
			now,
			input.app.stateVersion,
			input.app.status,
			input.idempotencyKey,
			fp.leadVersion,
			fp.profileVersion,
			fp.resumeSha,
			fp.coverLetterSha,
		)
		.run();
	const stored = await getSubmitAuthorization(env, input.app.id, input.userId);
	if (!stored) throw new Error("The submission authorization was not stored");
	return { kind: stored.id === id ? "granted" : "existing", authorization: stored };
}

/**
 * Spend the authorization on one run. Returns the consumed authorization, or null when it was
 * already spent — the signal a caller must treat as "someone else holds this submission".
 */
export async function consumeSubmitAuthorization(env: DB, authorizationId: string, userId: string, runId: string, now: number): Promise<SubmitAuthorization | null> {
	const res = await env.DB.prepare(
		"UPDATE job_application_submit_authorizations SET consumed_at = ?1, consumed_run_id = ?2 WHERE id = ?3 AND user_id = ?4 AND consumed_at IS NULL",
	)
		.bind(now, runId, authorizationId, userId)
		.run();
	if ((res.meta?.changes ?? 0) === 0) return null;
	const row = await env.DB.prepare("SELECT * FROM job_application_submit_authorizations WHERE id = ?1 AND user_id = ?2").bind(authorizationId, userId).first<Row>();
	return row ? view(row) : null;
}

/** Withdraw an unspent authorization (the owner changed their mind). */
export async function revokeSubmitAuthorization(env: DB, applicationId: string, userId: string, reason: string, now: number): Promise<boolean> {
	const res = await env.DB.prepare(
		"UPDATE job_application_submit_authorizations SET revoked_at = ?1, revoked_reason = ?2 WHERE application_id = ?3 AND user_id = ?4 AND consumed_at IS NULL AND revoked_at IS NULL",
	)
		.bind(now, reason.slice(0, 300), applicationId, userId)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}
