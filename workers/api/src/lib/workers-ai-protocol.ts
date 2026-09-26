/**
 * Tool calling on Cloudflare Workers AI, spoken in the models' own protocol (#851).
 *
 * The brains were built against Anthropic and reached Workers AI through the same body, which the
 * open-source models read differently in five ways — each one enough to make a brain that
 * orchestrates on Sonnet confabulate, stall or fail on `@cf/meta/llama-4-scout-17b-16e-instruct`,
 * `@cf/meta/llama-3.3-70b-instruct-fp8-fast` or `@cf/qwen/qwen2.5-coder-32b-instruct`:
 *
 *   1. The MODEL. Every coding brain (Pilot, Co-pilot, Agent chat, Overseer) names
 *      `claude-sonnet-4-6`, which on this path became a Workers AI URL that does not exist.
 *   2. The OUTPUT CAP. The body said `maxTokens`; Workers AI reads `max_tokens` and defaults to
 *      256, so a reply — or the JSON of a tool call — was cut a paragraph in.
 *   3. The CALL SHAPE. Scout answers `tool_calls: [{id, type, function: {name, arguments}}]`; the
 *      Pilot read `call.name` and got `undefined`, so every decision was "unknown tool".
 *   4. Calls IN THE TEXT. Llama 3.3 sometimes writes its call as JSON in `response` and leaves
 *      `tool_calls` empty. Those are NOT executed (#853): call-shaped text cannot be told apart from
 *      a quotation of something the model read, so only the structured field is a call.
 *   5. The RESULT TURN. Results went back as an ASSISTANT paragraph ("I called tools: …") — the
 *      format #398 removed from the Anthropic path because the model learns to write results
 *      itself (#395). All three models accept a `tool` role; results now arrive in it.
 *
 * Shapes are from Cloudflare's published input/output schemas for the three models: `tool` is an
 * accepted role everywhere, Qwen takes string content only, Scout validates `tool_call_id` as nine
 * alphanumerics, and none of them has `tool_choice`.
 *
 * Pure: it maps bodies and results, it never fetches. `runCloudflareAi` is the one caller of the
 * two edges; the chat loop builds its round with `workersAiToolRound`.
 */
import { TOOL_CAPABLE_CF_DEFAULT } from "../agent-do-prompt.js";
import { isWorkersAiModel } from "./brain-models.js";
import { cutOffCall, type MalformedToolCall, splitToolCalls } from "./parse-tool-calls.js";

/** Marks a completion that came from Workers AI, so the chat loop answers in the `tool` role. */
export const WORKERS_AI_PROTOCOL = "workers-ai";

type Message = { role: string; content: unknown; tool_call_id?: unknown };

/** A Workers AI model id as-is; anything else (a brain's Anthropic default) → the tool-capable default. */
export function workersAiModelFor(model: string): string {
	return isWorkersAiModel(model) ? model : TOOL_CAPABLE_CF_DEFAULT;
}

/** Scout's `tool_call_id` pattern. An id that does not match is omitted rather than rejected. */
const TOOL_CALL_ID = /^[a-zA-Z0-9]{9}$/;

/**
 * A content block Workers AI cannot carry (#853). Thrown rather than dropped: flattening kept only
 * the text parts, so a PDF résumé reached the model as the bare instruction "Extract…" and the
 * model was asked to fill a profile from a document it never received.
 */
export class WorkersAiUnsupportedContentError extends Error {
	constructor(public readonly blockType: string) {
		super(
			blockType === "document"
				? "PDF input requires an Anthropic key — Cloudflare Workers AI cannot read documents. Add an Anthropic API key in Profile → API Keys."
				: `Cloudflare Workers AI cannot read a "${blockType}" content block — this request requires an Anthropic key.`,
		);
		this.name = "WorkersAiUnsupportedContentError";
	}
}

/** Text of any content shape the platform builds — a string, or text parts. Any other block is refused. */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((p) => {
				if (typeof p === "string") return p;
				const block = (p ?? {}) as { type?: unknown; text?: unknown };
				if (block.type !== undefined && block.type !== "text") throw new WorkersAiUnsupportedContentError(String(block.type));
				return typeof block.text === "string" ? block.text : "";
			})
			.filter(Boolean)
			.join("\n\n");
	}
	return content == null ? "" : JSON.stringify(content);
}

/**
 * The platform's provider-neutral body → what Workers AI validates.
 *
 * `toolChoice: "none"` drops the tools: Workers AI cannot declare a tool while forbidding its use,
 * and a final answer must not start another round. `timeoutMs` is the caller's deadline, not the
 * model's. Content is flattened to a string, which is the one shape all three models accept.
 */
export function toWorkersAiBody(body: unknown): Record<string, unknown> {
	const { maxTokens, toolChoice, timeoutMs: _t, messages, tools, ...rest } = (body ?? {}) as Record<string, unknown>;
	const out: Record<string, unknown> = { ...rest };
	if (out.max_tokens === undefined && typeof maxTokens === "number") out.max_tokens = maxTokens;
	if (Array.isArray(tools) && tools.length > 0 && toolChoice !== "none") out.tools = tools;
	if (Array.isArray(messages)) {
		out.messages = (messages as Message[]).map((m) => {
			const msg: Record<string, unknown> = { role: m.role, content: contentText(m.content) };
			if (m.role === "tool" && typeof m.tool_call_id === "string" && TOOL_CALL_ID.test(m.tool_call_id)) msg.tool_call_id = m.tool_call_id;
			return msg;
		});
	}
	return out;
}

export interface WorkersAiCompletion {
	response: string;
	tool_calls?: Array<{ name: string; arguments: Record<string, unknown>; id?: string }>;
	/** Calls the model made whose arguments were not valid JSON — never run, answered instead (#853 finding 4). */
	malformed_tool_calls?: MalformedToolCall[];
	usage?: { input: number; output: number };
	/** `max_tokens` when the reply was cut off at the output cap — Workers AI reports none (#853 finding 5). */
	stopReason?: "max_tokens";
	protocol: typeof WORKERS_AI_PROTOCOL;
}

/**
 * A Workers AI result → the flat shape every brain reads (`{name, arguments, id?}` calls and
 * `{input, output}` usage).
 *
 * Calls come ONLY from the structured `tool_calls` field — the model's own tool-call channel, filled
 * by Workers AI's parser (#853). Call-shaped JSON in the reply TEXT is never a call, wherever it sits:
 * a brain that quotes or echoes what it read — a terminal pane, a fetched page, a tool result
 * carrying `{"name":"send_to_cli",…}` — would otherwise execute it, which is a prompt injection
 * turned into an action. Lifting even a LEADING call left that door open to an echo; the text is
 * prose, and the callers strip and report such JSON as named-but-never-run.
 */
export function fromWorkersAiResult(raw: unknown, maxTokens?: number): WorkersAiCompletion {
	const r = (raw ?? {}) as { response?: unknown; tool_calls?: unknown; usage?: Record<string, number> };
	const response = typeof r.response === "string" ? r.response : r.response == null ? "" : JSON.stringify(r.response);
	const { calls, malformed } = splitToolCalls(Array.isArray(r.tool_calls) ? r.tool_calls : []);
	const u = r.usage;
	// Workers AI says nothing about WHY it stopped (#853 finding 5), so the cap is inferred: the whole
	// output budget spent, or a reply that ends inside a call it never closed.
	const spent = u?.completion_tokens || u?.output_tokens || 0;
	const cutOff = (typeof maxTokens === "number" && maxTokens > 0 && spent >= maxTokens) || cutOffCall(response) !== null;
	return {
		response,
		...(cutOff ? { stopReason: "max_tokens" as const } : {}),
		...(calls.length > 0 ? { tool_calls: calls } : {}),
		...(malformed.length > 0 ? { malformed_tool_calls: malformed } : {}),
		...(u ? { usage: { input: u.prompt_tokens || u.input_tokens || 0, output: u.completion_tokens || u.output_tokens || 0 } } : {}),
		protocol: WORKERS_AI_PROTOCOL,
	};
}

/**
 * One settled tool round, as Workers AI messages: the model's own call as its assistant turn, then
 * each result in the `tool` role — the platform's, never the model's — in call order.
 *
 * `results[i]` answers `calls[i]`; the chat loop records exactly one outcome per call, refusals
 * included, so the two lists line up by construction.
 */
export function workersAiToolRound(
	text: string,
	calls: ReadonlyArray<{ name: string; arguments: Record<string, unknown>; id?: string }>,
	results: readonly string[],
): Message[] {
	const said = JSON.stringify(calls.map((c) => ({ name: c.name, arguments: c.arguments ?? {} })));
	const out: Message[] = [{ role: "assistant", content: text.trim() ? `${text.trim()}\n${said}` : said }];
	calls.forEach((c, i) => {
		out.push({ role: "tool", content: results[i] ?? `[${c.name}]: (no result)`, ...(c.id ? { tool_call_id: c.id } : {}) });
	});
	return out;
}

/**
 * A reply that ANNOUNCES an action instead of taking it — "Let me check the terminal", "I'll send
 * that to the CLI". On Sonnet the call follows in the same turn; the open models often stop at the
 * sentence, and the owner reads a promise nothing will keep. Used to re-ask once, never to decide.
 */
export function announcesAction(text: string): boolean {
	return /\b(let me|i'll|i will|i am going to|i'm going to|i'll now|now i'll)\s+(now\s+)?(check|read|look|send|run|call|query|fetch|open|start|list|search|create|update|ask|tell|drive|see)\b/i.test(
		text,
	);
}

/** The one correction a Workers AI turn gets when it announced an action and took none. */
export const CALL_NOW_CORRECTION =
	"You described an action but did not call a tool, so nothing happened. If a tool is needed, call it now through the tool interface — do not describe it. If no tool is needed, give your answer directly.";
