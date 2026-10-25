/** Provider transport catalogue, independent of which product role may use a model. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6" as const;
const ANTHROPIC_MODELS = [DEFAULT_ANTHROPIC_MODEL, "claude-haiku-5-5"] as const;
export type AnthropicModelId = (typeof ANTHROPIC_MODELS)[number];
export function anthropicModelProblem(model: unknown): string | null {
	return ANTHROPIC_MODELS.some((known) => known === model) ? null : "Unsupported Anthropic model id.";
}
