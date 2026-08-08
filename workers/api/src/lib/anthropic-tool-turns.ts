/**
 * Tool rounds in the provider's own protocol (#398).
 *
 * ── What the loop used to send
 *
 * After a round of tools ran, `agent-think.ts` appended:
 *
 *   { role: "assistant", content: `I called tools:\n${toolResults.join("\n")}` }
 *   { role: "user",      content: "Continue based on the tool results above. …" }
 *
 * Two things are wrong with that, and the second is structural.
 *
 * **The model's `tool_use` turn was never added to the conversation at all.** `runAnthropic` read
 * the `tool_use` blocks out of the response and converted them to a Workers-AI-shaped `tool_calls`
 * array, and nothing put them back. So the exchange the provider saw was: a request with `tools` →
 * a response with `tool_use` → a request in which that never happened, plus an assistant paragraph
 * narrating results. The ARGUMENTS went with it: the follow-up read `[repo_read_file]: <contents>`
 * with no path, so calling one tool twice in a round with different arguments left the model
 * inferring which result belonged to which call, and guessing when it could not.
 *
 * **Ground truth was stored in the one role that means "the model's own words".** A `tool_result`
 * block is structurally the platform's; an `assistant` message is structurally the model's. After
 * `normalizeForAnthropic` merged consecutive same-role turns they were one paragraph, and on the
 * next turn nothing distinguished a real tool output from something the model asserted.
 *
 * ── Why that is #395's cause, not its neighbour
 *
 * In #395 the model wrote its own `<tool_call>` / `<tool_response>` pairs and invented their
 * contents. Look at what this loop taught it every single turn: tool results appear in the
 * transcript as assistant prose beginning "I called tools:". It reproduced the format it was shown.
 * It had no structural signal that a result is not something an assistant writes, because in this
 * conversation it was exactly that. #395 treats the output; this is the input.
 *
 * ── What this module is
 *
 * The pure half of the protocol: which `tool_use` ids an assistant turn introduced, the `user` turn
 * of `tool_result` blocks that answers them, and the two rules that keep a message array legal
 * after `normalizeForAnthropic` has dropped and merged turns. The provider is strict in ways that
 * are invisible until they 400 the whole chat — every `tool_use` needs an answering `tool_result`,
 * every `tool_result` needs an introducing `tool_use`, and the results come FIRST in their turn —
 * so those rules are enforced here, in one place, with tests, rather than trusted to hold.
 *
 * The Workers-AI fallback keeps the prose shape. It is a different provider with a different
 * protocol, and its limitation should not set the format for the one almost every chat actually
 * runs on (`claude-sonnet-4-6`). `agent-think.ts` branches on whether the completion carried
 * content blocks at all, which is self-describing — no provider enum to keep in sync.
 */

/** One Anthropic content block. Deliberately loose: we echo the provider's own blocks verbatim. */
export interface ContentBlock {
	type: string;
	[key: string]: unknown;
}

/** What one executed (or refused) call produced, as the model should see it. */
export interface ToolOutcome {
	content: string;
	/** The call did not produce what was asked — an error, a refusal, or a de-duplicated repeat. */
	isError: boolean;
}

const isBlock = (b: unknown): b is ContentBlock =>
	!!b && typeof b === "object" && typeof (b as { type?: unknown }).type === "string";

/**
 * The `tool_use` ids an assistant turn introduced, in order.
 *
 * This — not the normalized `tool_calls` array — is the authority for what must be answered.
 * `normalizeToolCalls` silently SKIPS a call whose `arguments` are malformed JSON (deliberately:
 * one bad call must not fail the batch), and a skipped call still has a `tool_use` block sitting in
 * the assistant turn. Building the answers from the normalized list would therefore leave that id
 * unanswered, and the provider rejects the entire request for it. Read the ids from the turn that
 * actually carries them.
 */
export function toolUseIdsOf(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const ids: string[] = [];
	for (const b of content) {
		if (isBlock(b) && b.type === "tool_use" && typeof b.id === "string" && b.id) ids.push(b.id);
	}
	return ids;
}

/**
 * The `user` turn that answers a round: one `tool_result` per id, then the platform's own
 * instruction as a trailing text block.
 *
 * Every id gets an entry, including one the platform never ran — an unanswered `tool_use` is a
 * 400 on the whole request, and a turn that fails to send is worse than a turn that reports a
 * miss. The fallback text says plainly that nothing ran, because the alternative (an empty result)
 * reads to the model as a tool that returned nothing, which is a different and false fact.
 *
 * The instruction rides in the SAME turn rather than a second `user` message. Two consecutive user
 * turns would be merged anyway, and merging a string after a block array is the operation that has
 * to put the results back in front — doing it here means the legal shape is the one built, not the
 * one repaired.
 */
export function toolResultTurn(
	ids: readonly string[],
	results: ReadonlyMap<string, ToolOutcome>,
	trailingText: string,
): ContentBlock[] {
	const blocks: ContentBlock[] = ids.map((id) => {
		const r = results.get(id);
		return {
			type: "tool_result",
			tool_use_id: id,
			content: r ? r.content : "(the platform did not run this call, so there is no result for it)",
			...(r ? (r.isError ? { is_error: true } : {}) : { is_error: true }),
		};
	});
	if (trailingText) blocks.push({ type: "text", text: trailingText });
	return blocks;
}

/**
 * Does this message array carry `tool_use` / `tool_result` blocks?
 *
 * The provider requires that a request containing either one ALSO define `tools` — "Requests which
 * include tool_use or tool_result blocks must define tools". That is a constraint on the whole
 * conversation, not on the current ask, so the two completions that deliberately send no tools (the
 * final answer, and #395's correction round) would 400 the moment a structured round precedes them.
 * They send the definitions with `tool_choice: "none"` instead: the tools are declared because the
 * transcript refers to them, and refused because the turn is meant to produce prose.
 */
export function hasToolBlocks(msgs: ReadonlyArray<{ content: unknown }>): boolean {
	for (const m of msgs) {
		if (!Array.isArray(m.content)) continue;
		for (const b of m.content) {
			if (isBlock(b) && (b.type === "tool_use" || b.type === "tool_result")) return true;
		}
	}
	return false;
}

/** Blocks with every `tool_result` moved to the front, order otherwise preserved. */
function toolResultsFirst(blocks: unknown[]): unknown[] {
	const results = blocks.filter((b) => isBlock(b) && b.type === "tool_result");
	if (results.length === 0) return blocks;
	return [...results, ...blocks.filter((b) => !(isBlock(b) && b.type === "tool_result"))];
}

/**
 * Merge two same-role turns into one.
 *
 * String + string stays a paragraph join, which is the case this started as (an errored turn plus
 * the next question). Anything else becomes blocks — and then the results are hoisted back to the
 * front, because the provider requires `tool_result` blocks to open the turn they belong to and the
 * merge is precisely what would otherwise bury them behind a "Now give your final answer" string.
 */
export function mergeContent(a: unknown, b: unknown): unknown {
	if (typeof a === "string" && typeof b === "string") return `${a}\n\n${b}`;
	const toBlocks = (c: unknown): unknown[] => (Array.isArray(c) ? c : [{ type: "text", text: String(c) }]);
	return toolResultsFirst([...toBlocks(a), ...toBlocks(b)]);
}

/** A message as the normalizer handles it, before it reaches the provider. */
export interface RoleMessage {
	role: "user" | "assistant";
	content: unknown;
}

/** Content with the named block types removed; `null` when nothing is left to send. */
function withoutBlocks(content: unknown, drop: (b: ContentBlock) => boolean): unknown | null {
	if (!Array.isArray(content)) return content;
	const kept = content.filter((b) => !(isBlock(b) && drop(b)));
	if (kept.length === content.length) return content;
	return kept.length > 0 ? kept : null;
}

/**
 * Drop `tool_use` / `tool_result` blocks that have lost their partner.
 *
 * Unreachable on today's happy path — the loop appends both turns together, at the tail, after the
 * history — and that is exactly why it is worth having: the two ways it becomes reachable are
 * ordinary maintenance. `normalizeForAnthropic` drops LEADING assistant turns (a 10-message context
 * window can start on one), which orphans the results that answered it; and the day these blocks
 * are persisted into history rather than living for one turn, a window can begin anywhere. Either
 * way the symptom is not a degraded reply, it is a 400 that fails the whole chat, and the cause is
 * three files from the change that made it possible.
 *
 * A turn emptied by the drop is removed entirely rather than sent with empty content, which the
 * provider also rejects.
 */
export function pairToolBlocks(msgs: readonly RoleMessage[]): RoleMessage[] {
	const introduced = new Set<string>();
	const answered = new Set<string>();
	for (const m of msgs) {
		if (m.role === "assistant") for (const id of toolUseIdsOf(m.content)) introduced.add(id);
		if (m.role === "user" && Array.isArray(m.content)) {
			for (const b of m.content) {
				if (isBlock(b) && b.type === "tool_result" && typeof b.tool_use_id === "string") answered.add(b.tool_use_id);
			}
		}
	}
	const out: RoleMessage[] = [];
	for (const m of msgs) {
		const content =
			m.role === "assistant"
				? withoutBlocks(m.content, (b) => b.type === "tool_use" && !(typeof b.id === "string" && answered.has(b.id)))
				: withoutBlocks(m.content, (b) => b.type === "tool_result" && !(typeof b.tool_use_id === "string" && introduced.has(b.tool_use_id)));
		if (content !== null) out.push({ role: m.role, content });
	}
	return out;
}

/**
 * Make the array end on a `user` turn, because `claude-sonnet-4-6` refuses a prefill.
 *
 * ── The shape that produced this
 *
 * Serialising chat turns (#429) made a history that had never occurred before. A message arriving
 * mid-turn is appended to the transcript the moment it arrives — that is what stops it being lost —
 * but the running turn's reply is appended when it FINISHES, so the stored order is:
 *
 *     user A            06:11:01
 *     user B            06:11:05   ← arrived while turn A was still running
 *     assistant A-reply 06:11:07
 *
 * Chronologically correct, and the next turn's context therefore ended on an assistant turn.
 * Anthropic reads a trailing assistant turn as a PREFILL, and this model does not support one:
 * `400 — This model does not support assistant message prefill. The conversation must end with a
 * user message.` Observed in production immediately after #429 deployed, on the exact instance
 * #429 was reported from.
 *
 * ── Why the last user turn MOVES rather than the assistant turn being dropped
 *
 * Dropping it would delete the reply the agent just gave from its own context — precisely the fact
 * #429 exists to make visible, since a turn that cannot see it answers the same message twice. The
 * move loses nothing and restores the order the conversation logically had:
 *
 *     user A → assistant A-reply → user B
 *
 * Applied BEFORE the same-role merge in `normalizeForAnthropic`, deliberately: merged first, `user
 * A` and `user B` become one turn and the array still ends on the assistant.
 *
 * The one case that cannot be reordered is a window holding a single user turn followed by
 * assistant turns (the earlier user message fell out of the ten). Moving it would leave a LEADING
 * assistant, which the provider also rejects, so those turns are dropped instead — the same trade
 * `normalizeForAnthropic` already makes at the front of the array, for the same reason.
 */
export function endOnUserTurn(msgs: readonly RoleMessage[]): RoleMessage[] {
	if (msgs.length === 0) return [];
	if (msgs[msgs.length - 1].role === "user") return [...msgs];
	let lastUser = -1;
	for (let i = msgs.length - 1; i >= 0; i--) {
		if (msgs[i].role === "user") {
			lastUser = i;
			break;
		}
	}
	// Nothing the model could be answering. An all-assistant array is already dropped to nothing at
	// the front of `normalizeForAnthropic`; this is the same answer for the same reason.
	if (lastUser < 0) return [];
	const moved = [...msgs.slice(0, lastUser), ...msgs.slice(lastUser + 1), msgs[lastUser]];
	// Re-drop at the front: with exactly one user turn the move creates the leading assistant the
	// provider rejects, and a legal short array beats an illegal complete one.
	let start = 0;
	while (start < moved.length && moved[start].role === "assistant") start++;
	return moved.slice(start);
}
