import { cliAtLeast } from "../runner-upgrade.js";
import type { LocalApplyEscalationLevel, LocalApplyDecisionAssessment } from "./contract.js";

/** First CLI enforcing model-assessed decision thresholds and source-backed interpretation. */
export const LOCAL_APPLY_ESCALATION_MIN_CLI = "0.4.220";

export function escalationRunnerProblem(config: { escalationLevel?: LocalApplyEscalationLevel }, version: string | null | undefined): string | null {
	if (!config.escalationLevel || config.escalationLevel === "conservative") return null;
	if (version && cliAtLeast(version, LOCAL_APPLY_ESCALATION_MIN_CLI)) return null;
	return `The requested application escalation level requires CLI ${LOCAL_APPLY_ESCALATION_MIN_CLI} or newer; this runner reports ${version || "unknown"}. Update and restart the runner before retrying. Older runners would silently ignore this configuration.`;
}

/** Validate the model's declared decision, never infer risk from its prose or page content. */
export function parseDecisionAssessment(value: unknown): LocalApplyDecisionAssessment | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const d = value as Record<string, unknown>;
	if ((d.risk !== "minor" && d.risk !== "major") || typeof d.reason !== "string" || !d.reason.trim() || d.reason.length > 1000) return null;
	return { risk: d.risk, reason: d.reason.trim() };
}
