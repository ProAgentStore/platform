import { describe, expect, it } from "vitest";
import { findArbitraryFontSizes, findDeadColorUtilities, findMissingStatusTokens, findStatusOpacityModifiers, pairingFor, parseThemeColorTokens, parseThemeTypeSteps, retiredTokenAdvice, stripComments } from "./design-tokens.mjs";

/**
 * A guard is only worth having if it catches the defect that shipped AND stays quiet on
 * the code around it. Both halves are asserted here: the cases below are the REAL ones
 * this found in the tree (#367) and the real near-misses that would have made it noise.
 *
 * The dead utilities under test are built by concatenation rather than written out, so
 * this file cannot regenerate them into the built stylesheet — Tailwind v4's source scan
 * reads comments and strings, which is how #368's broken rules came back from its own
 * postmortem.
 */

const THEME = `@import "tailwindcss";
@theme {
	--color-paper: #0a0a0a;
	--color-panel: #141414;
	--color-panel-hover: #1a1a1a;
	--color-ink: #fafafa;
	--color-muted: #a3a3a3;
	--color-accent: #7c3aed;
	--color-accent-soft: rgba(124, 58, 237, 0.15);
	--color-line: #303030;
	--color-success: #22c55e;
	--color-success-soft: rgba(34, 197, 94, 0.15);
	--color-danger: #ef4444;
	--color-danger-line: rgba(239, 68, 68, 0.4);
	--color-warning: #eab308;
	--font-body: "Manrope", system-ui, sans-serif;
}
`;

const declared = parseThemeColorTokens(THEME);

/** Build a class name without spelling it out, so Tailwind's scanner never sees one. */
const dead = (prefix, token) => `${prefix}-${token}`;

const utilities = (src) => findDeadColorUtilities(src, declared).map((h) => h.utility);

describe("parseThemeColorTokens", () => {
	it("reads the colour tokens as the names a utility would use", () => {
		expect(declared.has("panel-hover")).toBe(true);
		expect(declared.has("accent-soft")).toBe(true);
	});

	it("ignores non-colour tokens declared in the same block", () => {
		expect(declared.has("body")).toBe(false);
		expect([...declared].some((t) => t.startsWith("font"))).toBe(false);
	});

	it("returns nothing when there is no @theme block to read", () => {
		// The guard treats an empty parse as its own failure; it must not look like a clean tree.
		expect(parseThemeColorTokens("body { color: red; }").size).toBe(0);
	});
});

describe("the defects that actually shipped", () => {
	it("catches a bare hue the theme never declared", () => {
		// The status-tone lookup in LoopRunsSection: a "needs you" label that rendered as body text.
		const src = `const TONE = { needs_human: "${dead("text", "orange")}" };`;
		expect(utilities(src)).toEqual([dead("text", "orange")]);
	});

	it("catches the banner triple that left a currentColor border", () => {
		// AgentDetail's connector-grants notice: no tint, and a near-white 1px outline on black.
		const src = `<div className="${dead("border", "amber")}/30 ${dead("bg", "amber")}/10 ${dead("text", "amber")}" />`;
		expect(utilities(src).sort()).toEqual([dead("bg", "amber"), dead("border", "amber"), dead("text", "amber")]);
	});

	it("catches a foreign vocabulary's token names", () => {
		// Pasted in from another design system; none of these three words is a PAGS token.
		const src = `<input className="${dead("bg", "surface")}" /><div className="${dead("border", "border")} ${dead("bg", "base")}" />`;
		expect(utilities(src).sort()).toEqual([dead("bg", "base"), dead("bg", "surface"), dead("border", "border")]);
	});

	it("catches a token that looks like a declared one but is not", () => {
		expect(utilities(`<span className="${dead("bg", "panel-2")}" />`)).toEqual([dead("bg", "panel-2")]);
	});

	it("fires when a token is REMOVED from the theme, not only when a class is added", () => {
		// The exact shape of #367's rename: the pigment names were deleted from @theme, which
		// is what makes every remaining use of one a hit without needing a rule of its own.
		const shrunk = parseThemeColorTokens(THEME.replace("\t--color-warning: #eab308;\n", ""));
		expect(findDeadColorUtilities(`<i className="${dead("bg", "warning")}" />`, shrunk).map((h) => h.utility)).toEqual([dead("bg", "warning")]);
	});

	it("does NOT see a deleted token behind a text- prefix, which is why §5 asserts the tokens exist", () => {
		// The hole, asserted rather than described. `text-` is excluded from the custom-token
		// rule because it collides with the font-size scale, so before #367 a dead one was
		// caught only when the token happened to be named after a Tailwind hue. Renaming to
		// intent removed that accident, and the honest fix was NOT to widen this rule: measured
		// across all three trees, doing so fires on `text-like` inside an English sentence and
		// on an element id ending in a word that reads as a utility. Two false positives on day
		// one is how a guard gets suppressed (#454). checkStatusTokens closes it from the other
		// end — by asserting the token is declared, rather than hunting its absence at 415 sites.
		const shrunk = parseThemeColorTokens(THEME.replace("\t--color-warning: #eab308;\n", ""));
		expect(findDeadColorUtilities(`<b className="${dead("text", "warning")}" />`, shrunk)).toEqual([]);
	});

	it("reports the line, and reports a repeated token on one line once", () => {
		const src = `line one\n<div className="${dead("text", "orange")} hover:${dead("text", "orange")}" />`;
		expect(findDeadColorUtilities(src, declared)).toEqual([{ utility: dead("text", "orange"), line: 2 }]);
	});
});

describe("does not fire on correct code", () => {
	it("accepts declared tokens, including the multi-word ones and opacity modifiers", () => {
		const src = `<div className="bg-panel-hover border-line text-muted bg-accent-soft bg-muted/15 hover:text-success" />`;
		expect(utilities(src)).toEqual([]);
	});

	it("accepts the default palette's numbered shades, which do exist", () => {
		// Debt the raw-palette ratchet owns (designTokens.test.ts) — not this guard's business.
		expect(utilities(`<div className="text-purple-400 bg-amber-500/15 border-t-amber-600" />`)).toEqual([]);
	});

	it("accepts the universal colour keywords", () => {
		expect(utilities(`<div className="bg-white text-black border-transparent fill-current" />`)).toEqual([]);
	});

	it("accepts non-colour values of the same prefixes", () => {
		const src = `<div className="bg-cover bg-center bg-no-repeat bg-clip-text bg-gradient-to-br border-collapse border-dashed border-t border-b-2 divide-y ring-inset ring-offset-2 outline-none" />`;
		expect(utilities(src)).toEqual([]);
	});

	it("accepts the font-size scale, which shares the text- prefix", () => {
		expect(utilities(`<h3 className="text-base text-xs text-2xl text-center text-left" />`)).toEqual([]);
	});

	it("ignores hyphenated English in comments, which is what a class-name regex sees as a utility", () => {
		// Every one of these is real prose from this tree. A guard that flagged them would
		// be suppressed rather than fixed.
		const src = [
			"// a lazy fill-in fallback, an accent-italic state, the caret-from-point APIs",
			"/* the jump-to-bottom button, tap-to-talk, click-to-focus, text-extraction */",
			"{/* Chat · Tap-to-talk · Hands-free */}",
		].join("\n");
		expect(utilities(src)).toEqual([]);
	});
});

describe("stripComments", () => {
	it("keeps line numbers stable so a finding points at the right line", () => {
		const src = "a\n/* two\n   three */\nb";
		expect(stripComments(src).split("\n").length).toBe(4);
	});

	it("does not treat the // in a URL as a comment, which would hide the rest of the line", () => {
		const src = `<input placeholder="https://example.com/mcp" className="${dead("bg", "surface")}" />`;
		expect(utilities(src)).toEqual([dead("bg", "surface")]);
	});
});

/**
 * The type scale (#390). Same construction rule as above: every offending class is BUILT
 * rather than written, so this file cannot regenerate one into the built stylesheet.
 */
const sized = (value) => `text-[${value}]`;
const sizes = (src) => findArbitraryFontSizes(src).map((h) => h.utility);

describe("findArbitraryFontSizes", () => {
	it("catches the value that was on 120 elements across three trees", () => {
		const src = `<span className="${sized("0.7rem")} text-muted">{n}</span>`;
		expect(sizes(src)).toEqual([sized("0.7rem")]);
	});

	it("catches every unit a size can be written in", () => {
		// admin used px, the console used rem; nothing stops the next one being em or pt.
		const src = ["px", "rem", "em", "pt"].map((u) => sized(`10${u}`)).join(" ");
		expect(sizes(src)).toHaveLength(4);
	});

	it("reports each distinct value on a line once, because one class list is one mistake", () => {
		const src = `className={\`${sized("0.7rem")} x ${sized("0.7rem")} ${sized("0.65rem")}\`}`;
		expect(sizes(src)).toEqual([sized("0.7rem"), sized("0.65rem")]);
	});

	it("leaves a named step alone", () => {
		expect(sizes('className="text-2xs text-xs text-sm text-base text-lg"')).toEqual([]);
	});

	it("leaves a bracketed COLOUR alone — the failure message would be wrong for it", () => {
		expect(sizes('className="text-[#fafafa] text-[color:var(--brand)] text-[length:var(--x)]"')).toEqual([]);
	});

	it("ignores prose, which is the only honest way to write about this defect", () => {
		// A guard that fires on the comment explaining it gets suppressed rather than fixed.
		const src = `/* nine values inside a 2px band: ${sized("0.68rem")} against ${sized("0.7rem")} */`;
		expect(sizes(src)).toEqual([]);
	});

	it("reports the line so a human can jump to it", () => {
		const src = `a\nb\n<span className="${sized("0.55rem")}" />`;
		expect(findArbitraryFontSizes(src)).toEqual([{ utility: sized("0.55rem"), line: 3 }]);
	});
});

describe("parseThemeTypeSteps", () => {
	const css = `@theme {\n\t--color-ink: #fff;\n\t--text-2xs: 0.6875rem;\n\t--text-2xs--line-height: calc(1 / 0.6875);\n\t--font-body: "Manrope";\n}\n`;

	it("reads a step as the name a utility would use, not as the raw property", () => {
		expect([...parseThemeTypeSteps(css).steps]).toEqual(["2xs"]);
	});

	it("keeps the line-height companion out of the step list", () => {
		// Counted as a step it would look like a `text-2xs--line-height` utility nobody wrote,
		// and the paired-declaration check in check-design-tokens.mjs could never be satisfied.
		expect([...parseThemeTypeSteps(css).lineHeights]).toEqual(["2xs"]);
	});

	it("finds no steps in a block that declares none", () => {
		expect(parseThemeTypeSteps("@theme {\n\t--color-ink: #fff;\n}\n").steps.size).toBe(0);
	});
});

describe("retiredTokenAdvice (#367)", () => {
	/**
	 * Not a rule — a message. Rule 1 already fires on every one of these, because the pigment
	 * names were deleted from `@theme` rather than aliased. What this adds is the answer: the
	 * rename landed while several branches were open, so the guard's readers are mostly people
	 * who wrote valid code last week and want the one-word replacement, not an explanation.
	 */
	it("answers a retired pigment name with the whole utility to write instead", () => {
		expect(retiredTokenAdvice(dead("text", "red"))).toBe(dead("text", "danger"));
		expect(retiredTokenAdvice(dead("border", "yellow"))).toBe(dead("border", "warning"));
		expect(retiredTokenAdvice(dead("bg", "green"))).toBe(dead("bg", "success"));
		expect(retiredTokenAdvice(dead("ring", "blue"))).toBe(dead("ring", "info"));
	});

	it("says nothing about a dead token that was never a status colour", () => {
		// The foreign-vocabulary hits from #367's sweep. Guessing a replacement for these
		// would be inventing one, and a confident wrong suggestion is worse than none.
		expect(retiredTokenAdvice(dead("bg", "surface"))).toBe(null);
		expect(retiredTokenAdvice(dead("text", "primary"))).toBe(null);
	});
});

describe("findStatusOpacityModifiers (#367)", () => {
	const modifiers = (src) => findStatusOpacityModifiers(src).map((h) => h.utility);
	/** A status utility with an alpha, assembled so this file never spells a banned one out. */
	const tinted = (prefix, intent, alpha) => `${prefix}-${intent}/${alpha}`;

	it("catches the three alphas one tint was written with", () => {
		// Measured, not invented: a red tinted background existed at three different opacities
		// in the tree, in files nobody would have read side by side.
		const src = `<i className="${tinted("bg", "danger", 10)}" /><i className="${tinted("bg", "danger", 15)}" /><i className="${tinted("bg", "danger", 25)}" />`;
		expect(modifiers(src)).toEqual([tinted("bg", "danger", 10), tinted("bg", "danger", 15), tinted("bg", "danger", 25)]);
	});

	it("names the pairing that replaces each one, by role", () => {
		expect(pairingFor(tinted("bg", "warning", 10))).toBe("bg-warning-soft");
		expect(pairingFor(tinted("border", "warning", 40))).toBe("border-warning-line");
		expect(pairingFor(tinted("ring", "success", 30))).toBe("ring-success-line");
		// A translucent FOREGROUND is not a pairing — 90% of a colour is the colour.
		expect(pairingFor(tinted("text", "warning", 90))).toBe("text-warning");
	});

	it("stays quiet on the pairing tokens themselves, and on a token with no pairing", () => {
		// `--color-muted-soft` is already a text colour, so a neutral chip's tint has nowhere
		// to point; firing on it would be the #454 failure — a scanner objecting to the only
		// idiom available. The accent's heavier alphas are solid surfaces, not tints.
		const src = `<div className="bg-success-soft border-danger-line text-info bg-muted/15 bg-accent/70" />`;
		expect(modifiers(src)).toEqual([]);
	});

	it("does not read a tint out of a comment", () => {
		expect(modifiers(`// was ${tinted("bg", "success", 15)} before the pairing existed\n<b className="bg-success-soft" />`)).toEqual([]);
	});

	it("reports the line, and a repeat on one line once", () => {
		const src = `a\n<div className="${tinted("bg", "info", 15)} hover:${tinted("bg", "info", 15)}" />`;
		expect(findStatusOpacityModifiers(src)).toEqual([{ utility: tinted("bg", "info", 15), line: 2 }]);
	});
});

describe("findMissingStatusTokens (#367)", () => {
	const whole = `@theme {\n${["success", "danger", "warning", "info"].flatMap((i) => [`\t--color-${i}: #fff;`, `\t--color-${i}-soft: rgba(0,0,0,0.15);`, `\t--color-${i}-line: rgba(0,0,0,0.4);`]).join("\n")}\n}\n`;

	it("passes a palette that declares every intent and both pairings", () => {
		expect(findMissingStatusTokens(whole)).toEqual([]);
	});

	it("catches a deleted status colour — the failure `text-` cannot see", () => {
		expect(findMissingStatusTokens(whole.replace("\t--color-danger: #fff;\n", ""))).toEqual(["danger"]);
	});

	it("catches a pairing left off, which is how the modifier form comes back", () => {
		// Without the token there is nowhere for rule 3's message to point, so the next author
		// reaches for an alpha and the guard's advice is a lie.
		expect(findMissingStatusTokens(whole.replace("\t--color-warning-line: rgba(0,0,0,0.4);\n", ""))).toEqual(["warning-line"]);
	});
});
