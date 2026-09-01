import { engineInvocationMode, type EngineInvocationMode } from "@proagentstore/sdk/ui";

const STRUCTURED_DETAIL = "Structured: the agent's messages and token use are parsed from CLI events.";
const RAW_DETAIL = "Raw: unprocessed stdout, spend not visible, each turn starts cold.";

export type { EngineInvocationMode };

export interface EngineInvocationNote {
	mode: EngineInvocationMode;
	label: "structured" | "raw";
	detail: string;
}

export interface EngineInvocationReport {
	resolved: EngineInvocationMode | null;
	expected: EngineInvocationMode;
	warning: string | null;
}

export interface EngineInvocationBadge {
	label: string;
	detail: string;
	tone: "warn" | "neutral";
}

export function engineInvocationNote(command: string): EngineInvocationNote | null {
	const mode = engineInvocationMode(command);
	if (!mode) return null;
	return {
		mode,
		label: mode,
		detail: mode === "structured" ? STRUCTURED_DETAIL : RAW_DETAIL,
	};
}

export function engineInvocationBadge(report: EngineInvocationReport | null | undefined): EngineInvocationBadge | null {
	if (!report) return null;
	const mode = report.resolved ?? report.expected;
	const source = report.resolved ? "Runner reports" : "Expected on a current runner";
	return {
		label: `${mode === "structured" ? "Structured" : "Raw"} invocation`,
		detail: `${source}: ${mode}. ${mode === "structured" ? STRUCTURED_DETAIL : RAW_DETAIL}`,
		tone: report.warning ? "warn" : "neutral",
	};
}
