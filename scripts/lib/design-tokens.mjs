/**
 * Pure logic for the dead-colour-token guard (#367). No filesystem, no process — the tree
 * walking and the exit code live in ../check-design-tokens.mjs so this half is testable.
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
