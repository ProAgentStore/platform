/** Provider-neutral identifiers; CLI adapters, never page-specific model choices (#1511). */
export interface BrowserModelConfig {
	engine: string;
	model?: string | null;
	reasoningEffort?: string | null;
}

export function modelConfigurationProblem(config: { engine: unknown; model?: unknown; reasoningEffort?: unknown }): string | null {
	if (config.model != null && (typeof config.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(config.model))) return "model must be a nonempty model identifier, or null";
	if (config.reasoningEffort != null && (typeof config.reasoningEffort !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(config.reasoningEffort))) return "reasoningEffort must be a nonempty effort token, or null";
	if (config.reasoningEffort && config.engine !== "codex") return "reasoningEffort is supported only by the codex browser engine";
	return null;
}

export function modelArguments(config: BrowserModelConfig): string[] {
	const problem = modelConfigurationProblem(config);
	if (problem) throw new Error(problem);
	return [...(config.model ? ["--model", config.model] : []), ...(config.reasoningEffort ? ["-c", `model_reasoning_effort=${JSON.stringify(config.reasoningEffort)}`] : [])];
}

/** Launch configuration is evidence of what we asked for, not what the provider served. */
export function requestedModelEvidence(config: BrowserModelConfig): Record<string, string> {
	return { requestedModel: config.model ?? "cli_default", requestedReasoningEffort: config.reasoningEffort ?? "cli_default", modelVerification: "unverified" };
}
