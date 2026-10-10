/**
 * Durable consumer validation for #1011's exceptional recovery.  A card-level affordance is not
 * authority: the dispatcher re-reads the original terminal run and current canonical material
 * facts immediately before it creates the auto-submit envelope.
 */
import type { Env } from "../../types.js";
import type { JobApplication } from "../local-artifact/store.js";
import { approvalState, verifiedOneClickRefusal, type SubmitAuthorization } from "./approval.js";
import { getSubmitAuthorization } from "./approval-store.js";
import { getApplyRun } from "./store.js";

export async function usableSubmitAuthorization(
	env: Env,
	uid: string,
	runnerInstanceId: string,
	app: JobApplication,
	recoveryId?: string,
): Promise<SubmitAuthorization | null> {
	const auth = await getSubmitAuthorization(env, app.id, uid).catch(() => null);
	if (!auth || !approvalState(auth, app).usable) return null;
	if (auth.kind === "standard") return auth;
	if (!recoveryId || auth.recoveryId !== recoveryId || auth.recoveryRunnerInstanceId !== runnerInstanceId || auth.approvedRunnerInstanceId !== runnerInstanceId || !auth.approvedFillRunId || auth.approvedStateVersion < 0) return null;
	const run = await getApplyRun(env, runnerInstanceId, uid, auth.approvedFillRunId).catch(() => null);
	// The current application is legitimately `materials_ready`/`filling` after retry. Reconstruct
	// only the source-state fields from the immutable approval record, while checking every mutable
	// job/material/attempt fact from the canonical application now.
	const source = { ...app, status: "blocked" as const, blockReason: "incomplete", stateVersion: auth.approvedStateVersion, fillRunId: auth.approvedFillRunId };
	const proof = verifiedOneClickRefusal(source, run);
	if (!proof || proof.runnerInstanceId !== auth.approvedRunnerInstanceId || proof.fillRunId !== auth.approvedFillRunId || proof.stateVersion !== auth.approvedStateVersion || proof.jobIdentity !== auth.approvedJobIdentity) return null;
	return auth;
}
