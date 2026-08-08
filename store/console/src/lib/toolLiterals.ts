/**
 * Where the console names a connector tool in its own source, and where it gets that vocabulary
 * from (#409).
 *
 * The defect this exists to stop is NOT "the console hardcodes a tool name" — a tab built on one
 * connector has to name its tools somewhere. It is **a hardcoded name with nothing checking the
 * agent still declares it**. `6cbd8dc` converted the Terminal tab from `tmux_*` to `terminal_*`;
 * five days later migration `0099` took `terminal_*` off the tmux Operator's allowlist, and nothing
 * in the tree objected. The first person to find out was the owner, looking at a red line addressed
 * to a creator and an empty state that told them to go open a tmux session.
 *
 * So the check is a source scan, in the shape this tree already uses for exactly this job
 * (`control-shapes.ts`, `designTokens.ts`): find the literals, and pin the list. A new one has to be
 * added to the pin deliberately, next to a sentence saying what guards it.
 *
 * ── What this can and cannot prove ──
 *
 * It cannot prove a name is "reached only behind a policy check" — that is dataflow, and a static
 * regex has no business claiming it. What it CAN do is make the set of places that name a tool
 * small, explicit, and reviewed: two files, each with a stated reason. That is the same bargain
 * `control-shapes.ts` strikes with its pin, and it is the half that would have caught this.
 */

import { maskComments } from "./jsx-tags";

export interface ToolLiteral {
	/** 1-based line of the literal. */
	line: number;
	/** The tool name, as written. */
	name: string;
}

/**
 * Names that LOOK like connector tools, taken from the connector definitions themselves.
 *
 * Derived rather than listed, so a connector added by someone else is covered the day it lands.
 * At least one underscore is required, which drops the `id`/`label`/manifest-example strings that
 * share the `name:` key (`main`, `key`, `uri`, `fws`, …). A few non-tool names survive that filter
 * and that is deliberately fine: a vocabulary that is too WIDE only guards more strings, while one
 * that is too narrow is a hole. The test that calls this asserts it is non-vacuous.
 */
export function toolVocabulary(connectorSources: readonly string[]): Set<string> {
	const out = new Set<string>();
	for (const src of connectorSources) {
		for (const m of maskComments(src).matchAll(/\bname:\s*"([a-z][a-z0-9]*(?:_[a-z0-9]+)+)"/g)) out.add(m[1]);
	}
	return out;
}

/**
 * Every place this source spells a tool name as a string literal.
 *
 * Comments are masked first, via the tokenizer the other two source guards share: prose about a
 * tool is not a call to it, and a guard that reports the sentence explaining the fix is a guard
 * people learn to suppress.
 */
export function findToolLiterals(source: string, vocabulary: ReadonlySet<string>): ToolLiteral[] {
	const masked = maskComments(source);
	const out: ToolLiteral[] = [];
	// Any whole-word occurrence, NOT only a name that fills a whole string. The first cut required
	// the quotes to touch the name and missed `` `…/tools/mcp_call_tool` `` — a tool name baked into
	// a URL path is the most literal form of the thing being guarded against, so a rule that let it
	// through would have been a guard shaped exactly around the one case it already knew about.
	for (const m of masked.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) {
		if (!vocabulary.has(m[0])) continue;
		out.push({ line: masked.slice(0, m.index).split("\n").length, name: m[0] });
	}
	return out;
}
