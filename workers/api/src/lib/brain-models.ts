/**
 * The models an owner may pick as an instance's BRAIN — the chat and orchestration layer that reads
 * the terminal, calls tools and drives the coding engine (#852).
 *
 * Every entry is tool-capable, and the three Cloudflare Workers AI models are here because #851 gave
 * them tool-calling parity with Sonnet. `hint` is what lets an owner drop a light-orchestration
 * instance to a cheap model knowingly rather than guessing from an id.
 *
 * Import-free on purpose: the console imports this list for its picker, and a DOM tsconfig cannot
 * take the Workers globals `Env` would drag in.
 */
export interface BrainModel {
	id: string;
	label: string;
	/** Whose credentials run it: Anthropic (BYOK key) or Cloudflare Workers AI (BYOK account + token). */
	provider: "anthropic" | "cloudflare";
	/** Cost and capability, in the owner's words. */
	hint: string;
}

export const BRAIN_MODELS: readonly BrainModel[] = [
	{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: "anthropic", hint: "most capable · premium cost" },
	{ id: "@cf/meta/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout 17B", provider: "cloudflare", hint: "cheap · fast · good default for light orchestration" },
	{ id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Llama 3.3 70B", provider: "cloudflare", hint: "cheap · stronger reasoning · slower" },
	{ id: "@cf/qwen/qwen2.5-coder-32b-instruct", label: "Qwen 2.5 Coder 32B", provider: "cloudflare", hint: "cheap · code-optimized" },
];

export function brainModel(id: string): BrainModel | undefined {
	return BRAIN_MODELS.find((m) => m.id === id);
}

/** The brain models with their hints, in the one sentence every refusal lists them in. */
export const brainModelOptions = () => BRAIN_MODELS.map((m) => `${m.id} (${m.hint})`).join("; ");

/**
 * Why `model` cannot run an agent's brain as named, or null when it is a brain model (#853 finding 7).
 * Calling tools is not enough: the Anthropic brain always runs claude-sonnet-4-6, so a Haiku or Opus id
 * ran — and billed — Sonnet under another name, and a Workers AI model outside the list never had
 * #851's tool-calling parity.
 */
export function offCatalogueModel(model: string): string | null {
	if (brainModel(model)) return null;
	const sonnet = model.startsWith("claude-") ? " The Anthropic brain always runs claude-sonnet-4-6, so this pick would run Sonnet, not the model named." : "";
	return `${model} is not a brain model.${sonnet} Brain models: ${brainModelOptions()}.`;
}

/**
 * The same rule for an agent TEMPLATE's model (#863) — what every subscriber's instance starts on.
 * Omitted or empty keeps meaning "the platform default". No credential check: those belong to
 * whoever picks a model for an instance, not to the template's creator.
 */
export function templateModelRefusal(model: unknown): string | null {
	if (model === undefined || model === null || model === "") return null;
	if (typeof model !== "string") return `model must be a brain model id. Brain models: ${brainModelOptions()}.`;
	return offCatalogueModel(model);
}

/** A Workers AI model id — the one kind of id whose provider the id itself names. */
export function isWorkersAiModel(id: string): boolean {
	return id.startsWith("@cf/") || id.startsWith("@hf/");
}
