import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Layout assertions on the source (#227). The issues row has no logic to unit-test — the bug was
 * purely that the title, the only content that matters, was squeezed to nothing on a phone by
 * fixed-width neighbours.
 */
const SRC = readFileSync(join(__dirname, "RepoIssues.tsx"), "utf8");
/** Comments explain these rules and would otherwise satisfy assertions ABOUT them. */
const CODE = SRC.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the issues row on a narrow screen", () => {
	it("hides the button LABEL on mobile but keeps the button", () => {
		// ~70px of the title's width. The icon stays, so the action is still reachable.
		expect(CODE).toContain('<span className="hidden sm:inline">Work on this</span>');
		expect(CODE).toContain("<Play size={10} />");
	});

	it("keeps the action labelled for screen readers once the text is gone", () => {
		// Hiding visible text turns an icon button into an unlabelled one unless this is here.
		expect(CODE).toMatch(/aria-label=\{`Work on issue #\$\{i\.number\}`\}/);
	});

	it("lets the title use the recovered space instead of truncating at any width", () => {
		expect(CODE).toContain("line-clamp-2 sm:truncate");
	});

	it("aligns the row to the top, so a wrapped title does not float the controls", () => {
		// items-center with a two-line title centres #N and the buttons against the middle of it.
		expect(CODE).toContain("flex items-start gap-2 text-xs");
		expect(CODE).not.toContain("flex items-center gap-2 text-xs");
	});

	it("gives the button a real tap target on touch", () => {
		// py-0.5 is ~18px tall — under any touch-target guidance. p-1.5 on mobile, tight on desktop.
		expect(CODE).toContain("p-1.5 sm:px-1.5 sm:py-0.5");
	});

	it("still lets the title shrink — flex-1 alone does not allow it", () => {
		// The classic flexbox trap: without min-w-0 a flex child refuses to shrink below its
		// content, so `truncate` never engages and the row overflows instead.
		expect(CODE).toContain("flex-1 min-w-0");
	});
});
