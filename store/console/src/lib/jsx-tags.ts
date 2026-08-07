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
 *     erases a real attribute list.
 *
 * A second copy of that would be a second chance to get one of them wrong, so there is one.
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

/** Every opening (and closing) JSX tag in the source, with its attributes. */
export function scanTags(input: string): JsxTag[] {
	const source = maskComments(input);
	const out: JsxTag[] = [];
	for (let i = 0; i < source.length; i++) {
		if (source[i] !== "<") continue;
		const nameMatch = /^<(\/?)([A-Za-z][A-Za-z0-9]*)/.exec(source.slice(i, i + 40));
		if (!nameMatch) continue;
		let depth = 0;
		let quote = "";
		let j = i + nameMatch[0].length;
		for (; j < source.length; j++) {
			const c = source[j];
			if (quote) {
				if (c === quote) quote = "";
				continue;
			}
			if (c === '"' || c === "'") quote = c;
			else if (c === "{") depth++;
			else if (c === "}") depth--;
			else if (c === ">" && depth <= 0) break;
		}
		if (j >= source.length) continue;
		const body = source.slice(i, j + 1);
		out.push({ name: nameMatch[2], body, index: i, selfClosing: /\/>$/.test(body), closing: nameMatch[1] === "/" });
		i = j;
	}
	return out;
}

/** 1-based line of a character index, for a failure message that can be clicked. */
export const lineOf = (source: string, index: number): number => source.slice(0, index).split("\n").length;
