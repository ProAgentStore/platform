import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BADGE_BASE, BUTTON_BASE, BUTTON_SIZE, BUTTON_VARIANT, CARD_GEOMETRY, CARD_TONE, badgeClass, buttonClass, cardClass } from "./control-classes.js";
import { INTENT_CLASS } from "./statusBadge.js";

/**
 * The tables, tested as tables (#366).
 *
 * A variant→class map earns its existence by being enumerable: the properties below are true of
 * EVERY entry, checked by iterating the record, and adding a fifth variant without a font-weight
 * or a sixth size with two radii fails here rather than in a screenshot. A ternary chain could
 * not be asserted this way, which is the reason this is a record.
 */

const utilities = (cls: string) => cls.split(/\s+/).filter(Boolean);
/** Utilities that set one CSS property, ignoring `hover:`/`sm:`/`disabled:` state variants. */
const unprefixed = (cls: string) => utilities(cls).filter((u) => !u.includes(":"));

describe("the button size ramp", () => {
	it.each(Object.entries(BUTTON_SIZE))("%s names exactly one radius", (_size, cls) => {
		expect(unprefixed(cls).filter((u) => u.startsWith("rounded"))).toHaveLength(1);
	});

	it.each(Object.entries(BUTTON_SIZE))("%s names padding", (_size, cls) => {
		expect(unprefixed(cls).some((u) => /^p[xy]?-/.test(u))).toBe(true);
	});

	/**
	 * The rule the issue asks for in words: "Nothing below `text-xs` (12px) for anything a user
	 * reads." The 11.2px arbitrary size was on 110 elements including button labels. #390 gave
	 * the scale a real floor step below `text-xs`, so a size CAN now name a sub-12px step by
	 * name — this keeps it from doing so, and keeps it from reintroducing an arbitrary rem
	 * value, which would put the type drift back inside the thing that exists to absorb it.
	 */
	it("uses only named type steps at or above text-xs, never an arbitrary rem value", () => {
		for (const cls of Object.values(BUTTON_SIZE)) {
			expect(cls).not.toMatch(/text-\[/);
			expect(cls).not.toMatch(/\btext-2xs\b/);
		}
	});

	it("gives the icon size no type step, because it holds an icon", () => {
		expect(BUTTON_SIZE.icon).not.toMatch(/\btext-/);
	});

	/**
	 * WCAG 2.5.8 Target Size (Minimum), Level AA: 24×24 CSS px, in BOTH axes (#389).
	 *
	 * Asserted as a property of every entry rather than checked once, because the way this
	 * regresses is a fifth size added later — `xs`, for some row that felt tight — with the
	 * padding copied and the floor forgotten. Nothing renders a warning for a target that is
	 * too small; it just gets mis-tapped, and `min-w` matters as much as `min-h` because the
	 * narrow case is a one-character label, not a short one.
	 */
	it.each(Object.entries(BUTTON_SIZE))("%s clears WCAG 2.5.8's 24px minimum in both axes", (_size, cls) => {
		expect(unprefixed(cls)).toContain("min-h-6");
		expect(unprefixed(cls)).toContain("min-w-6");
	});
});

describe("the button variant table", () => {
	it.each(Object.entries(BUTTON_VARIANT))("%s names exactly one font weight", (_variant, cls) => {
		expect(unprefixed(cls).filter((u) => u.startsWith("font-"))).toHaveLength(1);
	});

	it.each(Object.entries(BUTTON_VARIANT))("%s has a hover state", (_variant, cls) => {
		// The defect this pins: `primary` shipped with no hover at all for 266 buttons' worth of
		// call sites, while `--color-accent-hover` sat declared in @theme for exactly that.
		expect(utilities(cls).some((u) => u.startsWith("hover:"))).toBe(true);
	});

	it.each(Object.entries(BUTTON_VARIANT))("%s carries no padding or radius of its own", (_variant, cls) => {
		// Colour and shape are separate axes; a variant that also sized itself would multiply
		// back out into the 47 combinations this replaces.
		expect(utilities(cls).some((u) => /^(?:p[xy]?-|rounded)/.test(u))).toBe(false);
	});
});

describe("buttonClass", () => {
	it("defaults to the secondary control at medium — the shape 85 call sites had written by hand", () => {
		expect(buttonClass()).toBe(`${BUTTON_BASE} ${BUTTON_SIZE.md} ${BUTTON_VARIANT.secondary}`);
	});

	it("appends the caller's position classes last and only when given", () => {
		expect(buttonClass("primary", "sm", "shrink-0")).toBe(`${BUTTON_BASE} ${BUTTON_SIZE.sm} ${BUTTON_VARIANT.primary} shrink-0`);
		expect(buttonClass("primary", "sm")).not.toMatch(/\s$/);
	});

	it("dims a disabled control whatever the variant", () => {
		// Written at only some call sites before, in three strengths (30/40/50).
		for (const variant of Object.keys(BUTTON_VARIANT) as (keyof typeof BUTTON_VARIANT)[]) {
			expect(buttonClass(variant)).toMatch(/\bdisabled:opacity-50\b/);
		}
	});

	/**
	 * A flex button ignores `text-align`, so `justify-center` is what keeps a `w-full` button's
	 * label centred. Dropping it while keeping `inline-flex` left-aligns every wide button — a
	 * regression with no compile error and no failing selector.
	 */
	it("keeps justify-center beside inline-flex", () => {
		expect(BUTTON_BASE).toContain("inline-flex");
		expect(BUTTON_BASE).toContain("justify-center");
	});
});

describe("cardClass", () => {
	it("has ONE geometry, whichever tone is asked for", () => {
		for (const tone of Object.keys(CARD_TONE) as (keyof typeof CARD_TONE)[]) {
			expect(cardClass(tone)).toContain(CARD_GEOMETRY);
		}
	});

	it("keeps the responsive padding as the default rather than one of three", () => {
		// `rounded-xl p-3 sm:p-4` (34 sites) beat `rounded-xl p-4` (18) and `rounded-lg p-3` (15).
		expect(CARD_GEOMETRY).toContain("sm:p-4");
		expect(unprefixed(CARD_GEOMETRY).filter((u) => u.startsWith("rounded"))).toEqual(["rounded-xl"]);
	});

	it("differs between tones only in the fill", () => {
		const diff = utilities(CARD_TONE.paper).filter((u) => !utilities(CARD_TONE.panel).includes(u));
		expect(diff).toEqual(["bg-paper"]);
	});
});

describe("badgeClass", () => {
	it("takes its colour from the shared intent layer, not a copy of it", () => {
		// #368 refused to invent a third status vocabulary; a private table here would be a fourth.
		expect(badgeClass("success")).toBe(`${BADGE_BASE} ${INTENT_CLASS.success}`);
	});

	it("defaults to neutral", () => {
		expect(badgeClass()).toContain(INTENT_CLASS.neutral);
	});
});

/**
 * The second copy (#366).
 *
 * `agents/coder/web` renders inside this console and shares its compiled stylesheet, so a button
 * in the Coding tab sits beside a button in the console shell. Until this commit those were two
 * vocabularies: 47 hand-authored shapes there against four steps here, on one screen.
 *
 * It could not import the table — `store/console` depends on `@proagentstore/coder-web`, so the
 * arrow only goes one way, and the SDK is not a home for it because Tailwind v4 skips
 * `node_modules` (the reason `index.css` carries an explicit `@source` for that directory in the
 * first place). So the table is vendored, exactly as the design TOKENS are vendored into
 * `store/admin` and held equal by `designTokens.test.ts` — DESIGN-SYSTEM.md §4's "three copies".
 *
 * What makes duplication acceptable is that a machine polices it. This reads the region between
 * the `vendored:button-vocabulary` markers out of both files and requires it byte-identical, so a
 * fifth size added on one side fails here rather than in a screenshot of one tab.
 */
describe("the vendored copy in agents/coder/web", () => {
	const CONSOLE_FILE = join(import.meta.dirname, "control-classes.ts");
	const CODER_WEB_FILE = join(import.meta.dirname, "../../../../agents/coder/web/src/control-classes.ts");

	/** Between the markers, inclusive. Null when a marker is missing, which is itself a failure. */
	function region(path: string): string | null {
		const src = readFileSync(path, "utf-8");
		const open = src.indexOf("/* ── vendored:button-vocabulary");
		const close = src.indexOf("/* ── /vendored:button-vocabulary");
		if (open === -1 || close === -1 || close < open) return null;
		return src.slice(open, src.indexOf("\n", close) + 1);
	}

	it("carries the markers in both files", () => {
		// A missing marker would make the comparison below vacuously pass on an empty string, which
		// is the way a text-region guard silently stops guarding.
		expect(region(CONSOLE_FILE)).not.toBeNull();
		expect(region(CODER_WEB_FILE)).not.toBeNull();
		expect(region(CONSOLE_FILE)?.length).toBeGreaterThan(500);
	});

	it("is byte-identical to this file's", () => {
		expect(region(CODER_WEB_FILE)).toBe(region(CONSOLE_FILE));
	});

	it("really is the table this module exports, not a stale paste of its text", () => {
		// The region is compared as TEXT, so it proves the two files agree — not that either one
		// still describes what `buttonClass` does. These two assertions tie the text back to the
		// runtime values, so deleting a step from the exported record cannot leave the guard green.
		const text = region(CONSOLE_FILE) ?? "";
		for (const [size, cls] of Object.entries(BUTTON_SIZE)) expect(text).toContain(`${size}: "${cls}"`);
		for (const [variant, cls] of Object.entries(BUTTON_VARIANT)) expect(text).toContain(`${variant}: "${cls}"`);
	});
});
