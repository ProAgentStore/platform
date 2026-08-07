/**
 * Two source-level a11y checks over JSX: whether a form control has an accessible NAME (#292),
 * and whether a click target can be REACHED by anything but a mouse (#324).
 *
 * Why source-scanning and not a rendered-DOM assertion: neither console has component-testing
 * infrastructure, and #282 decided deliberately not to add one — the convention is pure
 * functions in `lib/*.ts` with unit tests, not testing-library. A missing `aria-label` is a
 * property of the SOURCE, so it can be checked without rendering anything, and the check then
 * covers every control in the tree rather than the handful a test happens to mount.
 *
 * What counts as a name, in the order a browser resolves it:
 *   1. `aria-labelledby` — points at the text that names it.
 *   2. `aria-label` — the name, inline.
 *   3. `id` paired with a `<label htmlFor>` — checked as "has an id", because most of these are
 *      dynamic (`id={controlId}`) and the pairing cannot be resolved from source. That is a
 *      deliberate under-report: the guard's job is to catch controls with NOTHING, not to
 *      adjudicate every association.
 *   4. an ancestor `<label>` wrapping the control.
 *   5. `title` — a poor name, but a real one.
 *
 * `placeholder` is NOT a name. It disappears the moment you type, several screen readers skip
 * it, and it is the single most common reason a field "looks labelled" and is not. It is
 * reported separately as a weak name so a caller can decide.
 */

export type NameSource = "aria-labelledby" | "aria-label" | "id" | "wrapping-label" | "title" | "placeholder" | "none";

export interface ControlFinding {
	/** input | select | textarea */
	tag: string;
	/** 1-based line of the control's opening tag. */
	line: number;
	/** How it gets its accessible name, if at all. */
	via: NameSource;
	/** `type="..."` for inputs, when statically written. */
	type?: string;
	/** The opening tag, trimmed, for the failure message. */
	excerpt: string;
}

const CONTROLS = new Set(["input", "select", "textarea"]);

/**
 * Controls that never need an author-supplied name.
 *  hidden — not exposed to anyone.
 *  submit/reset/button — named by their `value`.
 *  radio/checkbox — nearly always wrapped in their own <label> with the choice text; the
 *    wrapping-label pass catches the ones that are, and a bare one still reports.
 */
const SELF_NAMING_INPUT_TYPES = new Set(["hidden", "submit", "reset", "button", "image"]);

/**
 * Blank out comments before scanning, keeping every newline so lines and indices still line up.
 *
 * Prose about markup is not markup. A comment saying "a `<tr onClick>` is reachable by mouse and
 * by nothing else" is a description of the bug being FIXED on the next line, and reporting it is
 * the same false-positive class this file's header is about.
 *
 * Only the three shapes this codebase actually writes are masked: a JSX brace-slash-star block,
 * and a slash-star or double-slash comment that STARTS a line. Nothing mid-line is touched,
 * because a double slash inside "https://…" and a slash-star inside a glob are both ordinary
 * string content, and blanking to end-of-line there would erase the attributes that name a
 * control.
 */
function maskComments(source: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, " ");
	return source
		.replace(/\{\/\*[\s\S]*?\*\/\}/g, blank)
		.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, blank)
		.replace(/^[ \t]*\/\/[^\n]*/gm, blank);
}

/**
 * Split JSX into tags, respecting that a `>` can appear inside a `{...}` expression or a
 * string attribute (`placeholder=">"`, `onChange={(e) => …}` — that arrow is the common case
 * and a naive `/<[^>]*>/` truncates the tag right before the attributes that name it).
 */
function scanTags(input: string): { name: string; body: string; index: number; selfClosing: boolean; closing: boolean }[] {
	const source = maskComments(input);
	const out: { name: string; body: string; index: number; selfClosing: boolean; closing: boolean }[] = [];
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

const attr = (body: string, name: string): string | null => {
	const m = new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)'|\\{)`).exec(body);
	if (!m) return null;
	return m[1] ?? m[2] ?? "{}";
};
const hasAttr = (body: string, name: string) => new RegExp(`\\s${name}[=\\s/>]`).test(body);

/** Every `<input>`/`<select>`/`<textarea>` in the source, with how it is named. */
export function findControls(source: string): ControlFinding[] {
	const tags = scanTags(source);
	const lineAt = (index: number) => source.slice(0, index).split("\n").length;
	const out: ControlFinding[] = [];
	// Depth of open <label> ancestors, so a control wrapped in one is treated as named.
	let labelDepth = 0;

	for (const tag of tags) {
		const lower = tag.name.toLowerCase();
		if (lower === "label") {
			if (tag.closing) labelDepth = Math.max(0, labelDepth - 1);
			else if (!tag.selfClosing) labelDepth++;
			continue;
		}
		if (tag.closing || !CONTROLS.has(lower)) continue;

		const type = attr(tag.body, "type") ?? undefined;
		if (lower === "input" && type && SELF_NAMING_INPUT_TYPES.has(type)) continue;

		const via: NameSource = hasAttr(tag.body, "aria-labelledby")
			? "aria-labelledby"
			: hasAttr(tag.body, "aria-label")
				? "aria-label"
				: hasAttr(tag.body, "id")
					? "id"
					: labelDepth > 0
						? "wrapping-label"
						: hasAttr(tag.body, "title")
							? "title"
							: hasAttr(tag.body, "placeholder")
								? "placeholder"
								: "none";

		out.push({ tag: lower, line: lineAt(tag.index), via, type, excerpt: tag.body.replace(/\s+/g, " ").slice(0, 120) });
	}
	return out;
}

/** Controls with no accessible name at all — the ones a screen reader announces as "edit text". */
export const findUnlabeledControls = (source: string): ControlFinding[] => findControls(source).filter((c) => c.via === "none");

/** Controls named only by a placeholder — a real but fragile name. */
export const findPlaceholderOnlyControls = (source: string): ControlFinding[] => findControls(source).filter((c) => c.via === "placeholder");

/**
 * Plain HTML elements that carry no interactive semantics. A `<div onClick>` is not a control:
 * it is not focusable, it is not in the tab order, Enter and Space do nothing to it, and it is
 * announced as nothing. A mouse is the only way in.
 *
 * Deliberately a DENY-list of bare containers rather than an allow-list of everything else,
 * because the false-positive cost is high: `<button>`, `<a href>`, `<summary>`, and any
 * capitalised component (which may render a button) must never be reported.
 */
const NON_INTERACTIVE = new Set(["div", "span", "p", "li", "ul", "ol", "section", "article", "header", "footer", "aside", "main", "nav", "td", "tr", "tbody", "table", "figure", "h1", "h2", "h3", "h4", "h5", "h6"]);

export interface ClickTargetFinding {
	tag: string;
	line: number;
	excerpt: string;
}

/**
 * Click handlers on elements only a mouse can operate.
 *
 * A `role` is accepted as the escape hatch, because declaring one is the deliberate act: the
 * remote-control surface in RunDetail is `role="application"` with its own key handling, and
 * that is a real decision someone made and wrote down. A bare `<div onClick>` is the accident.
 *
 * `onMouseEnter`/`onMouseOver` are NOT reported. Hover that only decorates (the admin's chart
 * highlight) has no keyboard equivalent to be missing — the underlying value is exposed by other
 * means, and demanding a focus handler for a hover tint invents work without adding access.
 */
export function findMouseOnlyClickTargets(source: string): ClickTargetFinding[] {
	return scanTags(source)
		.filter((t) => !t.closing && NON_INTERACTIVE.has(t.name) && hasAttr(t.body, "onClick") && !hasAttr(t.body, "role"))
		.map((t) => ({ tag: t.name, line: source.slice(0, t.index).split("\n").length, excerpt: t.body.replace(/\s+/g, " ").slice(0, 120) }));
}
