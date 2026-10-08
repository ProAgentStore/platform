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
	/** The fill run bound to this application, when one has ever run — see {@link approvalStageOf}. */
	fillRunId: string | null;
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
 * WHEN the owner is giving the decision — the two moments at which it means something (#981).
 *
 * `pre_fill`   `materials_ready`: nothing has been filled yet, so the approval dispatches the fill
 *              that spends it. This is #973's original and only stage.
 * `post_fill`  the form is filled and nothing was sent: the run stopped `awaiting_review`, or it is
 *              parked at a supervisor checkpoint. The owner has now SEEN the populated form, which
 *              is the strongest moment there is to decide — and it was the one moment with no way
 *              to decide at all (#981): the queue offered defer, archive and not-interested, so an
 *              owner who asked for a review-mode fill could never then say "send this one".
 *
 * Mid-fill (`filling`) is deliberately absent: an approval granted while the engine is working
 * would be a second authority over a run already in flight, and the run's own recorded policy is
 * what the runner is executing.
 */
export const APPROVAL_STAGES = ["pre_fill", "post_fill"] as const;
export type ApprovalStage = (typeof APPROVAL_STAGES)[number];

/** The run facts the stage depends on. Null when the application has no open run. */
/**
 * Statuses a fill run is passing THROUGH rather than resting at.
 *
 * Spelled out here rather than imported from the apply store: this module is the pure approval
 * rule and the store imports it, so the dependency would close a cycle. `store.ts`'s
 * `isTerminalApplyRun` is the same statement from the other side, and `approval.test.ts` pins them
 * to the same answer.
 */
const LIVE_RUN_STATUSES: readonly string[] = ["queued", "running", "paused"];
const isLiveRunContext = (run: ApprovalRunContext | null): boolean => !!run && LIVE_RUN_STATUSES.includes(run.status);

export interface ApprovalRunContext {
	status: string;
	/** `supervisor_checkpoint` | `missing_answer` | … — a paused run's reason, when it is paused. */
	pauseReason: string | null;
}

/**
 * Which stage this application is at, or null when an approval is not a meaningful decision here.
 *
 * ── Why `blocked` after a fill is a submission decision (#991)
 *
 * This counted `blocked` ONLY while a run was parked at a supervisor checkpoint, on the reasoning
 * that a `blocked` application is "stopped for some other reason (a missing answer, a captcha, an
 * unusable checkout), and approving a submission is not the answer to any of those". The live
 * one-click case is the counter-example that reasoning missed.
 *
 * Application `435d31c8…` / run `c27d1178…`: a real SEEK listing whose final control is a genuine
 * `one_click_apply`. Everything safe worked — the supervisor continued the initial checkpoint, the
 * runner refused that control under `fill_and_review`, no field was fabricated and no submit was
 * attempted — and the run ENDED, closing the application `blocked / incomplete`. The record then
 * told the owner "Approve this application to let it be sent, or apply on the site yourself", while
 * the only reachable actions were `retry_fill`, `defer`, `archive` and `mark_not_interested`. The
 * safe state had no supported path to the authorized application.
 *
 * It IS the same situation as `awaiting_review`, and #981's comment there says so in its own words:
 * the run stopped, nothing was sent, and the owner who must decide could not act. The run having
 * ended rather than paused changes only HOW the decision is carried out — `approveAndContinue`
 * already answers `run_ended` with "your approval is recorded and held; `retry_fill` starts a fresh
 * run that spends it and may submit once".
 *
 * `fillRunId` is what keeps this honest: a `blocked` application that never filled is stopped at
 * TAILORING, where there is no form, no final control and nothing a submission decision could mean.
 * That one still answers null, which is the old reasoning kept exactly where it was right.
 */
export function approvalStageOf(app: Pick<ApprovableApplication, "status" | "fillRunId">, run: ApprovalRunContext | null): ApprovalStage | null {
	if (app.status === "materials_ready") return "pre_fill";
	if (app.status === "awaiting_review") return "post_fill";
	if (app.status === "blocked" && run?.status === "paused" && run.pauseReason === "supervisor_checkpoint") return "post_fill";
	// The fill ran and ENDED without sending anything (#991) — the one-click refusal, a run that
	// reached the final control, a `bridge_unused` stop. The decision is the owner's; the run that
	// carries it is a fresh one.
	//
	// "Ended" is load-bearing. A run still PAUSED on a question (`missing_answer`), a captcha or a
	// sign-in is live, and its own blocker is the thing to resolve — `resume` answers it. Offering
	// an approval there would pre-authorise sending a form whose required question is still
	// unanswered, which is the opposite of what the owner is being asked. Only the checkpoint pause
	// above is a submission decision, because that is the one where the form is complete and waiting.
	if (app.status === "blocked" && app.fillRunId && !isLiveRunContext(run)) return "post_fill";
	return null;
}

/**
 * May the owner approve this application now? Separate from {@link approvalState}, which judges an
 * authorization that exists: this judges whether granting one is meaningful.
 *
 * The stage is taken rather than re-derived, because only the caller can see the run (#981). Absent,
 * it falls back to what the status alone can say — which is every pre-#981 call site, unchanged.
 */
export function approvalEligibility(app: ApprovableApplication, auth: SubmitAuthorization | null, stage: ApprovalStage | null = approvalStageOf(app, null)): { eligible: boolean; why?: string } {
	if (!stage) return { eligible: false, why: `an application in ${app.status} is not waiting for a submission decision` };
	if (app.submitAttemptedAt !== null) return { eligible: false, why: "a submit was already attempted for this application" };
	const state = approvalState(auth, app);
	// A live approval is not re-granted; the caller gets the one that exists (idempotency), which is
	// decided in the store. A SPENT one blocks a new grant: the run that consumed it is the record of
	// what the owner authorized, and re-approving the same application would hide a second send.
	if (auth && state.usable) return { eligible: false, why: "this application is already approved to submit" };
	if (auth?.consumedAt) return { eligible: false, why: "this application's approval was already used by a run" };
	return { eligible: true };
}
