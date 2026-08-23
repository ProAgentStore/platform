/**
 * e2e-blocks.mjs — the two hand-rolled readers behind `check-e2e-projects.mjs` (#740):
 * where a `test()` block ends, and which viewport widths its body asks for.
 *
 * ADR 0002's follow-on note: a hand-rolled source scanner in this repo owes G1 plus its
 * own unit test naming what it does NOT handle. That is `e2e-blocks.test.mjs`. Both
 * functions here are deliberately narrow and deliberately loud — each returns a value the
 * caller can recognise as "I could not read this" (`null`, an empty array) rather than a
 * value that looks like a clean answer, because the guard above treats those as failures
 * instead of as passes.
 *
 * NOT handled by `blockEnd`, all of which yield `null`:
 *   • a block closed on a line that is not exactly `<indent>});` — e.g. `})` with no
 *     semicolon, a trailing comment, or a closer indented with spaces where the opener
 *     used tabs
 *   • a block whose opening line is the last line of the file
 * It relies on this repo being Biome-formatted with tabs, one level per nesting, so
 * nothing inside a block can sit at the opener's own indentation.
 *
 * NOT handled by `widthsIn`, all of which yield no width for that shape:
 *   • a width from a variable, a constant or a fixture (`test.use({ viewport })`)
 *   • a width computed at runtime
 *   • any loop variable not literally named `width`
 * Its two shapes are the two this suite uses: a literal `setViewportSize({ width: N`, and
 * `for (const width of [A, B])` feeding `setViewportSize({ width,`.
 */

/**
 * The 1-based line on which the `test()` block opened at `start` closes, or `null` when
 * the indentation convention does not hold.
 *
 * @param {string[]} src the file's lines
 * @param {number} start 1-based line of the `test(` call
 * @returns {number | null}
 */
export function blockEnd(src, start) {
	if (start < 1 || start > src.length) return null;
	const indent = (src[start - 1] ?? "").match(/^[\t ]*/)[0];
	const closer = `${indent}});`;
	for (let n = start; n < src.length; n++) {
		if (src[n] === closer) return n + 1;
	}
	return null;
}

/**
 * Every viewport width the body asks for as a readable literal.
 *
 * An empty array from a body that DOES call `setViewportSize` means "this reader cannot
 * see the width", not "there is no width" — the caller must distinguish those.
 *
 * @param {string} body
 * @returns {number[]}
 */
export function widthsIn(body) {
	const widths = [];
	for (const m of body.matchAll(/setViewportSize\(\s*\{\s*width:\s*(\d+)/g)) widths.push(Number(m[1]));
	for (const m of body.matchAll(/for\s*\(\s*const\s+width\s+of\s*\[([^\]]*)\]/g)) {
		for (const raw of m[1].split(",")) {
			const text = raw.trim();
			if (!text) continue;
			const v = Number(text);
			if (Number.isFinite(v)) widths.push(v);
		}
	}
	return widths;
}
