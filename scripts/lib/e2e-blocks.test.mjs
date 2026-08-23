/**
 * Unit tests for the two readers behind `check-e2e-projects.mjs` (#740).
 *
 * ADR 0002's follow-on note requires a hand-rolled source scanner to carry its own test
 * naming what it does NOT handle, and most of what is below is exactly that. The point is
 * not that these read the spec files we have — it is that they return a recognisably
 * EMPTY answer for a shape they cannot read, so the guard reports it instead of quietly
 * scoring a block as "wide, not a phone".
 *
 * The `blockEnd` cases are the ones that matter. The first draft of this guard ran a body
 * to the next test's line instead, and produced two false positives on the day it was
 * written by swallowing a following describe's helpers.
 */

import { describe, expect, it } from "vitest";
import { blockEnd, widthsIn } from "./e2e-blocks.mjs";

const lines = (s) => s.split("\n");

describe("blockEnd", () => {
	it("stops at the block's own closer, not at the next test", () => {
		const src = lines(
			[
				"\ttest(\"a\", async ({ page }) => {", // 1
				"\t\tawait page.click();", // 2
				"\t});", // 3
				"", // 4
				"\tasync function helper(page, width) {", // 5
				"\t\tawait page.setViewportSize({ width, height: 812 });", // 6
				"\t}", // 7
				"", // 8
				"\ttest(\"b\", async ({ page }) => {", // 9
				"\t});", // 10
			].join("\n"),
		);
		// This is the regression: 3, never 8. The helper below belongs to test "b".
		expect(blockEnd(src, 1)).toBe(3);
	});

	it("does not stop at a nested closer, which is indented deeper", () => {
		const src = lines(
			["\ttest(\"a\", async () => {", "\t\tfoo(() => {", "\t\t});", "\t\tbar();", "\t});"].join("\n"),
		);
		expect(blockEnd(src, 1)).toBe(5);
	});

	it("handles a top-level (unindented) block", () => {
		const src = lines(['test("a", async () => {', "\tfoo();", "});"].join("\n"));
		expect(blockEnd(src, 1)).toBe(3);
	});

	// NOT handled — each must be null so the caller reports it.
	it("returns null when the closer carries a trailing comment", () => {
		const src = lines(['\ttest("a", async () => {', "\t\tfoo();", "\t}); // done"].join("\n"));
		expect(blockEnd(src, 1)).toBeNull();
	});

	it("returns null when the closer has no semicolon", () => {
		const src = lines(['\ttest("a", async () => {', "\t\tfoo();", "\t})"].join("\n"));
		expect(blockEnd(src, 1)).toBeNull();
	});

	it("returns null when the closer is indented with spaces and the opener with tabs", () => {
		const src = lines(['\ttest("a", async () => {', "\t\tfoo();", "    });"].join("\n"));
		expect(blockEnd(src, 1)).toBeNull();
	});

	it("returns null for a start line outside the file", () => {
		const src = lines('\ttest("a", async () => {\n\t});');
		expect(blockEnd(src, 0)).toBeNull();
		expect(blockEnd(src, 99)).toBeNull();
	});
});

describe("widthsIn", () => {
	it("reads a literal width", () => {
		expect(widthsIn("await page.setViewportSize({ width: 390, height: 780 });")).toEqual([390]);
	});

	it("reads several literal widths in one body", () => {
		const body = "setViewportSize({ width: 320, height: 812 });\nsetViewportSize({ width: 1280, height: 800 });";
		expect(widthsIn(body)).toEqual([320, 1280]);
	});

	it("reads the widths of a `for (const width of [...])` loop", () => {
		const body = "for (const width of [320, 390]) {\n\tawait page.setViewportSize({ width, height: 800 });\n}";
		expect(widthsIn(body)).toEqual([320, 390]);
	});

	it("tolerates whitespace and a trailing comma in the loop array", () => {
		expect(widthsIn("for ( const width of [ 320 , 390 , ] ) {")).toEqual([320, 390]);
	});

	// NOT handled — an empty array here means "cannot read", and the guard treats a body
	// that DOES resize but yields no width as a failure rather than as a wide layout.
	it("yields nothing for a width held in a variable", () => {
		expect(widthsIn("const w = PHONE;\nawait page.setViewportSize({ width: w, height: 812 });")).toEqual([]);
	});

	it("yields nothing for a fixture viewport", () => {
		expect(widthsIn("test.use({ viewport: { width: 390, height: 812 } });")).toEqual([]);
	});

	it("yields nothing for a loop variable not named `width`", () => {
		expect(widthsIn("for (const w of [320, 390]) {\n\tsetViewportSize({ width: w, height: 812 });\n}")).toEqual([]);
	});

	it("yields nothing for a body that never resizes", () => {
		expect(widthsIn("await expect(page.getByText('hi')).toBeVisible();")).toEqual([]);
	});
});
