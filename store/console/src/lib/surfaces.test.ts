import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SURFACES, surfaceOwnsHeader, visibleSurfaces } from "./surfaces";

describe("surfaceOwnsHeader — the header takeover is DECLARED, not hardcoded to one tab", () => {
	it("grants it only to a surface that declares it", () => {
		// It used to be `if (tab !== "coding")` in InstanceDetail: a string comparison against one
		// tab name, so exactly one first-party component could ever own the header and the next one
		// to need it would have added a second hardcoded branch.
		expect(surfaceOwnsHeader("coding")).toBe(true);
		for (const id of ["chat", "knowledge", "settings", "board", "repo", "data"]) {
			expect(surfaceOwnsHeader(id), id).toBe(false);
		}
	});

	it("never grants it to an unknown or missing id", () => {
		expect(surfaceOwnsHeader(undefined)).toBe(false);
		expect(surfaceOwnsHeader("totally-made-up")).toBe(false);
		expect(surfaceOwnsHeader("")).toBe(false);
	});

	it("keeps the takeover rare — replacing the shell chrome is not a default", () => {
		// A guard on the DESIGN, not just the code: if several surfaces start claiming the header,
		// the page has two owners of the same region and the last one to mount wins.
		expect(SURFACES.filter((s) => s.ownsHeader).map((s) => s.id)).toEqual(["coding"]);
	});
});

/**
 * Strip comments before matching. Both guards below describe what the CODE may do, and the
 * explanations of the very thing they forbid necessarily quote it — without this, the comment that
 * documents the fix fails the test that protects it.
 */
function codeOf(relPath: string): string {
	return readFileSync(join(__dirname, relPath), "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
		.join("\n");
}

describe("the hardcoded branch does not come back", () => {
	it("InstanceDetail no longer clears the header by tab NAME", () => {
		// The whole point of the change is that the shell asks the registry. A future edit that
		// re-introduces `tab === "coding"` there would restore the special case while every other
		// test still passed.
		const src = codeOf("../pages/InstanceDetail.tsx");
		expect(src).toContain("surfaceOwnsHeader");
		expect(src).not.toMatch(/tab\s*!==\s*"coding"/);
		expect(src).not.toMatch(/tab\s*===\s*"coding"/);
	});

	it("no surface is singled out by slug anywhere in the registry", () => {
		// `show` must key off declared capability surfaces, never an agent's identity.
		const src = codeOf("surfaces.tsx");
		for (const slug of ["coder-repo", "coder-lead", "job-application-assistant", "repo-chat", "language-buddy"]) {
			expect(src, slug).not.toContain(slug);
		}
	});
});

describe("visibleSurfaces still derives tabs from declared capabilities", () => {
	it("a coding agent gets Coding but not Repo or Board", () => {
		const ids = visibleSurfaces(["coding"]).map((s) => s.id);
		expect(ids).toContain("coding");
		expect(ids).not.toContain("repo");
		expect(ids).not.toContain("board");
	});

	it("an agent declaring nothing still gets the generic board", () => {
		expect(visibleSurfaces([]).map((s) => s.id)).toContain("board");
	});
});
