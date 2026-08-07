/**
 * A `<button>` that hand-authors its own shape (#366).
 *
 * The 47 button shapes this ticket counted did not arrive as a decision. They accumulated,
 * one copy-paste at a time, because nothing failed when a fifteenth appeared — and the same
 * is true after a sweep unless something starts failing. #367 is the evidence: its guard
 * caught five dead colour utilities that landed on main from a different author WHILE the
 * sweep that motivated it was running. A one-time migration without a ratchet is a photograph
 * of a tree that keeps growing.
 *
 * ── What counts
 *
 * An opening `<button>` tag whose class attribute names BOTH a padding utility and a radius
 * utility. That pairing is the signature of a control drawing its own box, and it is what
 * `<Button>` replaces. A button with only `text-muted hover:text-ink` is a text link in
 * button's clothing — real, common, and not this defect.
 *
 * Responsive and state prefixes count: `sm:px-4` and `hover:rounded-lg` are the same decision
 * made at a breakpoint. `p-1.5` counts as padding, which is how the icon buttons are caught.
 *
 * ── What it deliberately does NOT cover, so nobody reads the number as "all of it"
 *
 *  - `<a>` and `<Link>` styled as buttons. Including them would fold the card-shaped links in
 *    `Browse.tsx` into a count whose failure message says "use <Button>", and a guard that
 *    reports the wrong fix gets suppressed. It also means the ratchet is EVADABLE: swapping a
 *    `<button>` for a `<Link>` lowers the count without fixing anything. Said out loud rather
 *    than papered over.
 *  - Cards and badges. `<div>` is the wrong unit to scan — the console has thousands, most of
 *    them layout, and the padding+radius pair does not distinguish a card from a code block or
 *    a banner.
 *  - Whether the variant chosen is the RIGHT one. That is taste, and DESIGN-SYSTEM.md §5 says
 *    a lint that pretends to check taste only teaches people to suppress it.
 */

import { type JsxTag, lineOf, scanTags } from "./jsx-tags";

export interface ControlShapeFinding {
	/** 1-based line of the opening tag. */
	line: number;
	/** The padding and radius utilities found, for a message that says what to replace. */
	shape: string[];
	/** The opening tag, trimmed. */
	excerpt: string;
}

/** `p-3`, `px-2.5`, `sm:py-4`, `p-[3px]` — any padding, at any breakpoint. */
const PADDING = /(?:^|[\s"'`{])((?:[a-z-]+:)*p[xytrbles]?-\[?[\w.[\]%]+)/g;
/** `rounded`, `rounded-lg`, `sm:rounded-xl`, `rounded-t-lg`. */
const RADIUS = /(?:^|[\s"'`{])((?:[a-z-]+:)*rounded(?:-[a-z0-9]+)*)\b/g;

/**
 * Everything the tag says about classes: `className="…"`, `` className={`…`} `` and the
 * ternaries inside it. Taken as raw text rather than parsed, because a shape written in only
 * one arm of a conditional is still a shape somebody wrote by hand.
 */
function classText(tag: JsxTag): string {
	const eq = tag.body.indexOf("className");
	return eq === -1 ? "" : tag.body.slice(eq);
}

const matches = (text: string, re: RegExp): string[] => [...text.matchAll(new RegExp(re.source, "g"))].map((m) => m[1]);

/** Every `<button>` in the source that draws its own box. */
export function findHandAuthoredControls(source: string): ControlShapeFinding[] {
	const out: ControlShapeFinding[] = [];
	for (const tag of scanTags(source)) {
		if (tag.closing || tag.name !== "button") continue;
		const text = classText(tag);
		const padding = matches(text, PADDING);
		const radius = matches(text, RADIUS);
		if (!padding.length || !radius.length) continue;
		out.push({
			line: lineOf(source, tag.index),
			shape: [...new Set([...padding, ...radius])],
			excerpt: tag.body.replace(/\s+/g, " ").slice(0, 120),
		});
	}
	return out;
}
