/**
 * The live-browser handoff surface of the local-apply contract — every way a PERSON reaches a page
 * on the owner's runner: a paused fill's handoff (#1013), the read-only reconciliation check, and the
 * post-run site sign-in (#1100). Split out of `contract.ts` at #1100, when the sign-in pushed that
 * file past its size pin: the application run itself (envelope, events, result, policy) is the other
 * half, and changes for different reasons.
 *
 * Vendored byte-identical in the Worker (`workers/api/src/lib/local-apply/`) and the runner
 * (`packages/browser-runner/src/local-apply/`), like `contract.ts`; `contract.test.ts` holds both
 * pairs equal. Its one import is a type from that sibling, which travels with it.
 */
import type { LocalApplyProfile } from "./contract.js";

/**
 * A short-lived, owner-authorized view of the *existing* browser page for one local-apply run.
 * The id is opaque and carries no browser/profile material.  It deliberately is not a task id:
 * local-apply runs are not generic runner tasks.
 */
export const LOCAL_APPLY_HANDOFF_PATH = "/local-apply/handoff";
export const LOCAL_APPLY_HANDOFF_STATUS_PATH = "/local-apply/handoff-status";
export const LOCAL_APPLY_HANDOFF_FRAME_PATH = "/local-apply/handoff/frame";
export const LOCAL_APPLY_HANDOFF_INPUT_PATH = "/local-apply/handoff/input";
export const LOCAL_APPLY_HANDOFF_RESUME_PATH = "/local-apply/handoff/resume";
export const LOCAL_APPLY_HANDOFF_END_PATH = "/local-apply/handoff/end";
/**
 * A separate, browser-only receipt/history check for an already-ended uncertain attempt.  This is
 * deliberately not an application run: it receives no engine, sources, artifacts or submit gate.
 */
export const LOCAL_APPLY_RECONCILIATION_RUN_PATH = "/local-apply/reconciliation/run";
export const LOCAL_APPLY_RECONCILIATION_STATUS_PATH = "/local-apply/reconciliation/status";
export const LOCAL_APPLY_RECONCILIATION_HANDOFF_PATH = "/local-apply/reconciliation/handoff";
export const LOCAL_APPLY_RECONCILIATION_HANDOFF_STATUS_PATH = "/local-apply/reconciliation/handoff-status";
export const LOCAL_APPLY_RECONCILIATION_HANDOFF_FRAME_PATH = "/local-apply/reconciliation/handoff/frame";
export const LOCAL_APPLY_RECONCILIATION_HANDOFF_INPUT_PATH = "/local-apply/reconciliation/handoff/input";
export const LOCAL_APPLY_RECONCILIATION_HANDOFF_RESUME_PATH = "/local-apply/reconciliation/handoff/resume";
export const LOCAL_APPLY_RECONCILIATION_HANDOFF_END_PATH = "/local-apply/reconciliation/handoff/end";
/**
 * A sign-in to the job's site in this machine's application browser profile, AFTER a fill ended
 * `blocked` on `login_required` (#1100). Not a run and not a run's handoff: there is no engine, no
 * source, no artifact and no submit gate — only the profile's page at the job's site, for the owner
 * to sign in, and the profile's sign-in ledger (#1094) to record that they did.
 */
export const LOCAL_APPLY_SIGN_IN_PATH = "/local-apply/sign-in";
export const LOCAL_APPLY_SIGN_IN_FRAME_PATH = "/local-apply/sign-in/frame";
export const LOCAL_APPLY_SIGN_IN_INPUT_PATH = "/local-apply/sign-in/input";
export const LOCAL_APPLY_SIGN_IN_END_PATH = "/local-apply/sign-in/end";

/** Reasons a scoped handoff is closed or cannot be created.  None implies a browser result. */
export type LocalApplyHandoffTerminalReason = "unavailable" | "profile_unavailable" | "profile_mismatch" | "page_lost" | "expired" | "run_ended" | "runner_restarted";
export const LOCAL_APPLY_HANDOFF_TERMINAL_REASONS: readonly LocalApplyHandoffTerminalReason[] = ["unavailable", "profile_unavailable", "profile_mismatch", "page_lost", "expired", "run_ended", "runner_restarted"];

/** Secret-free status for the one live page retained by an active local-apply run. */
export interface LocalApplyHandoffStatus {
	handoffId: string;
	runId: string;
	applicationId: string;
	browserProfile: LocalApplyProfile;
	state: "ready" | "closed";
	expiresAt: string;
	/** Present only when no page can still be controlled. It is never a submission result. */
	terminalReason?: LocalApplyHandoffTerminalReason;
}

/** Open (or read back) a post-run sign-in. The id is opaque; the URL is the job's own page. */
export interface LocalApplySignInRequest {
	signInId: string;
	browserProfile: LocalApplyProfile;
	url: string;
}

/** Secret-free status of a post-run sign-in: names a site, never a cookie, URL query or value. */
export interface LocalApplySignInStatus {
	signInId: string;
	browserProfile: LocalApplyProfile;
	/** The registrable domain being signed in to, e.g. `seek.com`. */
	site: string;
	state: "ready" | "closed";
	expiresAt: string;
	terminalReason?: LocalApplyHandoffTerminalReason;
	/** Present once the owner finished: how many session cookie NAMES the ledger now fingerprints. */
	signedIn?: { fingerprint: number; verifiable: boolean };
}

/** All four bindings are compared at the runner boundary before a live page is exposed. */
export interface LocalApplyHandoffRequest {
	handoffId: string;
	runId: string;
	applicationId: string;
	browserProfile: LocalApplyProfile;
}

/** An opaque, exact-attempt-bound read-only browser check.  No employer account is claimed. */
export interface LocalApplyReconciliationEnvelope {
	type: "local_browser.apply.reconciliation";
	reconciliationId: string;
	runId: string;
	instanceId: string;
	applicationId: string;
	browserProfile: LocalApplyProfile;
	applicationUrl: string;
	allowDomains: string[];
	jobIdentity: string;
	materialFingerprint: { leadVersion: number | null; profileVersion: string | null; resumeSha: string | null; coverLetterSha: string | null };
}

/** The runner never transports site text/URLs/cookies; it reports only this evidence category. */
export interface LocalApplyReconciliationStatus {
	reconciliationId: string;
	runId: string;
	applicationId: string;
	browserProfile: LocalApplyProfile;
	/** A fresh context is not continuity with a lost ended isolated profile. */
	context: "same_live_context" | "separate_read_only_context";
	state: "running" | "paused" | "ended";
	pauseReason?: "login_required" | "captcha";
	result?: { state: "no_submission_proven" | "submission_confirmed" | "ambiguous" | "unavailable"; proofKind: "authorized_site_history_no_submission" | "authorized_site_receipt_confirmed" | "ambiguous_site_history" | "authorized_profile_unavailable" };
}

/** Same opaque handoff bindings, with the reconciliation id preventing original-run substitution. */
export interface LocalApplyReconciliationHandoffRequest extends LocalApplyHandoffRequest {
	reconciliationId: string;
}
