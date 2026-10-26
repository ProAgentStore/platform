/**
 * How a brain's prompt is shaped for Anthropic's Messages API (#1356): the system prompt and user prompt as cache-marked blocks, and the
 * message array normalised to what the API accepts (first message a user turn, strictly alternating roles, paired tool blocks).
 *
 * Moved out of `user-ai.ts` unchanged. Pure — no network, no key — which is why it is its own module and not part of the adapter that
 * sends the request. `user-ai.ts` re-exports the names other files import.
 */
import { endOnUserTurn, mergeContent, pairToolBlocks } from "./anthropic-tool-turns.js";

/**
 * Anthropic's Messages API rejects any array whose first message isn't `user` or
 * whose roles don't strictly alternate. Our chat history routinely violates both:
 * a 10-message context window can start on `assistant` (turn 6+), an errored turn
 * leaves two adjacent `user` messages once the `system` error note is filtered out,
 * and the tool loop appends `assistant, user, user`. Normalize before sending:
 * drop leading assistants, then merge consecutive same-role messages into one.
 *
 * It now also knows about `tool_use` / `tool_result` blocks (#398). It has to: those are the two
 * block types the API pairs across turns, and this function is the only thing between the caller's
 * array and the wire that DROPS and MERGES turns. Its merge of consecutive same-role turns is
 * exactly what used to erase the boundary between a platform result and the model's own prose, and
 * left unchanged it would now bury a `tool_result` behind a trailing string or orphan one behind a
 * dropped leading assistant — both of which the provider answers with a 400 on the whole request.
 * The rules are pure and live in lib/anthropic-tool-turns.ts with their tests.
 */
export function normalizeForAnthropic(
	msgs: Array<{ role: string; content: unknown }>,
): Array<{ role: "user" | "assistant"; content: unknown }> {
	const mapped = msgs.map((m) => ({
		role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
		content: m.content,
	}));
	let start = 0;
	while (start < mapped.length && mapped[start].role === "assistant") start++;
	// …and the same rule at the OTHER end (#429). Serialising chat turns made a history whose tail
	// is `user, user, assistant` — the mid-turn arrival is stored when it arrives, the running
	// turn's reply when it finishes — and a trailing assistant turn is a PREFILL, which
	// `claude-sonnet-4-6` refuses with a 400 on the whole request. Before merging, deliberately:
	// merged first, the two user turns become one and the array still ends on the assistant.
	const ordered = endOnUserTurn(mapped.slice(start));
	// Pair BEFORE merging: an orphan is created by the drop above, and merging first would fold it
	// into a neighbouring turn where "which turn introduced this id" is no longer answerable.
	const paired = pairToolBlocks(ordered);
	const merged: Array<{ role: "user" | "assistant"; content: unknown }> = [];
	for (const m of paired) {
		const last = merged[merged.length - 1];
		if (last && last.role === m.role) {
			last.content = mergeContent(last.content, m.content);
		} else {
			merged.push({ role: m.role, content: m.content });
		}
	}
	return merged;
}

/**
 * One ordered part of a system prompt (#768).
 *
 * A system message's `content` is either a string — one block, cached whole, which is what every
 * caller sent before this — or an array of these. The array exists because the provider's cache
 * matches an identical PREFIX: a chat prompt that interleaves per-turn facts (the clock, retrieved
 * documents, the terminal tail) with fixed instructions changes early, so everything after the
 * first changing byte is re-written to the cache on every turn. Splitting it lets the fixed part
 * be read back instead.
 *
 * `cache` places a breakpoint at the END of the block. `label` names the block in prompt-section
 * traces and is never sent. `ttl: "1h"` asks for the 1-hour cache instead of the 5-minute one (#914)
 * — for a prefix whose callers are further apart than five minutes, which the Pilot's are.
 */
export interface SystemPromptBlock {
	text: string;
	cache?: boolean;
	ttl?: "1h";
	label?: string;
}

/** Anthropic accepts at most four cache breakpoints per request. */
export const MAX_CACHE_BREAKPOINTS = 4;

export function isSystemPromptBlocks(content: unknown): content is SystemPromptBlock[] {
	return Array.isArray(content) && content.every((b) => b !== null && typeof b === "object" && typeof (b as SystemPromptBlock).text === "string");
}

/**
 * The system prompt as ONE string, for a provider with no notion of blocks.
 *
 * Joined with nothing, because the builders already open each section with its own newlines: the
 * flattened text is byte-identical to what a single string builder would have produced.
 */
export function systemPromptText(content: unknown): string {
	return isSystemPromptBlocks(content) ? content.map((b) => b.text).join("") : String(content ?? "");
}

/**
 * Prompt-section trace entries for a system message: one per block (#768), so a run's trace shows
 * the cached half and the per-turn half separately — the split is only worth what that difference
 * measures. A string stays one section under `label`, as it was traced before.
 */
export function systemPromptSections(label: string, content: unknown): Array<{ label: string; value: unknown }> {
	return isSystemPromptBlocks(content) ? content.map((b) => ({ label: `${label}.${b.label ?? "block"}`, value: b.text })) : [{ label, value: content }];
}

/**
 * The Anthropic `system` field for a system message's content.
 *
 * A string becomes one cached block, as it always has. Blocks keep their order; empty ones are
 * dropped (the API rejects an empty text block, and an absent section is simply absent); a
 * breakpoint goes on each block marked `cache`, keeping the LAST four when more are asked for —
 * a later breakpoint already covers the prefix before it, so it is the earlier ones that are
 * redundant. Returns undefined when nothing is left to send.
 *
 * A breakpoint asks for the 1-hour TTL only while no 5-minute one precedes it: the provider requires
 * longer-lived entries to come first, so a 1h request after a 5m breakpoint is sent as 5m rather
 * than as a request the API rejects.
 */
export type AnthropicSystemBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral"; ttl?: "1h" } };

/**
 * The provider's cache rules, held across ONE request (#914): at most four breakpoints in all, and a
 * 1-hour entry may not follow a 5-minute one. The system prompt and a user message's prompt blocks
 * draw on the same budget, in request order — tools, system, then messages.
 */
export interface CacheBudget {
	left: number;
	shortSeen: boolean;
}

function toAnthropicBlocks(blocks: readonly SystemPromptBlock[], budget: CacheBudget): AnthropicSystemBlock[] {
	const kept = blocks.filter((b) => b.text.length > 0);
	// The LAST breakpoints asked for are kept: a later one already covers the prefix before it.
	const breakpoints = new Set(kept.filter((b) => b.cache).slice(-Math.max(0, budget.left)));
	budget.left -= breakpoints.size;
	return kept.map((b): AnthropicSystemBlock => {
		if (!breakpoints.has(b)) return { type: "text", text: b.text };
		const long = b.ttl === "1h" && !budget.shortSeen;
		if (!long) budget.shortSeen = true;
		return { type: "text", text: b.text, cache_control: long ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" } };
	});
}

export function anthropicSystemBlocks(content: unknown, budget: CacheBudget = { left: MAX_CACHE_BREAKPOINTS, shortSeen: false }): AnthropicSystemBlock[] | undefined {
	if (!isSystemPromptBlocks(content)) {
		const text = String(content ?? "");
		if (!text) return undefined;
		budget.left -= 1;
		budget.shortSeen = true;
		return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
	}
	const out = toAnthropicBlocks(content, budget);
	return out.length ? out : undefined;
}

/**
 * A USER message written as prompt blocks (#914) — the same `{text, cache?, ttl?, label?}` a system
 * prompt uses, and nothing else: an array carrying a `type` is already in the provider's own block
 * shape (a PDF `document`, a `tool_result`) and passes through untouched.
 */
export function isUserPromptBlocks(content: unknown): content is SystemPromptBlock[] {
	return isSystemPromptBlocks(content) && content.length > 0 && content.every((b) => !("type" in b));
}

/** A message list with every user prompt-block message as provider text blocks, within the request's budget. */
export function anthropicUserBlocks<M extends { role: string; content: unknown }>(messages: readonly M[], budget: CacheBudget): M[] {
	return messages.map((m) => (m.role === "user" && isUserPromptBlocks(m.content) ? { ...m, content: toAnthropicBlocks(m.content, budget) } : m));
}
