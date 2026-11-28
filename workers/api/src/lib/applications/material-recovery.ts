/**
 * #1468, #1553: regenerate missing materials only when the current fill stopped before its engine ran — and never on a guess.
 *
 * Two kinds of evidence, in order of strength:
 *
 *   · THE RECEIPT. A runner at CLI 0.4.225+ answers a document-only failure with a versioned `preflightFailure` receipt
 *     (`trustedDocumentPreflightFailure`). It is positive proof the run never reached a browser or a model, and it tolerates the
 *     one platform event an APPROVED run always carries (the toolless submit `policy.decision` the cloud writes at dispatch). So a
 *     run that was approved and then stopped at document preflight is recoverable — which the older allowlist below could not say.
 *   · THE ABSENCE OF ACTIVITY (legacy). A run with no receipt is recoverable only by an exact trace allowlist, and only while the
 *     application holds no approval at all (or a withdrawn one). Absence is weaker than a receipt, so it gets less.
 *
 * With a receipt, an approval does not block regeneration — but a SPENT or CLAIMED one does: a spent approval means a run may have
 * used it, and a claim means a one-click recovery is in flight. Neither is evidence that nothing was sent.
 */
import type { Env } from "../../types.js";
import type { JobApplication } from "../local-artifact/store.js";
import { getSubmitAuthorization } from "../local-apply/approval-store.js";
import { parseLocalApplyResult } from "../local-apply/contract.js";
import { trustedDocumentPreflightFailure } from "../local-apply/preflight-failure.js";
import { type ApplyRun, getApplyRun } from "../local-apply/store.js";

const PREFLIGHT_EVENTS = new Set(["run.requested", "policy.submit_gate", "runner.dispatched", "source.read", "run.ended"]);

/**
 * What the guard needs to know about an application's approval. The stored authorization and the queue card's view of it both
 * satisfy this: the view has no `revokedAt`, so a card never treats an approval as withdrawn — which is exactly how the legacy path
 * behaved there before (any approval row hid the action).
 */
export interface RecoveryApproval {
	consumedAt: unknown;
	recoveryId?: string | null;
	recoveryPending?: boolean;
	revokedAt?: unknown;
}

const present = (v: unknown): boolean => v !== null && v !== undefined;
const spentOrClaimed = (a: RecoveryApproval): boolean => present(a.consumedAt) || !!a.recoveryId || !!a.recoveryPending;

type RecoveryApp = Pick<JobApplication, "id" | "status" | "fillRunId" | "submitAttemptedAt" | "blockReason">;

export function canRegenerateMissingMaterials(app: RecoveryApp, run: ApplyRun | null, approval: RecoveryApproval | null = null): boolean {
	if (app.status !== "blocked" || app.submitAttemptedAt || !run || run.id !== app.fillRunId || run.applicationId !== app.id || run.status !== "blocked" || !run.endedAt) return false;
	if (!["artifact_changed", "source_unavailable"].includes(app.blockReason ?? "")) return false;
	if (hasDocumentReceiptFor(app, run)) return !approval || !spentOrClaimed(approval);
	// No receipt: the weaker, activity-absence evidence, and only with no live approval in the way.
	if (approval && !present(approval.revokedAt)) return false;
	const result = run.result as Record<string, unknown> | null;
	return !!result && result.runId === run.id && result.outcome === "blocked" && result.blockReason === app.blockReason && result.engineAuth === "unknown"
		&& result.filled === 0 && Array.isArray(result.uploaded) && result.uploaded.length === 0 && result.submitAttempted === false && !result.submitted
		&& Array.isArray(run.trace) && run.trace.every((event) => PREFLIGHT_EVENTS.has(event.type));
}

/** The run carries the positive document-preflight receipt, for THIS application's block reason. */
function hasDocumentReceiptFor(app: RecoveryApp, run: ApplyRun): boolean {
	if (!trustedDocumentPreflightFailure(run)) return false;
	const parsed = parseLocalApplyResult(run.result);
	return !("error" in parsed) && parsed.result.blockReason === app.blockReason && parsed.result.preflightFailure?.reason === app.blockReason;
}

/** Recheck the owned terminal record at the write boundary; absent or conflicting evidence refuses. */
export async function canRecoverMissingMaterials(env: Pick<Env, "DB">, uid: string, app: JobApplication): Promise<boolean> {
	if (!app.fillRunId) return false;
	const row = await env.DB.prepare("SELECT instance_id FROM local_apply_runs WHERE id = ?1 AND application_id = ?2 AND user_id = ?3").bind(app.fillRunId, app.id, uid).first<{ instance_id: string }>();
	if (!row) return false;
	const run = await getApplyRun(env, row.instance_id, uid, app.fillRunId);
	const approval = await getSubmitAuthorization(env, app.id, uid);
	return canRegenerateMissingMaterials(app, run, approval);
}
