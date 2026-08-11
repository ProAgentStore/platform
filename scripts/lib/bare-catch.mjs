#!/usr/bin/env node
/**
 * bare-catch.mjs — locate `catch` clauses whose braces hold nothing at all.
 *
 * Pure and separately tested (`bare-catch.test.mjs`), for the reason `lib/design-tokens.mjs`
 * exists: the guards under `scripts/` are regex-shaped, and a regex-shaped guard nobody tests is
 * one edit away from silently passing. The two mistakes this can make are named in the header of
 * `check-bare-catch.mjs`, and both have a test.
 */

/**
 * Blank out comments, string bodies, template bodies and regex literals, preserving length and
 * newlines so offsets and line numbers still line up with the original.
 *
 * Length-preserving is the point: the caller locates a catch here and then reads the ORIGINAL at
 * the same offsets, which is what lets an annotated catch be told from an empty one.
 */
export function stripCommentsAndLiterals(src) {
	const out = src.split("");
	const blank = (from, to) => {
		for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
	};
	// A `/` opens a regex only where a VALUE may start; after an identifier or `)` it is division.
	const opensRegex = (prev) => prev === "" || "(,=:[!&|?{};+-*%~^<>".includes(prev);
	let prev = "";
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		const next = src[i + 1];
		if (c === "/" && next === "/") {
			let j = i;
			while (j < src.length && src[j] !== "\n") j++;
			blank(i, j);
			i = j;
			continue;
		}
		if (c === "/" && next === "*") {
			const end = src.indexOf("*/", i + 2);
			const j = end === -1 ? src.length : end + 2;
			blank(i, j);
			i = j;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			// Template literals may nest `${ … }` with more code in them; blanking the whole span is
			// safe for THIS guard because a catch clause cannot open inside one and stay open.
			let j = i + 1;
			while (j < src.length) {
				if (src[j] === "\\") {
					j += 2;
					continue;
				}
				if (src[j] === c) break;
				j++;
			}
			blank(i + 1, j);
			i = j + 1;
			prev = c;
			continue;
		}
		if (c === "/" && opensRegex(prev)) {
			let j = i + 1;
			let inClass = false;
			while (j < src.length && src[j] !== "\n") {
				if (src[j] === "\\") {
					j += 2;
					continue;
				}
				if (src[j] === "[") inClass = true;
				else if (src[j] === "]") inClass = false;
				else if (src[j] === "/" && !inClass) break;
				j++;
			}
			// A "regex" that ran to end-of-line was division after all. Leave it alone.
			if (j < src.length && src[j] === "/") {
				blank(i + 1, j);
				i = j + 1;
				prev = "/";
				continue;
			}
		}
		if (!/\s/.test(c)) prev = c;
		i++;
	}
	return out.join("");
}

/** Every `catch` clause whose braces hold nothing at all — not even a comment. */
export function bareCatches(src) {
	const code = stripCommentsAndLiterals(src);
	const hits = [];
	for (const m of code.matchAll(/\bcatch\b/g)) {
		let i = m.index + 5;
		while (i < code.length && /\s/.test(code[i])) i++;
		// The optional binding: `catch (e)`.
		if (code[i] === "(") {
			let depth = 0;
			for (; i < code.length; i++) {
				if (code[i] === "(") depth++;
				else if (code[i] === ")" && --depth === 0) {
					i++;
					break;
				}
			}
			while (i < code.length && /\s/.test(code[i])) i++;
		}
		if (code[i] !== "{") continue;
		const open = i;
		let depth = 0;
		let close = -1;
		for (let j = open; j < code.length; j++) {
			if (code[j] === "{") depth++;
			else if (code[j] === "}" && --depth === 0) {
				close = j;
				break;
			}
		}
		if (close === -1) continue;
		// Judged on the ORIGINAL: a comment lives only there, because stripping blanked it.
		if (src.slice(open + 1, close).trim() === "") {
			hits.push(src.slice(0, m.index).split("\n").length);
		}
	}
	return hits;
}
