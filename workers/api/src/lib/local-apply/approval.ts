/**
 * Per-application submission authorization (#973) — the owner's decision about ONE job.
 *
 * The submit gate (`policy.ts` `evaluateSubmitGate`) asks a standing-policy question: has the owner
 * enabled auto-submit, does the title match an approved role, is there daily-cap headroom. That is
 * the right question for jobs nobody has read. It is the wrong one once the owner has looked at a
 * specific application on the board and said "send this": they are not setting a policy, they are
 * making one decision, and it should not require them to enable a blanket one.
 *
 * So an authorization stands in for the checks that exist to INFER the owner's intent, and for
 * nothing else. The checks that exist to keep a run safe or correct — complete materials, an
 * allow-listed domain, no blocker, nothing else running — are untouched, because an approval is a
 * statement about wanting the job, not a claim that the application is in a fit state to send.
 * The runner's own bridge checks are downstream of all of this and are not affected either.
 *
 * Everything here is pure: the validity rule is the security boundary, so it is tested without a
 * database (`approval.test.ts`), and the store around it only persists what these functions decide.
 */

/** The gate checks an approval answers — the ones that infer "does the owner want this job sent". */
export const APPROVAL_SATISFIES = ["auto_submit_enabled", "daily_cap", "role_matches", "location_matches", "salary_matches", "not_excluded"] as const;
export type ApprovalSatisfiedCheck = (typeof APPROVAL_SATISFIES)[number];

/**
 * The material facts an approval is given FOR. A change to any of them means the owner approved
 * different work, so the authorization no longer applies.
 *
 * Deliberately not the application's `state_version`: that counter advances on the next legitimate
 * move (`materials_ready` → `filling`), so binding to it would make every authorization stale one
 * step after it was granted. The lead revision and the artifact digests are what actually change
 * when the work changes — re-tailoring writes new digests, which is exactly the case the issue
 * names ("cannot be replayed … after a material lead change").
 */
export interface ApprovalFingerprint {
	leadVersion: number | null;
	profileVersion: string | null;
	resumeSha: string | null;
	coverLetterSha: string | null;
}

export interface SubmitAuthorization {
	id: string;
	applicationId: string;
	instanceId: string;
	approvedBy: string;
	approvedAt: number;
	approvedStateVersion: number;
	approvedStatus: string;
	idempotencyKey: string;
	fingerprint: ApprovalFingerprint;
	consumedAt: number | null;
	consumedRunId: string | null;
	revokedAt: number | null;
	revokedReason: string | null;
}

/** The application fields an authorization is measured against. */
export interface ApprovableApplication {
	id: string;
	status: string;
	stateVersion: number;
	lifecycleVersion: number;
	profileVersion: string | null;
	resumeArtifact: { sha256?: string } | null;
	coverLetterArtifact: { sha256?: string } | null;
	submitAttemptedAt: number | null;
}

export function fingerprintOf(app: ApprovableApplication): ApprovalFingerprint {
	return {
		leadVersion: typeof app.lifecycleVersion === "number" ? app.lifecycleVersion : null,
		profileVersion: app.profileVersion ?? null,
		resumeSha: app.resumeArtifact?.sha256 ?? null,
		coverLetterSha: app.coverLetterArtifact?.sha256 ?? null,
	};
}

export function sameFingerprint(a: ApprovalFingerprint, b: ApprovalFingerprint): boolean {
	return a.leadVersion === b.leadVersion && a.profileVersion === b.profileVersion && a.resumeSha === b.resumeSha && a.coverLetterSha === b.coverLetterSha;
}

/** Why an authorization cannot be used — in the owner's words, because the board shows them. */
export type ApprovalUnusableReason = "consumed" | "revoked" | "materials_changed" | "submit_attempted";

export interface ApprovalState {
	/** The gate may rely on it. */
	usable: boolean;
	reason: ApprovalUnusableReason | null;
	/** What the owner sees on the card: approved · spent · revoked · stale · superseded by an attempt. */
	label: string;
}

const LABELS: Record<ApprovalUnusableReason, string> = {
	consumed: "Approved and already sent to a run — single-use, so a retry needs a new approval.",
	revoked: "The approval was withdrawn.",
	materials_changed: "The materials changed after this approval, so it no longer applies — approve again to send the new version.",
	submit_attempted: "A submit was already attempted for this application.",
};

/**
 * Is this authorization usable for the application as it stands now?
 *
 * Order matters and is the order a reader needs: a spent authorization is reported as spent even if
 * the materials also changed, because "it already went" is the fact that explains what happened.
 */
export function approvalState(auth: SubmitAuthorization | null, app: ApprovableApplication): ApprovalState {
	if (!auth) return { usable: false, reason: null, label: "Not approved for submission." };
	const unusable = (reason: ApprovalUnusableReason): ApprovalState => ({ usable: false, reason, label: LABELS[reason] });
	if (auth.consumedAt !== null) return unusable("consumed");
	if (auth.revokedAt !== null) return unusable("revoked");
	// An attempt that happened outside this authorization (a retry, an earlier run) ends it too: the
	// gate's own `no_blocker` check refuses a second attempt, and an approval must not look live
	// while the thing it authorizes can no longer happen.
	if (app.submitAttemptedAt !== null) return unusable("submit_attempted");
	if (!sameFingerprint(auth.fingerprint, fingerprintOf(app))) return unusable("materials_changed");
	return { usable: true, reason: null, label: "Approved to submit — one application, by the owner." };
}

/**
 * May the owner approve this application now? Separate from {@link approvalState}, which judges an
 * authorization that exists: this judges whether granting one is meaningful.
 *
 * `materials_ready` only. Earlier there is nothing to send; later a run already holds the decision,
 * and an approval granted mid-fill would be a second authority over a run already in flight.
 */
export function approvalEligibility(app: ApprovableApplication, auth: SubmitAuthorization | null): { eligible: boolean; why?: string } {
	if (app.status !== "materials_ready") return { eligible: false, why: `an application in ${app.status} is not waiting for a submission decision` };
	if (app.submitAttemptedAt !== null) return { eligible: false, why: "a submit was already attempted for this application" };
	const state = approvalState(auth, app);
	// A live approval is not re-granted; the caller gets the one that exists (idempotency), which is
	// decided in the store. A SPENT one blocks a new grant: the run that consumed it is the record of
	// what the owner authorized, and re-approving the same application would hide a second send.
	if (auth && state.usable) return { eligible: false, why: "this application is already approved to submit" };
	if (auth?.consumedAt) return { eligible: false, why: "this application's approval was already used by a run" };
	return { eligible: true };
}
