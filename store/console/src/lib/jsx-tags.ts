/**
 * The JSX tokenizer both source-scanning guards share.
 *
 * Two checks now read markup out of `.tsx` source without rendering it: `control-labels.ts`
 * (does a control have an accessible name, can a click target be reached by a keyboard) and
 * `control-shapes.ts` (does a button hand-author its own padding and radius). They need the
 * same thing — the opening tags, with their attributes intact — and every subtlety below was
 * learned by getting it wrong once:
 *
 *   - a `>` inside `onChange={(e) => …}` is not the end of the tag, and a naive `/<[^>]*>/`
 *     truncates it right before the attributes both guards are looking for;
 *   - a `>` inside `placeholder=">"` is not either;
 *   - `//` inside `"https://…"` does not start a comment, and blanking to end-of-line there
 *     erases a real attribute list;
 *   - a backtick opens a string too, and an apostrophe inside one is CONTENT — #536.
 *
 * A second copy of that would be a second chance to get one of them wrong, so there is one.
 *
 * ── #536, and why this file carries a pointer to ADR 0002
 *
 * Until 2026-08-13 the quote tracker knew `"` and `'` and not `` ` ``, so one apostrophe inside
 * a template literal — `` setError(`Couldn't remember ${key}`) `` — opened a quote state that the
 * closing backtick never cleared, and the scan ran on until it hit some later `>`. The result was
 * not an error. It was a SMALLER measurement: 33 tags across two of 107 files never reached
 * either guard, one `<DangerAction>` in the admin swallowed 3491 characters over 79 lines, and
 * `control-shapes.test.ts` pinned the console at 42 hand-authored button shapes while the tree
 * held 43. The guards stayed green the whole time, which is the failure mode
 * `docs/adr/0002-a-guard-states-what-it-measured.md` exists to make routine to look for: an
 * offender list is only as true as the input set nobody sized.
 *
 * That is also why `scanTags` now THROWS on a tag whose `>` it never finds (G3) instead of the
 * `continue` that used to be there. That single `continue` is what converted a lexer bug into an
 * undercount rather than a crash — had it been loud, this would have failed on the day the first
 * apostrophe landed rather than months later, from a different lane.
 *
 * ── What this lexer does NOT handle, stated because ADR 0002 requires it of any hand-rolled
 *    source scanner that has not been consolidated
 *
 * It only lexes from `<name` to the matching `>`; it does not know whether that `<` was itself
 * inside a string or a mid-line comment (`maskComments` blanks only comments that START a line).
 * A `<div>` written inside a string literal is therefore counted as a tag — which is what the
 * guards' own fixtures rely on, and harmless on real component source. It does not implement
 * regex literals, JSX text, or entity escapes, because none of those can occur between `<name`
 * and its `>`. `jsx-tags.test.ts` is the unit test ADR 0002 asks for; the eight-strippers
 * consolidation named there is a separate piece of work.
 */

export interface JsxTag {
	/** Tag name as written — `button`, `div`, `Link`. Case is preserved: a capitalised name is a component. */
	name: string;
	/** The whole opening tag, `<` through `>`, comments already blanked. */
	body: string;
	/** Index of the `<` in the ORIGINAL source, so a caller can resolve a line number. */
	index: number;
	selfClosing: boolean;
	closing: boolean;
}

/**
 * Blank out comments before scanning, keeping every newline so lines and indices still line up.
 *
 * Prose about markup is not markup. A comment saying "a `<tr onClick>` is reachable by mouse and
 * by nothing else" is a description of the bug being FIXED on the next line, and reporting it is
 * a false positive — and a guard that cries wolf gets suppressed rather than fixed.
 *
 * Only the three shapes this codebase actually writes are masked: a JSX brace-slash-star block,
 * and a slash-star or double-slash comment that STARTS a line. Nothing mid-line is touched,
 * because a double slash inside "https://…" and a slash-star inside a glob are both ordinary
 * string content.
 */
export function maskComments(source: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, " ");
	return source
		.replace(/\{\/\*[\s\S]*?\*\/\}/g, blank)
		.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, blank)
		.replace(/^[ \t]*\/\/[^\n]*/gm, blank);
}

/**
 * Find the `>` that closes the tag opened at `from`, or -1 if the source runs out first.
 *
 * A stack rather than a quote flag and a brace counter, because the three ways to nest inside a
 * tag interleave:
 *
 *   - `"` and `'` hold string content until the same character, honouring `\` escapes;
 *   - `` ` `` holds template content the same way, EXCEPT that `${` re-enters code;
 *   - `{` (a JSX expression container, or that `${`) is code again — where a quote, a backtick,
 *     a nested brace or a nested template may open in turn.
 *
 * The third case is the one #536 asked to be decided deliberately, and this is the decision:
 * **an interpolation is code, not string content.** Blanket-treating a backtick as an ordinary
 * delimiter would fix the reported apostrophe and still mis-pair a template nested inside an
 * interpolation — `` {`${x ? `a` : `b`}`} `` — and it would make a stray brace inside `${…}`
 * invisible to the depth count. Re-entering code is what `workers/api/src/lib/source-guard.ts`
 * does, and it is the only rule that composes to arbitrary depth.
 *
 * A `>` closes the tag only with the stack EMPTY, so `{(e) => …}`, `` {`a > b`} `` and
 * `{x > 1 ? a : b}` are all interior.
 */
function findTagEnd(source: string, from: number): number {
	/** Open contexts, innermost last: `"` `'` `` ` `` are strings, `{` is code. */
	const stack: string[] = [];
	for (let j = from; j < source.length; j++) {
		const c = source[j];
		const top = stack[stack.length - 1];
		if (top === '"' || top === "'" || top === "`") {
			if (c === "\\") j++;
			else if (c === top) stack.pop();
			else if (top === "`" && c === "$" && source[j + 1] === "{") {
				stack.push("{");
				j++;
			}
			continue;
		}
		if (c === '"' || c === "'" || c === "`") stack.push(c);
		else if (c === "{") stack.push("{");
		else if (c === "}") {
			// An unmatched `}` before any `{` is not this scanner's business to reject — the old
			// counter let depth go negative and carried on, and nothing in the trees relies on it.
			if (top === "{") stack.pop();
		} else if (c === ">" && stack.length === 0) return j;
	}
	return -1;
}

/**
 * Every opening (and closing) JSX tag in the source, with its attributes.
 *
 * @throws if a tag is opened and never closed. ADR 0002 G3: a scanner that cannot parse
 * something reports it, because skipping it turns a parser bug into a smaller measurement while
 * every consumer keeps printing a confident number.
 */
export function scanTags(input: string): JsxTag[] {
	const source = maskComments(input);
	const out: JsxTag[] = [];
	for (let i = 0; i < source.length; i++) {
		if (source[i] !== "<") continue;
		const nameMatch = /^<(\/?)([A-Za-z][A-Za-z0-9]*)/.exec(source.slice(i, i + 40));
		if (!nameMatch) continue;
		const j = findTagEnd(source, i + nameMatch[0].length);
		if (j === -1) {
			throw new Error(
				`jsx-tags: <${nameMatch[1]}${nameMatch[2]}> at line ${lineOf(source, i)} is never closed — the scan ran to the end of the file.\n` +
					`  near: ${source.slice(i, i + 80).replace(/\s+/g, " ")}\n` +
					"  This is the scanner losing an input, not a clean file (ADR 0002 G3). Every guard reading\n" +
					"  these tags would otherwise report a number over a set missing this tag and everything after it.",
			);
		}
		const body = source.slice(i, j + 1);
		out.push({ name: nameMatch[2], body, index: i, selfClosing: /\/>$/.test(body), closing: nameMatch[1] === "/" });
		i = j;
	}
	return out;
}

/** 1-based line of a character index, for a failure message that can be clicked. */
export const lineOf = (source: string, index: number): number => source.slice(0, index).split("\n").length;
