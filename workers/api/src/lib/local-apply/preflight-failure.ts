import { compareCliVersions } from "../machine-identity.js";
import { parseLocalApplyResult } from "./contract.js";
import type { ApplyRun } from "./store.js";

export const PREFLIGHT_FAILURE_MIN_CLI = "0.4.225";

/** A positive receipt from the document-only path, not an inference from missing activity. */
export function trustedDocumentPreflightFailure(run: Pick<ApplyRun, "id" | "runnerVersion" | "status" | "trace" | "result" | "engineAuth">, result: unknown = run.result): boolean {
	const version = compareCliVersions(run.runnerVersion ?? "", PREFLIGHT_FAILURE_MIN_CLI);
	if (version === null || version < 0 || run.status === "submitted" || run.engineAuth && run.engineAuth !== "unknown") return false;
	const parsed = parseLocalApplyResult(result);
	if ("error" in parsed || parsed.result.runId !== run.id || !parsed.result.preflightFailure) return false;
	// Contradictory retained activity invalidates the receipt. Missing activity alone grants nothing.
	return run.trace.every((event) => {
		if (event.type === "policy.decision") return !event.detail?.tool && event.detail?.class === "submit" && (event.detail.basis === "application_approval" || event.detail.reason === "approval_already_spent");
		return ["run.requested", "source.read", "artifact.staged", "policy.submit_gate", "runner.dispatched", "run.ended"].includes(event.type);
	});
}
