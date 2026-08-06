/**
 * Accessible-name detection for form controls, as a pure function over JSX source (#292).
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
 * Split JSX into tags, respecting that a `>` can appear inside a `{...}` expression or a
 * string attribute (`placeholder=">"`, `onChange={(e) => …}` — that arrow is the common case
 * and a naive `/<[^>]*>/` truncates the tag right before the attributes that name it).
 */
function scanTags(source: string): { name: string; body: string; index: number; selfClosing: boolean; closing: boolean }[] {
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
