import { describe, expect, it } from "vitest";
import { findDeadColorUtilities, parseThemeColorTokens, stripComments } from "./design-tokens.mjs";

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
	--color-green: #22c55e;
	--color-red: #ef4444;
	--color-yellow: #eab308;
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
		const shrunk = parseThemeColorTokens(THEME.replace("\t--color-yellow: #eab308;\n", ""));
		expect(findDeadColorUtilities('<b className="text-yellow" />', shrunk).map((h) => h.utility)).toEqual([
			"text-yellow",
		]);
	});

	it("reports the line, and reports a repeated token on one line once", () => {
		const src = `line one\n<div className="${dead("text", "orange")} hover:${dead("text", "orange")}" />`;
		expect(findDeadColorUtilities(src, declared)).toEqual([{ utility: dead("text", "orange"), line: 2 }]);
	});
});

describe("does not fire on correct code", () => {
	it("accepts declared tokens, including the multi-word ones and opacity modifiers", () => {
		const src = `<div className="bg-panel-hover border-line text-muted bg-accent-soft bg-red/15 hover:text-green" />`;
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
