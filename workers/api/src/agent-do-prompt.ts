import type { AgentState, Guardrails } from "./agent-types.js";

export const DEFAULT_MODEL = "@cf/meta/llama-3.2-3b-instruct";

export const DEPRECATED_MODELS = new Set([
	"@cf/meta/llama-3.1-8b-instruct",
	"@cf/meta/llama-3.1-70b-instruct",
	"@cf/mistral/mistral-7b-instruct-v0.2",
	"@cf/qwen/qwen1.5-14b-chat-awq",
]);

/** A tool-capable Cloudflare Workers-AI model — the target when auto-upgrading off a
 *  non-tool-capable model so tools aren't silently dropped (#100). Same model the
 *  agent-builder scaffolder already uses. */
export const TOOL_CAPABLE_CF_DEFAULT = "@cf/meta/llama-4-scout-17b-16e-instruct";

/** Models that support structured function calling (tool_calls in response). */
export const TOOL_CAPABLE_MODELS = new Set([
	"@cf/meta/llama-3.3-70b-instruct-fp8-fast",
	"@cf/meta/llama-4-scout-17b-16e-instruct",
	"@cf/mistralai/mistral-small-3.1-24b-instruct",
	"@cf/qwen/qwen2.5-coder-32b-instruct",
	// Anthropic BYOK models
	"claude-sonnet-4-6",
	"claude-opus-4-6",
	"claude-haiku-4-5",
	"claude-sonnet-4-5-20250514",
]);

/**
 * Resolve the model to actually run a chat turn with. A non-tool-capable model silently
 * drops ALL tools (memory, collections, fetch_url, …) — the footgun where a structured-data
 * agent created on the default 3B model couldn't query its own collection (#100). When the
 * agent has tools available but its model can't call them, upgrade to a tool-capable CF model
 * for the turn instead of running tool-less. Pure + deterministic (state is not mutated).
 */
export function resolveModelForTools(model: string, hasTools: boolean): { model: string; upgraded: boolean } {
	if (hasTools && !TOOL_CAPABLE_MODELS.has(model)) {
		return { model: TOOL_CAPABLE_CF_DEFAULT, upgraded: true };
	}
	return { model, upgraded: false };
}

export function defaultGuardrails(input?: Partial<Guardrails>): Guardrails {
	return {
		topicRestrictions: input?.topicRestrictions || "",
		blockedTerms: input?.blockedTerms || [],
		responseStyle: input?.responseStyle || "",
		maxResponseLength: input?.maxResponseLength || 0,
		requireCitations: input?.requireCitations || false,
	};
}

export function ensureStateDefaults(state: AgentState): AgentState {
	if (!state.model || DEPRECATED_MODELS.has(state.model)) {
		state.model = DEFAULT_MODEL;
	}
	if (!state.guardrails) {
		state.guardrails = defaultGuardrails();
		state.welcomeMessage = state.welcomeMessage || "";
		state.isPublished = state.isPublished || false;
	}
	if (state.status === "thinking" || state.status === "error") {
		state.status = "idle";
	}
	return state;
}

export function buildSystemPrompt(
	name: string,
	personality?: string,
	goal?: string,
	guardrails?: Guardrails,
): string {
	let prompt = `You are ${name}, a server-powered AI agent on ProAgentStore.`;
	if (personality) prompt += `\n\nPersonality: ${personality}`;
	if (goal) prompt += `\n\nGoal: ${goal}`;

	if (guardrails) {
		if (guardrails.topicRestrictions) {
			prompt += `\n\nTopic restrictions: ${guardrails.topicRestrictions}. If the user asks about anything outside this scope, politely decline and redirect to your area of expertise.`;
		}
		if (guardrails.blockedTerms.length > 0) {
			prompt += `\n\nNever use these words or phrases: ${guardrails.blockedTerms.join(", ")}`;
		}
		if (guardrails.responseStyle) {
			prompt += `\n\nResponse style: ${guardrails.responseStyle}`;
		}
		if (guardrails.maxResponseLength > 0) {
			prompt += `\n\nKeep responses under ${guardrails.maxResponseLength} characters.`;
		}
		if (guardrails.requireCitations) {
			prompt +=
				"\n\nAlways cite which knowledge base document you are drawing from when answering.";
		}
	}

	prompt +=
		"\n\nYou have persistent memory and tasks. Be helpful, concise, and proactive about completing your tasks.";
	return prompt;
}
