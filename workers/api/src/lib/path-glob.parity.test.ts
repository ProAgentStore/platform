/**
 * #1070 — the cloud's glob matcher and the runner's are ONE semantics in two copies: the runner matches
 * a glob over the whole file list, and the cloud filters with its copy when the runner is too old to.
 * Two copies that disagreed would answer the same `repo_find` differently by runner version. One table,
 * both copies.
 */
import { describe, expect, it } from "vitest";
import * as runner from "../../../../packages/browser-runner/src/coding/path-glob.js";
import * as cloud from "./path-glob.js";

const CASES: Array<[glob: string, path: string, matches: boolean]> = [
	["*.test.js", "src/a/b.test.js", true],
	["*.test.js", "b.test.js", true],
	["*.test.js", "src/b.test.js.snap", false],
	["*_test.dart", "lib/widget_test.dart", true],
	["*e2e*", "e2e/login.spec.ts", true],
	["*e2e*", "tools/e2e-helpers.ts", true],
	["*e2e*", "src/main.ts", false],
	["**/handlers/*.js", "api/handlers/users.js", true],
	["**/handlers/*.js", "handlers/root.js", true],
	["**/handlers/*.js", "api/handlers/deep/nested.js", false],
	["src/*.ts", "src/a.ts", true],
	["src/*.ts", "src/x/a.ts", false],
	["src/*.ts", "lib/src/a.ts", false],
	["./src/*.ts", "src/a.ts", true],
	["/src/**", "src/x/y/z.ts", true],
	["src/**/*.ts", "src/a.ts", true],
	["src/**/*.ts", "src/x/y/a.ts", true],
	["?.ts", "a.ts", true],
	["?.ts", "ab.ts", false],
	["[ab].ts", "b.ts", true],
	["[!ab].ts", "b.ts", false],
	["[!ab].ts", "c.ts", true],
	["[a-c]*.TS", "lib/Bravo.ts", true],
	["*.TEST.JS", "x/y.test.js", true],
	["a[", "a[", true],
	["*.js", "a.js/b", true],
];

describe("one glob semantics, two copies (#1070)", () => {
	it.each(CASES)("%s against %s → %s", (glob, path, expected) => {
		expect(cloud.globMatches(glob, path)).toBe(expected);
		expect(runner.globMatches(glob, path)).toBe(expected);
	});

	it("the literal an old runner is sent, and what counts as a glob, agree", () => {
		for (const [glob] of CASES) {
			expect(cloud.globLiteral(glob)).toBe(runner.globLiteral(glob));
			expect(cloud.isGlob(glob)).toBe(runner.isGlob(glob));
		}
	});

	it("every path a glob matches contains its literal — so an old runner's substring pre-filter drops nothing", () => {
		for (const [glob, path, expected] of CASES) {
			if (expected && cloud.isGlob(glob)) expect(path.toLowerCase()).toContain(cloud.globLiteral(glob).toLowerCase());
		}
	});
});
