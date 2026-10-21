/**
 * Who picks the tool call in the eval (#1244).
 *
 * The harness never decides what a model would do; it is handed a driver. A {@link ScriptedDriver} replays fixed calls — the
 * deterministic half, used by the tests and by CI. {@link anthropicDriver} asks a real model, on demand, with the task's owner-shaped
 * prompt and the server's real `tools/list`; it is the only measure of how often a MODEL gets the first call right.
 */

export interface EvalTool {
	name: string;
	description?: string;
	inputSchema: unknown;
}

export interface ToolCall {
	name: string;
	args: Record<string, unknown>;
}

export interface EvalDriver {
	readonly label: string;
	/** Choose the FIRST tool call for this owner request. */
	chooseToolCall(prompt: string, tools: readonly EvalTool[]): Promise<ToolCall | null>;
}

/** Replays the given calls in order, one per request. A request past the end is a harness bug and throws. */
export class ScriptedDriver implements EvalDriver {
	readonly label = "scripted";
	private next = 0;
	constructor(private readonly calls: readonly ToolCall[]) {}
	async chooseToolCall(_prompt?: string, _tools?: readonly EvalTool[]): Promise<ToolCall | null> {
		const call = this.calls[this.next++];
		if (!call) throw new Error("ScriptedDriver has no more calls.");
		return call;
	}
}

export interface AnthropicDriverOptions {
	apiKey: string;
	model: string;
	/** The real `fetch`, captured before the harness replaces `globalThis.fetch` with its API stub. */
	fetchImpl: typeof fetch;
	/** Sent as the system prompt: what the owner's assistant is. Kept identical across runs so scores compare. */
	system?: string;
	maxTokens?: number;
}

export const EVAL_SYSTEM_PROMPT = "You are an assistant acting for the owner of a ProAgentStore account. Do what the owner asks by calling exactly one tool now: the single best first call. Instance ids in the request are exact.";

/**
 * A real model picks the first call (Anthropic Messages API, tool use). Sends every tool the server publishes, as a real client
 * would. `tool_choice: any` forces a call, so a refusal to call is never mistaken for a wrong tool. The model, temperature and prompt
 * are fixed by the caller so two runs are comparable.
 */
export function anthropicDriver(opts: AnthropicDriverOptions): EvalDriver {
	return {
		label: `anthropic:${opts.model}`,
		async chooseToolCall(prompt, tools) {
			const res = await opts.fetchImpl("https://api.anthropic.com/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
				body: JSON.stringify({
					model: opts.model,
					max_tokens: opts.maxTokens ?? 1024,
					temperature: 0,
					system: opts.system ?? EVAL_SYSTEM_PROMPT,
					tools: tools.map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema })),
					tool_choice: { type: "any" },
					messages: [{ role: "user", content: prompt }],
				}),
			});
			if (!res.ok) throw new Error(`Anthropic answered ${res.status}: ${(await res.text()).split("\n")[0]}`);
			const body = (await res.json()) as { content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }> };
			const use = body.content?.find((c) => c.type === "tool_use");
			return use?.name ? { name: use.name, args: use.input ?? {} } : null;
		},
	};
}
