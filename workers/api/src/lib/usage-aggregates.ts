/**
 * What a dollar aggregate over `ai_usage` is allowed to be called (#346).
 *
 * ── The rule, and why it is not "filter everything"
 *
 * `cost_micros` is NOTIONAL VALUE on every row: tokens × published list price. Whether it is
 * MONEY depends on `payer` (migration 0092), and only on `payer`. Two different questions get
 * asked of the same column, and both are legitimate:
 *
 *   "how much AI did this account consume, in comparable units?"  → sum everything
 *   "how much does someone owe?"                                  → sum {@link CHARGED_SQL} only
 *
 * So the rule an aggregate must satisfy is not "always filter". Filtering a DISPLAY would make a
 * subscription-heavy user's activity read as near-zero, which is the mirror image of #343's error
 * — there, an unfiltered sum named "spend" refused a delegation over $48.76 of engine turns that
 * ran on a Claude subscription, money nobody was ever charged. Both failures come from one cause:
 * a number whose NAME claims something its SQL does not establish.
 *
 *   An aggregate that GATES or PAYS must filter to `payer`.
 *   An aggregate that DISPLAYS may sum everything — but then it must say VALUE, not spend.
 *
 * ── What this module enforces
 *
 * Every SQL statement in `workers/api/src` that sums `cost_micros` must either take a position on
 * the payer (a `payer` predicate, or the shared `CHARGED_SQL`), or alias the sum to a name
 * containing `value`. Anything else — `AS n`, `AS cost_micros`, `AS spend_30d_micros` — is a
 * violation, because a reader downstream cannot tell what they are holding, and the person who
 * writes the next consumer will assume it is a bill. That assumption is the whole incident.
 *
 * Positive naming rather than a blacklist of money words on purpose: a blacklist is satisfied by
 * calling the number `n`, which is how `getOverviewStats` shipped an unfiltered sum read into a
 * field called `spend30dMicros`. Requiring the word at the point the number is CREATED means the
 * author has to decide there, in SQL, which of the two questions they are answering.
 *
 * ── The lexer position, which is a new one here
 *
 * Three scanners in this repo already needed different answers to "which bytes count":
 * `source-guard.ts` blanks comments AND string literals, because its subject is code;
 * `prompt-claims.ts` inverts that, because its subject is text; `sql.ts` (#327) needed a third —
 * keep literals AND their interpolations, because its subject is the boundary between them.
 *
 * This needs a fourth: keep the CONTENTS of every string literal of all three kinds, and nothing
 * else. SQL here is written as a template literal (`usage.ts`), a double-quoted string
 * (`admin.ts:452`), and inside a `.prepare()` argument that spans lines — a scanner that only read
 * templates would have missed the one that actually shipped the bug. Comments are blanked first,
 * for the reason the fifth scanner in a row has now hit: every file explaining this correction
 * quotes the wording it retired, so matching raw source makes the explanation a violation and the
 * only way to pass is to delete the reasoning.
 */

import { CHARGED_SQL } from "./usage-payer.js";

/** One SQL select-item that sums `cost_micros`, with the verdict on it. */
export interface MoneyAggregate {
	/** 1-based line of the string literal the statement is written in. */
	line: number;
	/** The select-item as written, whitespace-collapsed. */
	item: string;
	/** The item's trailing `AS <alias>`, if it has one. */
	alias: string | null;
	/** Does it take a position on the payer — a predicate, or {@link CHARGED_SQL}? */
	filtered: boolean;
	/** Does the alias declare the number to be notional value rather than a charge? */
	declaresValue: boolean;
}

/** A money aggregate that is neither filtered nor named as value. */
export interface MoneyClaimViolation extends MoneyAggregate {
	why: string;
}

/** Blank every comment, preserving byte offsets so line numbers stay true. */
function withoutComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, " ");
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + blank(m.slice(p1.length)));
}

interface Literal {
	text: string;
	start: number;
}

/**
 * The contents of every string literal — template, single- and double-quoted.
 *
 * Template interpolations are kept as written (`${CHARGED_SQL}` stays visible), because the
 * predicate this guard looks for reaches the SQL that way in every filtered call site.
 */
export function stringLiterals(source: string): Literal[] {
	const out: Literal[] = [];
	let i = 0;
	while (i < source.length) {
		const c = source[i];
		if (c === '"' || c === "'" || c === "`") {
			const start = i + 1;
			let j = start;
			let depth = 0;
			while (j < source.length) {
				const d = source[j];
				if (d === "\\") {
					j += 2;
					continue;
				}
				if (c === "`" && d === "$" && source[j + 1] === "{") {
					depth++;
					j += 2;
					continue;
				}
				if (c === "`" && depth > 0 && d === "}") {
					depth--;
					j++;
					continue;
				}
				if (d === c && depth === 0) break;
				// An unterminated ordinary quote is a syntax error, not something to run away from.
				if (c !== "`" && d === "\n") break;
				j++;
			}
			out.push({ text: source.slice(start, j), start });
			i = j + 1;
			continue;
		}
		i++;
	}
	return out;
}

const SUMS_COST = /\bSUM\s*\(/i;
const MENTIONS_COST = /\bcost_micros\b/;
const PAYER_POSITION = /\bpayer\b|CHARGED_SQL/;

/** Split a select list on commas that are not inside parentheses, keeping each item's offset. */
function topLevelItems(list: string, base: number): Array<{ text: string; index: number }> {
	const out: Array<{ text: string; index: number }> = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < list.length; i++) {
		const c = list[i];
		if (c === "(") depth++;
		else if (c === ")") depth--;
		else if (c === "," && depth === 0) {
			out.push({ text: list.slice(start, i), index: base + start });
			start = i + 1;
		}
	}
	if (list.slice(start).trim()) out.push({ text: list.slice(start), index: base + start });
	return out;
}

/** The select list of the outermost SELECT (with its offset), and everything from its FROM on. */
function splitSelect(sql: string): { list: string; listAt: number; tail: string } | null {
	const m = /\bSELECT\b/i.exec(sql);
	if (!m) return null;
	const listAt = m.index + m[0].length;
	let depth = 0;
	for (let i = listAt; i < sql.length; i++) {
		const c = sql[i];
		if (c === "(") depth++;
		else if (c === ")") depth--;
		else if (depth === 0 && /\s/.test(c)) {
			const rest = sql.slice(i);
			if (/^\s+FROM\b/i.test(rest)) return { list: sql.slice(listAt, i), listAt, tail: rest };
		}
	}
	return null;
}

const collapse = (s: string) => s.trim().replace(/\s+/g, " ");

/**
 * Every select-item in `source` that sums `cost_micros`, judged.
 *
 * Nested-subquery items (`(SELECT SUM(...) FROM ai_usage WHERE …) AS x`, the shape `admin.ts`'s
 * per-user rollup uses) are judged on THEIR OWN text: a sibling column that filters on payer says
 * nothing about this one, and reading the whole statement would let an unfiltered sum ride on its
 * neighbour's WHERE clause.
 */
export function findMoneyAggregates(source: string): MoneyAggregate[] {
	const src = withoutComments(source);
	const lineOf = (idx: number) => src.slice(0, idx).split("\n").length;
	const out: MoneyAggregate[] = [];
	for (const lit of stringLiterals(src)) {
		if (!MENTIONS_COST.test(lit.text) || !SUMS_COST.test(lit.text)) continue;
		const parts = splitSelect(lit.text);
		if (!parts) continue;
		for (const item of topLevelItems(parts.list, parts.listAt)) {
			if (!SUMS_COST.test(item.text) || !MENTIONS_COST.test(item.text)) continue;
			const selfContained = /\bSELECT\b/i.test(item.text);
			const alias = /\bAS\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(collapse(item.text))?.[1] ?? null;
			out.push({
				line: lineOf(lit.start + item.index + Math.max(0, item.text.search(/\bSUM\s*\(/i))),
				item: collapse(item.text),
				alias,
				filtered: PAYER_POSITION.test(item.text) || (!selfContained && PAYER_POSITION.test(parts.tail)),
				declaresValue: !!alias && /value/i.test(alias) && !/spend|bill|charge/i.test(alias),
			});
		}
	}
	return out;
}

/** The aggregates that break the rule, with the sentence to act on. */
export function findMoneyClaimViolations(source: string): MoneyClaimViolation[] {
	return findMoneyAggregates(source)
		.filter((a) => !a.filtered && !a.declaresValue)
		.map((a) => ({
			...a,
			why: a.alias
				? `sums cost_micros with no payer predicate and calls it "${a.alias}" — either filter it (${CHARGED_SQL}) or alias it as value`
				: `sums cost_micros with no payer predicate and no alias saying what it is — either filter it (${CHARGED_SQL}) or alias it as value`,
		}));
}
