/**
 * How a chat message should be presented — pure classification, shared by every chat surface.
 *
 * This logic was implemented THREE times, near line-for-line: the console's instance chat, the
 * Coder's Co-pilot, and the pre-subscribe agent page. Same `/^[✅❌]/` sniff, same `**name**`
 * parse, same "N tools" threshold. Three copies of a heuristic is three chances to drift, and the
 * drift is invisible — a tool chip that stops collapsing just looks like a chatty agent.
 *
 * Deliberately NOT a component: this is the part with rules worth testing, and keeping it free of
 * React means the console, an agent UI, and a future DOM-mounted custom surface can all share it
 * (see docs/agent-ui-blocks.md).
 */

export type ChatMessageKind = "tool" | "system" | "user" | "assistant";

export interface ChatMessageLike {
	role: string;
	content: string;
	id?: string;
	createdAt?: string;
}

/**
 * A tool-call message is a SYSTEM message whose content starts with the runtime's result marker.
 * Role alone is not enough — loop-status notices are also system messages and must stay visible
 * as pills rather than collapsing into a chip nobody opens.
 */
export function isToolCallMessage(m: ChatMessageLike): boolean {
	return m.role === "system" && /^[✅❌]/.test(m.content ?? "");
}

export function classifyMessage(m: ChatMessageLike): ChatMessageKind {
	if (isToolCallMessage(m)) return "tool";
	if (m.role === "system") return "system";
	return m.role === "user" ? "user" : "assistant";
}

/** How many tool names to list before collapsing to a count. */
const NAME_LIMIT = 2;

/**
 * Label for a collapsed tool-call chip: "get_tasks, get_activity" or "3 tools".
 *
 * Falls back to "tools" rather than an empty string — a chip reading "Used " looks broken, and
 * the marker can be present without a parseable name.
 */
export function toolCallSummary(content: string): string {
	const names = (content ?? "").match(/\*\*(\w+)\*\*/g)?.map((t) => t.replace(/\*\*/g, "")) ?? [];
	if (!names.length) return "tools";
	return names.length <= NAME_LIMIT ? names.join(", ") : `${names.length} tools`;
}

/**
 * A stable React key.
 *
 * Both copies keyed on `id || createdAt || index`, which collides when several messages share a
 * timestamp — the tool-call and its reply are written in the same millisecond, so a re-render
 * could reuse the wrong node. Index is the last resort, not the second.
 */
export function messageKey(m: ChatMessageLike, index: number): string {
	if (m.id) return m.id;
	return m.createdAt ? `${m.createdAt}:${index}` : `i${index}`;
}
