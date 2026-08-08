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
 *  - Badges. A `<span>` with a tint is indistinguishable from a highlighted word.
 *  - Whether the variant chosen is the RIGHT one. That is taste, and DESIGN-SYSTEM.md §5 says
 *    a lint that pretends to check taste only teaches people to suppress it.
 *
 * Cards WERE on that list — `findHandAuthoredCards` below is what changed, and the note there
 * records what made the difference.
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

/**
 * A card-shaped container written by hand instead of as `<Card>` (#366).
 *
 * ── Why this is checkable when the first cut of the button guard said it was not
 *
 * That note said `<div>` is the wrong unit to scan: the console has thousands, padding+radius
 * does not tell a card from a code block, and a guard that fires on a code block is a guard
 * people learn to ignore. All true — of padding+radius. The signature that works asks for three
 * things at once, and it was found by measuring rather than by reasoning:
 *
 *   1. a CONTAINER tag, from a closed list. This is what removes the whole false-positive class
 *      the original note was worried about. Measured on the tree, dropping it pulls in a text
 *      `<input>` (this app's inputs are rounded and bordered too), a `<button>` (already counted
 *      by the guard above — double-reporting one element under two names) and a `<nav>` dropdown
 *      panel, which is card-SHAPED but cannot become a `<Card>`, so the failure message would be
 *      telling someone to do something impossible;
 *   2. `rounded-xl` specifically, which is this system's card radius. Controls use `rounded-lg`,
 *      so requiring the card radius separates the two populations with no judgement at all;
 *   3. a SURFACE — a panel/paper fill or the line border. A card is a surface; a padded rounded
 *      `<div>` with neither is a layout box.
 *
 * All three together report 58 elements in the console and every one of them is a card. The
 * cost of that precision is stated rather than hidden: cards written at `rounded-lg` are
 * invisible here, and widening to catch them would sweep in every control in the app. §5 of
 * DESIGN-SYSTEM.md counted 15 of those, so this covers roughly four fifths of the population
 * and knows which fifth it is missing.
 *
 * ── What it does not claim
 *
 * Nothing about padding. Most of these already spell the canonical geometry by hand, but a card
 * at `p-4` or `px-3 py-2.5` is counted the same way: the finding is "this box is drawn by hand",
 * not "this box is drawn wrongly". Which padding is right is exactly the taste question a lint
 * must not pretend to answer — the component is what makes it one decision.
 */
const CARD_CONTAINERS = new Set(["div", "section", "article", "aside", "header", "footer", "main", "li", "form"]);
/** This system's card radius. Controls are `rounded-lg`; see the note above. */
const CARD_RADIUS = /\brounded-xl\b/;
/** A card is a surface: a panel or paper fill, or the line border drawn around one. */
const CARD_SURFACE = /\bbg-panel\b|\bbg-paper\b|\bborder-line\b/;

export function findHandAuthoredCards(source: string): ControlShapeFinding[] {
	const out: ControlShapeFinding[] = [];
	for (const tag of scanTags(source)) {
		if (tag.closing || !CARD_CONTAINERS.has(tag.name)) continue;
		const text = classText(tag);
		if (!CARD_RADIUS.test(text) || !CARD_SURFACE.test(text)) continue;
		const padding = matches(text, PADDING);
		if (!padding.length) continue;
		out.push({
			line: lineOf(source, tag.index),
			shape: [...new Set([...padding, "rounded-xl"])],
			excerpt: tag.body.replace(/\s+/g, " ").slice(0, 120),
		});
	}
	return out;
}

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
