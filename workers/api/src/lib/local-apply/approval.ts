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
	/** Ordinary pre-/post-fill approval, or the narrowly verified #1011 recovery. */
	kind: "standard" | "verified_one_click";
	approvedRunnerInstanceId: string | null;
	approvedFillRunId: string | null;
	approvedJobIdentity: string | null;
	/** Set before retrying a verified one-click refusal; it is the durable recovery claim. */
	recoveryId: string | null;
	recoveryRunnerInstanceId: string | null;
}

/** The application fields an authorization is measured against. */
export interface ApprovableApplication {
	id: string;
	sourceInstanceId: string;
	leadId: string;
	workKey: string | null;
	status: string;
	/** The fill run bound to this application, when one has ever run — see {@link approvalStageOf}. */
	fillRunId: string | null;
	stateVersion: number;
	lifecycleVersion: number;
	profileVersion: string | null;
	resumeArtifact: { sha256?: string } | null;
	coverLetterArtifact: { sha256?: string } | null;
	blockReason: string | null;
	submitAttemptedAt: number | null;
}

/**
 * The posting facts a one-click recovery is about. Application id already scopes the row, but a
 * durable posting identity makes a changed/re-pointed lead fail closed at the consumer too.
 */
export function jobIdentityOf(app: Pick<ApprovableApplication, "sourceInstanceId" | "leadId" | "workKey" | "lifecycleVersion">): string {
	return JSON.stringify({ sourceInstanceId: app.sourceInstanceId, leadId: app.leadId, workKey: app.workKey, lifecycleVersion: app.lifecycleVersion });
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
	if (auth.kind === "verified_one_click" && auth.approvedJobIdentity !== jobIdentityOf(app)) return unusable("materials_changed");
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

export interface ApprovalRunContext {
	status: string;
	/** `supervisor_checkpoint` | `missing_answer` | … — a paused run's reason, when it is paused. */
	pauseReason: string | null;
}

/** Minimal durable runner record needed to prove the exceptional one-click refusal. */
export interface OneClickRefusalRun {
	id: string;
	instanceId: string;
	status: string;
	pauseReason?: string | null;
	policy: { mode: string };
	result: unknown;
	trace: Array<{ type: string; detail?: unknown }>;
}

export interface VerifiedOneClickRefusal {
	runnerInstanceId: string;
	fillRunId: string;
	stateVersion: number;
	jobIdentity: string;
}

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * The only terminal blocked state that represents an owner submission decision (#1011).
 *
 * `blocked/incomplete` is deliberately insufficient: the Runner must have durably recorded that
 * it classified the exact browser click as `one_click_apply`, refused it solely because this was
 * `fill_and_review`, and never attempted submit. Missing, malformed or conflicting evidence is
 * unknown and therefore false here — CAPTCHA/login/terms/questions and generic failures cannot
 * become an approval path by sharing a status word.
 */
export function verifiedOneClickRefusal(app: ApprovableApplication, run: OneClickRefusalRun | null): VerifiedOneClickRefusal | null {
	if (!run || app.status !== "blocked" || app.blockReason !== "incomplete" || !app.fillRunId || app.fillRunId !== run.id) return null;
	if (run.status !== "blocked" || run.policy.mode !== "fill_and_review" || app.submitAttemptedAt !== null) return null;
	const result = record(run.result);
	if (result?.outcome !== "blocked" || result.blockReason !== "incomplete" || result.submitAttempted !== false) return null;
	if (run.trace.some((event) => event.type === "submit.attempted")) return null;
	const refused = run.trace.some((event) => {
		const detail = record(event.detail);
		return event.type === "policy.decision" && detail?.tool === "browser_click" && detail.class === "submit" && detail.decision === "refused" && detail.reason === "fill_and_review" && detail.rule === "one_click_apply";
	});
	if (!refused) return null;
	return { runnerInstanceId: run.instanceId, fillRunId: run.id, stateVersion: app.stateVersion, jobIdentity: jobIdentityOf(app) };
}

/**
 * Which stage this application is at, or null when an approval is not a meaningful decision here.
 *
 * ── Why this one `blocked` outcome is a submission decision (#1011)
 *
 * A blocked application is normally stopped for some other reason (a missing answer, CAPTCHA,
 * login, terms or an unusable checkout), and approving a submission is not the answer to any of
 * those. The verified one-click refusal is the deliberately narrow exception.
 *
 * Application `435d31c8…` / run `c27d1178…`: a real SEEK listing whose final control is a genuine
 * `one_click_apply`. Everything safe worked — the supervisor continued the initial checkpoint, the
 * runner refused that control under `fill_and_review`, no field was fabricated and no submit was
 * attempted — and the run ENDED, closing the application `blocked / incomplete`. The record then
 * told the owner "Approve this application to let it be sent, or apply on the site yourself", while
 * the only reachable actions were `retry_fill`, `defer`, `archive` and `mark_not_interested`. The
 * safe state had no supported path to the authorized application.
 *
 * It is the same decision as `awaiting_review`: the form is reviewed, nothing was sent, and the
 * owner is the only actor allowed to permit the single submit. Its continuation is a fresh run,
 * but it must use the same canonical application and the persisted recovery binding.
 *
 * The application, run, policy decision, result and trace are all part of the proof. A generic
 * `blocked/incomplete` record—even one with a fill run—still answers null.
 */
export function approvalStageOf(app: ApprovableApplication, run: OneClickRefusalRun | null): ApprovalStage | null {
	if (app.status === "materials_ready") return "pre_fill";
	if (app.status === "awaiting_review") return "post_fill";
	if (app.status === "blocked" && run?.status === "paused" && run.pauseReason === "supervisor_checkpoint") return "post_fill";
	// The proof is load-bearing: a run paused on a question, CAPTCHA or sign-in needs its own
	// resolution; a generic ended run may be retried but is never submission-approvable.
	if (verifiedOneClickRefusal(app, run)) return "post_fill";
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
