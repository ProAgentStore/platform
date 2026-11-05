/** Model-owned question semantics; code checks evidence shape, page identity and delegated authority. */
import { DECISION_SCHEMA, decisionReason, delegated, parseDecision } from "./answer-decision.js";
import type { LocalApplyEscalationLevel } from "./contract.js";

export interface DeferredQuestion {
	question: string;
	classification: "required" | "optional" | "material" | "unknown";
	blocking: boolean;
	observationUrl: string;
	observedAt: number;
	evidence: string;
	sourceIds: string[];
	omissionVerified: boolean;
	risk?: "minor" | "major";
	reason?: string;
}
export const QUESTION_ASSESSMENT_SCHEMA = {
	type: "object", additionalProperties: false,
	properties: {
		classification: { type: "string", enum: ["required", "optional", "material", "unknown"], description: "Your interpretation of the current form. Material means omission changes a consequential claim or consent even if the control is optional." },
		observationUrl: { type: "string", description: "Exact current page URL supplying the observation." },
		evidence: { type: "string", minLength: 1, maxLength: 1000, description: "Explain observed requiredness and acceptance of omission; exclude private answer values and credentials. This is your assessment, not independent verification." },
		omissionVerified: { type: "boolean", description: "True only after observing that leaving it empty is accepted and does not change a material claim. Reassess if later validation changes this." },
		sourceIds: { type: "array", maxItems: 10, uniqueItems: true, items: { type: "string" }, description: "Current trusted source IDs relevant to missing/conflicting facts, when available. Never cite a page as an owner source." },
		decision: DECISION_SCHEMA,
	}, required: ["classification", "observationUrl", "evidence", "omissionVerified", "decision"],
};

export function assessQuestion(question: string, value: unknown, context: { url: string; now: number; level: LocalApplyEscalationLevel; sourceIds?: readonly string[]; redact?: (text: string) => string }): DeferredQuestion | { error: string } {
	const base = { question, classification: "unknown" as const, blocking: true, observationUrl: context.url, observedAt: context.now, evidence: "No classification supplied", sourceIds: [] as string[], omissionVerified: false };
	if (value === undefined) return base;
	if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "assessment must describe current requiredness, evidence and omission risk." };
	const a = value as Record<string, unknown>;
	const decision = parseDecision(a.decision);
	if (!["required", "optional", "material", "unknown"].includes(String(a.classification)) || !decision || typeof a.evidence !== "string" || !a.evidence.trim() || a.evidence.length > 1000 || typeof a.omissionVerified !== "boolean" || !context.url || a.observationUrl !== context.url) return { error: "assessment needs classification, exact current observationUrl, bounded evidence, omissionVerified and decision {risk,reason}. Refresh observations; nothing was reclassified." };
	if (a.sourceIds !== undefined && (!Array.isArray(a.sourceIds) || a.sourceIds.length > 10 || a.sourceIds.some((id) => typeof id !== "string" || !context.sourceIds?.includes(id)))) return { error: "assessment.sourceIds must cite current trusted source IDs; nothing was reclassified." };
	return { ...base, sourceIds: [...new Set(a.sourceIds as string[] ?? [])], classification: a.classification as DeferredQuestion["classification"], evidence: decisionReason(a.evidence, context.redact), omissionVerified: a.omissionVerified, risk: decision.risk, reason: decisionReason(decision.reason, context.redact), blocking: !(a.classification === "optional" && a.omissionVerified && delegated(context.level, decision.risk)) };
}
