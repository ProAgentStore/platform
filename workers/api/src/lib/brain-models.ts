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

/** A Workers AI model id — the one kind of id whose provider the id itself names. */
export function isWorkersAiModel(id: string): boolean {
	return id.startsWith("@cf/") || id.startsWith("@hf/");
}
