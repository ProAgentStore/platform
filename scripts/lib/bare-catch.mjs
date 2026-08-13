#!/usr/bin/env node
/**
 * bare-catch.mjs — locate `catch` clauses whose braces hold nothing at all.
 *
 * Pure and separately tested (`bare-catch.test.mjs`), for the reason `lib/design-tokens.mjs`
 * exists: the guards under `scripts/` are regex-shaped, and a regex-shaped guard nobody tests is
 * one edit away from silently passing. The two mistakes this can make are named in the header of
 * `check-bare-catch.mjs`, and both have a test.
 *
 * **Read `docs/adr/0002-a-guard-states-what-it-measured.md` before changing the scan.** This is a
 * hand-rolled source stripper — one of eight in this repo, at four fidelities — and it is the
 * shape that has already failed twice by measuring a subset while printing a confident number.
 * What THIS one does not handle is stated where it happens: `${…}` inside a template is blanked
 * along with the rest of the span, so a `catch {}` written inside an interpolation would be
 * invisible here. Measured rather than assumed — re-running this scan with
 * `workers/api/src/lib/source-guard.ts`'s stripper (which keeps interpolations as code)
 * substituted in gives the identical result over 628 source files across the eight pinned trees
 * plus `workers/host/src`, `e2e` and `scripts`: zero hits either way, zero disagreements. So the
 * gap is real and currently costs nothing, which is why the ADR does not order a consolidation.
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
		// NOT the same shape as the `close === -1` below, and worth saying so. `\bcatch\b` also
		// matches the METHOD — `p.catch((e) => …)` — where the parens are followed by `)` or `;`
		// rather than a block. Skipping those is the guard working, not the guard giving up.
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
		// ADR 0002 G3 — this used to be `continue`. A `catch {` whose brace never closes means the
		// stripper mis-lexed something above it (an unterminated template, a regex read as
		// division), and the file is no longer being measured from here on. Skipping it made that
		// a SMALLER count with no symptom, which is exactly how jsx-tags.ts hid 33 tags for months
		// (#536) — the identical `continue`, in the identical position, in a sibling scanner.
		if (close === -1) {
			const line = src.slice(0, m.index).split("\n").length;
			throw new Error(
				`bare-catch: the catch block at line ${line} is never closed — stripCommentsAndLiterals lost its place.\n` +
					"  Every catch after this point in the file is unmeasured. Fix the stripper; do not skip the\n" +
					"  clause (docs/adr/0002-a-guard-states-what-it-measured.md, G3).",
			);
		}
		// Judged on the ORIGINAL: a comment lives only there, because stripping blanked it.
		if (src.slice(open + 1, close).trim() === "") {
			hits.push(src.slice(0, m.index).split("\n").length);
		}
	}
	return hits;
}
