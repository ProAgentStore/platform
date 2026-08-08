/**
 * Pure logic for the two design guards that scan source (#367 dead colour tokens, #390 the
 * type scale). No filesystem, no process — the tree walking and the exit code live in
 * ../check-design-tokens.mjs so this half is testable.
 *
 * ── The defect ──
 *
 * Tailwind v4 has no error state. A utility whose token does not exist simply does not
 * generate a rule, so a dead text-colour class renders as INHERITED body text: the warning
 * you wrote is there, legible, and the same colour as everything around it. No console
 * warning, no build failure, nothing obviously wrong in a screenshot — which is why the
 * console shipped two of these in a status-tone lookup, two more on a "connector grants
 * needed" banner, and kept a whole vocabulary from somebody else's design system (generic
 * surface/base/border naming, pasted in) alive across five files.
 *
 * The worst case is not the invisible tint. It is a bare `border` whose colour class is
 * dead: v4 leaves `border-color` at `currentColor`, so the element gets a near-white 1px
 * outline on a black page. That is the exact symptom #368 fixed in DataTab, and this guard
 * found four more sections of the Behaviour tab wearing it.
 *
 * ── Why it is checkable at all ──
 *
 * Tailwind's DEFAULT palette has no bare hue names: `red-500` exists, `red` does not. So a
 * bare hue utility is valid ONLY if `@theme` declares that token, and the hue vocabulary
 * is a closed list of 22 words. That makes rule 1 exact — no allowlist and no judgement.
 *
 * Rule 2 (custom token names) needs a keyword list, so it is scoped to the prefixes that
 * take a colour and essentially nothing else. `text-`, `from-`, `via-`, `to-`, `shadow-`
 * and `decoration-` are excluded from it: they collide with the font-size scale, with
 * gradient stop positions, and with ordinary hyphenated English. Those prefixes are still
 * covered by rule 1, which is where their real defects were.
 *
 * NEVER write a dead utility verbatim in a comment. Tailwind v4's source scan reads
 * comments and strings, so quoting one while explaining it is how #368's broken rules got
 * regenerated into the built stylesheet from its own postmortem.
 */

/** Tailwind's default palette. Every one of these exists ONLY with a numeric shade. */
export const TAILWIND_HUES = [
	"slate",
	"gray",
	"zinc",
	"neutral",
	"stone",
	"red",
	"orange",
	"amber",
	"yellow",
	"lime",
	"green",
	"emerald",
	"teal",
	"cyan",
	"sky",
	"blue",
	"indigo",
	"violet",
	"purple",
	"fuchsia",
	"pink",
	"rose",
];

/** Colour keywords that need no token and are always valid. */
const UNIVERSAL = new Set(["white", "black", "transparent", "current", "inherit"]);

/** Every prefix that can take a colour — the surface rule 1 checks. */
const HUE_PREFIXES = "bg|text|border|ring|fill|stroke|from|via|to|divide|caret|accent|outline|decoration|shadow";

/** The subset that takes a colour and (almost) nothing else — the surface rule 2 checks. */
const TOKEN_PREFIXES = "bg|border|ring|fill|stroke|divide|caret|accent|outline";

/**
 * The non-colour values those prefixes also accept. Maintaining this list is the price of
 * rule 2; the alternative is not checking custom token names at all, which is how a
 * foreign vocabulary survived in five files. A legitimate Tailwind keyword that trips the
 * guard is a one-line fix here, and the failure message says so.
 */
const NON_COLOR_VALUES = new Set([
	// background-*: size, position, repeat, attachment, image
	"none", "cover", "contain", "auto", "center", "top", "bottom", "left", "right",
	"fixed", "local", "scroll", "repeat", "no-repeat", "repeat-x", "repeat-y",
	"repeat-round", "repeat-space",
	// border-collapse, and the shared border/outline/divide style keywords
	"collapse", "separate", "solid", "dashed", "dotted", "double", "hidden", "wavy",
	"reverse",
	// ring / outline
	"inset",
]);

/** Multi-word non-colour namespaces, matched on their first segment. */
const NON_COLOR_NAMESPACES = new Set([
	"clip", // bg-clip-text
	"origin", // bg-origin-border
	"blend", // bg-blend-multiply
	"gradient", // bg-gradient-to-br
	"linear", // bg-linear-to-r
	"radial",
	"conic",
	"offset", // ring-offset-2, outline-offset-2
	"spacing", // border-spacing-2
]);

/**
 * A side or axis segment carries no colour: `border-t-line`, `divide-y-2`. Stripped before
 * the rest is judged; standing alone (`border-t`, `divide-y`) it is a width utility.
 */
const SIDE_SEGMENTS = new Set(["t", "b", "l", "r", "x", "y", "s", "e"]);

/**
 * Blank out comments, preserving line count and column positions.
 *
 * A comment is prose, not a class list, and this tree's prose is full of hyphenated
 * phrases that look exactly like utilities to a regex — a lazy fill-in fallback, an
 * accent-italic state, a caret-from-point API. Every one of those would be a false
 * positive, and a guard that cries wolf gets suppressed rather than fixed.
 *
 * `//` is honoured only when it is not preceded by a colon, so the `//` in an https URL
 * inside a string does not swallow the rest of a line (and with it any real class list
 * sitting after it).
 */
export function stripComments(source) {
	const blanked = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
	return blanked
		.split("\n")
		.map((line) => {
			const at = line.search(/(?<!:)\/\//);
			return at === -1 ? line : line.slice(0, at);
		})
		.join("\n");
}

/**
 * The `--color-*` tokens an `@theme` block declares, as bare utility names.
 * `--color-panel-hover` → `panel-hover`, i.e. exactly what `bg-panel-hover` needs.
 */
export function parseThemeColorTokens(css) {
	const block = css.match(/@theme\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
	const tokens = new Set();
	for (const line of block.split("\n")) {
		const m = line.match(/^\s*--color-([\w-]+):/);
		if (m) tokens.add(m[1]);
	}
	return tokens;
}

/** Does this value resolve to a real colour, given what `@theme` declares? */
function resolvesToAColour(value, declared) {
	if (declared.has(value)) return true;
	if (UNIVERSAL.has(value)) return true;
	// A default-palette shade: red-500, amber-950.
	return new RegExp(`^(?:${TAILWIND_HUES.join("|")})-\\d{2,3}$`).test(value);
}

/**
 * Every colour utility in `source` naming a token nothing declares.
 *
 * Returns `{ utility, line }` per hit, lines numbered from 1 so the caller can print a
 * location a human can jump to. A utility repeated on one line is reported once — a class
 * list naming the same dead token three times is one mistake, not three.
 */
export function findDeadColorUtilities(source, declared) {
	const hueRe = new RegExp(`\\b(?:${HUE_PREFIXES})-(?:${TAILWIND_HUES.join("|")})(?:\\/\\d+)?\\b(?!-)`, "g");
	const tokenRe = new RegExp(`\\b(?:${TOKEN_PREFIXES})-[a-z][a-z0-9-]*(?:\\/\\d+)?\\b`, "g");
	const found = [];

	stripComments(source)
		.split("\n")
		.forEach((text, i) => {
			const seen = new Set();
			const report = (utility) => {
				if (seen.has(utility)) return;
				seen.add(utility);
				found.push({ utility, line: i + 1 });
			};

			for (const m of text.matchAll(hueRe)) {
				const utility = m[0].replace(/\/\d+$/, "");
				const hue = utility.slice(utility.indexOf("-") + 1);
				if (!declared.has(hue)) report(utility);
			}

			for (const m of text.matchAll(tokenRe)) {
				const utility = m[0].replace(/\/\d+$/, "");
				let value = utility.slice(utility.indexOf("-") + 1);
				const [head, ...rest] = value.split("-");
				if (SIDE_SEGMENTS.has(head)) {
					if (!rest.length) continue; // border-t, divide-y — a width, not a colour
					value = rest.join("-");
				}
				if (/^\d/.test(value)) continue; // border-b-2, divide-y-0
				if (NON_COLOR_VALUES.has(value) || NON_COLOR_NAMESPACES.has(value.split("-")[0])) continue;
				if (resolvesToAColour(value, declared)) continue;
				if (TAILWIND_HUES.includes(value)) continue; // rule 1's finding; don't double-report
				report(utility);
			}
		});

	return found;
}

/**
 * ── The retired pigment names (#367) ──
 *
 * The status tokens were renamed from pigment to intent, so the old names are now undeclared
 * and rule 1 above already catches every use of one. What it cannot do is say what to write
 * instead: its message is "names a token nothing declares", which is true and unhelpful for a
 * name that was valid last week and is spelled out in a hundred places on other branches.
 *
 * This map is consulted only when formatting a failure. It is not a rule of its own — a second
 * rule matching the same strings would report each one twice — and it exists because a rename
 * on a repo where several branches are open is a message-quality problem before it is a
 * detection problem. The keys are bare token names as rule 1 reports them.
 */
export const RETIRED_COLOR_TOKENS = {
	red: "danger",
	green: "success",
	yellow: "warning",
	blue: "info",
};

/**
 * The intent that replaces a retired pigment name in `utility`, or null.
 *
 * Takes the whole utility so the suggestion is a whole utility too: a reader should be able to
 * paste the answer rather than assemble it.
 */
export function retiredTokenAdvice(utility) {
	const value = utility.slice(utility.indexOf("-") + 1);
	const intent = RETIRED_COLOR_TOKENS[value];
	if (!intent) return null;
	const prefix = utility.slice(0, utility.indexOf("-"));
	return `${prefix}-${intent}`;
}

/**
 * Every status token the app is entitled to name, with the two pairings each must declare.
 *
 * This is a closed list checked against `@theme` — the opposite direction from every other rule
 * here, and deliberately so. `text-` is excluded from rule 2 (it collides with the font-size
 * scale), so a dead `text-<token>` is invisible unless the token is named after a Tailwind hue.
 * Before #367 the status tokens were, by accident; naming them for intent gave that accident up.
 *
 * Widening rule 2 to cover `text-` was measured and rejected: across all three trees it fires on
 * `text-like` inside an English sentence in a string literal, and on an element id whose tail
 * reads as a utility. A guard with two false positives on the day it lands teaches suppression
 * (#454). So the hole is closed at the declaration instead: if `--color-danger` and its pairings
 * are guaranteed to exist, `text-danger` cannot go silent, and 415 call sites need no scanning.
 */
export const REQUIRED_STATUS_TOKENS = ["success", "danger", "warning", "info"];
const REQUIRED_PAIRINGS = ["soft", "line"];

/** Every status token or pairing a `@theme` block is missing. Empty means the palette is whole. */
export function findMissingStatusTokens(css) {
	const declared = parseThemeColorTokens(css);
	const missing = [];
	for (const intent of REQUIRED_STATUS_TOKENS) {
		if (!declared.has(intent)) missing.push(intent);
		for (const pairing of REQUIRED_PAIRINGS) {
			if (!declared.has(`${intent}-${pairing}`)) missing.push(`${intent}-${pairing}`);
		}
	}
	return missing;
}

/**
 * ── The pairings (#367) ──
 *
 * Every status token declares a tinted background (`-soft`) and a tinted border (`-line`), so
 * an opacity modifier on one is a call site choosing an alpha the design system already chose.
 * That is how the tree came to hold three different alphas for one red tint and five for one
 * yellow border: the modifier form works, so nothing ever objected.
 *
 * Scoped deliberately to the four status intents. The accent's heavier alphas are solid
 * surfaces rather than tints and are a different decision, and `--color-muted-soft` is already
 * taken by a *text* colour, so a neutral chip's tint has no pairing to point at — widening this
 * to every token would fire on both and teach people to ignore it (#454's lesson: a scanner
 * cannot see the intent of a class it did not write).
 */
const STATUS_INTENTS = "success|danger|warning|info";
const STATUS_OPACITY = new RegExp(`\\b(bg|border|ring|divide|outline|text|fill|stroke)-(?:${STATUS_INTENTS})\\/\\d+\\b`, "g");

/** The pairing token a modifier should have named: a background wants -soft, an edge wants -line. */
export function pairingFor(utility) {
	const prefix = utility.slice(0, utility.indexOf("-"));
	const token = utility.slice(utility.indexOf("-") + 1).replace(/\/\d+$/, "");
	if (prefix === "bg") return `bg-${token}-soft`;
	if (prefix === "border" || prefix === "ring" || prefix === "divide" || prefix === "outline") return `${prefix}-${token}-line`;
	return `${prefix}-${token}`; // a translucent foreground is an alpha on TEXT — drop it
}

/** Every status colour written with an opacity modifier instead of its pairing token. */
export function findStatusOpacityModifiers(source) {
	const found = [];
	stripComments(source)
		.split("\n")
		.forEach((text, i) => {
			const seen = new Set();
			for (const m of text.matchAll(STATUS_OPACITY)) {
				if (seen.has(m[0])) continue;
				seen.add(m[0]);
				found.push({ utility: m[0], line: i + 1 });
			}
		});
	return found;
}

/**
 * ── The type scale (#390) ──
 *
 * The same defect class as above with the opposite symptom: an arbitrary font size does not
 * fail, it works. `text-[0.7rem]` compiles perfectly, which is why 190 of them accumulated
 * across 17 values, nine inside a 2px band, in an app whose design system says in as many
 * words that there are no custom font-size values. Nothing could have caught it, because
 * there was no scale to be off — every step Tailwind ships stops at 12px and the console's
 * dense telemetry wanted one below that.
 *
 * `@theme` now declares that step, so the arbitrary form has somewhere to go and this can be
 * a GATE at zero rather than a ratchet. Which is the point of the ordering the ticket asked
 * for: linting first would have relocated the problem into 190 blocked edits and taught
 * nothing.
 */

/** `text-[0.7rem]`, `text-[10px]`, `text-[1.1em]`, `text-[14pt]` — a font size written as a value. */
const ARBITRARY_FONT_SIZE = /\btext-\[\s*[\d.]+\s*(?:rem|px|em|pt|ch|ex|vw|vh|%)\s*\]/g;

/**
 * Every bracketed font size in `source`, as `{ utility, line }`.
 *
 * Deliberately only LENGTH-valued brackets: `text-[#fff]`, `text-[color:var(--x)]` and
 * `text-[length:var(--x)]` are a colour and a variable, not a step off the scale, and folding
 * them in would make the failure message wrong for them. Comments are blanked first for the
 * same reason as the colour rule — and it matters more here, because the honest way to write
 * about this defect in a comment is to quote it.
 */
export function findArbitraryFontSizes(source) {
	const found = [];
	stripComments(source)
		.split("\n")
		.forEach((text, i) => {
			const seen = new Set();
			for (const m of text.matchAll(ARBITRARY_FONT_SIZE)) {
				const utility = m[0].replace(/\s+/g, "");
				if (seen.has(utility)) continue;
				seen.add(utility);
				found.push({ utility, line: i + 1 });
			}
		});
	return found;
}

/**
 * The type steps an `@theme` block declares, as bare utility names: `--text-2xs` → `2xs`.
 *
 * The `--text-*--line-height` companions are NOT steps and are filtered out. A step declared
 * without one emits `line-height: var(…)` resolving to nothing, so the guard that consumes
 * this asserts both halves are present — the silent-nothing failure §1 describes for colour,
 * one property over.
 */
export function parseThemeTypeSteps(css) {
	const block = css.match(/@theme\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
	const steps = new Set();
	const lineHeights = new Set();
	for (const line of block.split("\n")) {
		const m = line.match(/^\s*--text-([\w-]+):/);
		if (!m) continue;
		if (m[1].endsWith("--line-height")) lineHeights.add(m[1].slice(0, -"--line-height".length));
		else steps.add(m[1]);
	}
	return { steps, lineHeights };
}
