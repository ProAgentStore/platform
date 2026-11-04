import { cliAtLeast } from "../runner-upgrade.js";

/** First CLI carrying explicit application-engine model/effort args (#1511). */
export const LOCAL_APPLY_MODEL_MIN_CLI = "0.4.215";

export function browserModelRunnerProblem(config: { model?: string | null; reasoningEffort?: string | null }, version: string | null | undefined): string | null {
	if (!config.model && !config.reasoningEffort) return null;
	if (version && cliAtLeast(version, LOCAL_APPLY_MODEL_MIN_CLI)) return null;
	return `The requested browser model/reasoning configuration requires CLI ${LOCAL_APPLY_MODEL_MIN_CLI} or newer; this runner reports ${version || "unknown"}. Update and restart the runner before retrying. Older runners would silently ignore this configuration.`;
}
