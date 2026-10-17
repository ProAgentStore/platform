/**
 * Agent-written text in the console (#1129) — questions, objectives, action-log lines, ticket answers.
 *
 * The rule is: text an agent or a model wrote is MARKDOWN. It is rendered through the SDK's
 * `renderMd` (escape-first, links http(s) only — see `components/MarkdownText.tsx`). Before #1129 it
 * was printed raw, so `**Notification channel**` showed its asterisks and a numbered question ran
 * together as one block. This file holds the pure parts of that rule.
 */

/**
 * Put an INLINE numbered list onto its own lines, so markdown renders it as a list.
 *
 * An agent often writes "Three decisions: 1. **Channel** … 2. **Threshold** … 3. Retry?" as one
 * paragraph; markdown only makes a list of items that each start a line. This splits only a real
 * sequence: a `1.` (or `1)`) followed by a `2.`, `3.`, … in order, each after whitespace and before a
 * space. A lone "version 2. something" or "step 3) only" is not a sequence and is left alone.
 * Text that already has its items on separate lines is returned unchanged.
 */
export function splitInlineNumberedList(text: string): string {
	const first = /(^|\s)1([.)])\s/.exec(text);
	if (!first) return text;
	const sep = first[2];
	const at: number[] = [first.index + first[1].length];
	let from = at[0] + 2;
	for (let n = 2; n <= 50; n++) {
		const re = new RegExp(`\\s${n}\\${sep}\\s`, "g");
		re.lastIndex = from;
		const m = re.exec(text);
		if (!m) break;
		at.push(m.index + 1);
		from = m.index + 1 + String(n).length + 1;
	}
	if (at.length < 2) return text;
	let out = "";
	let prev = 0;
	for (const [k, i] of at.entries()) {
		const before = text.slice(prev, i).replace(/[ \t]+$/, "");
		// Markdown starts a list only after a blank line, so the lead-in gets one; items get one newline each.
		out += before + (before === "" || /\n$/.test(before) ? "" : k === 0 ? "\n\n" : "\n");
		prev = i;
	}
	return out + text.slice(prev);
}

/**
 * The same text as plain words, for a ONE-LINE preview inside a clickable card (a board card is a
 * `<button>`, so rendered markdown with links cannot go in it). Markers are dropped, not shown:
 * `**bold**` → `bold`, `` `code` `` → `code`, a heading's `#`, a list's bullet, a link's URL.
 */
export function plainMarkdown(text: string): string {
	return text
		.replace(/\[([^\]]+)\]\((?:https?:\/\/)[^)\s]+\)/g, "$1")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/(^|[\s(])[*_](\S(?:[^*_\n]*\S)?)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/^\s*[-*+]\s+/gm, "• ")
		.replace(/^\s*>\s?/gm, "");
}

/**
 * The fixed choices an agent's question offers (#1129). The structured `data.options` the API puts on
 * an `agent.needs_input` event comes FIRST — it is the agent's own list. Parsing the `(… from: a, b)`
 * text is only the fallback for an event from an older runner. That parse splits on commas, so it
 * broke any option containing one, and it silently dropped options of 70 characters or more, which is
 * how a question with options came to show only a free-text box.
 */
export function questionOptions(data: { options?: unknown } | null | undefined, legacyText: string): string[] {
	const structured = Array.isArray(data?.options) ? data.options.filter((o): o is string => typeof o === "string" && o.trim() !== "").map((o) => o.trim()) : [];
	if (structured.length) return [...new Set(structured)].slice(0, 16);
	const fromIdx = legacyText.toLowerCase().indexOf("from:");
	if (fromIdx < 0) return [];
	return [...new Set(legacyText.slice(fromIdx + 5).split(",").map((s) => s.trim().replace(/\)$/, "")).filter(Boolean))].slice(0, 16);
}

/** The agent's `why`, without the `from: …` options list it carries for older consoles — those render as buttons. */
export function whyWithoutOptions(why: string): string {
	return why.replace(/\s*(?:—\s*)?from:.*$/is, "").trim();
}
