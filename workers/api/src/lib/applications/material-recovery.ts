/** #1468: regenerate missing materials only when the current fill stopped before its engine ran. */
import type { Env } from "../../types.js";
import type { JobApplication } from "../local-artifact/store.js";
import { getSubmitAuthorization } from "../local-apply/approval-store.js";
import { type ApplyRun, getApplyRun } from "../local-apply/store.js";

const PREFLIGHT_EVENTS = new Set(["run.requested", "policy.submit_gate", "runner.dispatched", "source.read", "run.ended"]);

export function canRegenerateMissingMaterials(app: Pick<JobApplication, "id" | "status" | "fillRunId" | "submitAttemptedAt" | "blockReason">, run: ApplyRun | null): boolean {
	if (app.status !== "blocked" || app.submitAttemptedAt || !run || run.id !== app.fillRunId || run.applicationId !== app.id || run.status !== "blocked" || !run.endedAt) return false;
	if (!["artifact_changed", "source_unavailable"].includes(app.blockReason ?? "")) return false;
	const result = run.result as Record<string, unknown> | null;
	return !!result && result.runId === run.id && result.outcome === "blocked" && result.blockReason === app.blockReason && result.engineAuth === "unknown"
		&& result.filled === 0 && Array.isArray(result.uploaded) && result.uploaded.length === 0 && result.submitAttempted === false && !result.submitted
		&& Array.isArray(run.trace) && run.trace.every((event) => PREFLIGHT_EVENTS.has(event.type));
}

/** Recheck the owned terminal record at the write boundary; absent or conflicting evidence refuses. */
export async function canRecoverMissingMaterials(env: Pick<Env, "DB">, uid: string, app: JobApplication): Promise<boolean> {
	if (!app.fillRunId) return false;
	const row = await env.DB.prepare("SELECT instance_id FROM local_apply_runs WHERE id = ?1 AND application_id = ?2 AND user_id = ?3").bind(app.fillRunId, app.id, uid).first<{ instance_id: string }>();
	if (!row) return false;
	const run = await getApplyRun(env, row.instance_id, uid, app.fillRunId);
	const approval = await getSubmitAuthorization(env, app.id, uid);
	return (!approval || !!approval.revokedAt) && canRegenerateMissingMaterials(app, run);
}
