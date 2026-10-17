/**
 * #1070 — `repo_find` with a glob, on the runner: matched over the WHOLE file list of a real git
 * repository, so `total` counts real matches even past the 50-result cap, and a glob never silently
 * returns nothing when matching files exist.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoSearch, SEARCH_MAX_RESULTS } from "./inspect.js";
import { globLiteral, globMatches, isGlob } from "./path-glob.js";

let dir: string;
const TESTS = 90;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "pags-glob-"));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	const files = [
		...Array.from({ length: TESTS }, (_, i) => `src/mod${i}/thing${i}.test.js`),
		"src/thing.js",
		"src/thing.test.js.snap",
		"lib/widget_test.dart",
		"lib/widget.dart",
		"e2e/login.spec.ts",
		"tools/e2e-helpers.ts",
		"api/handlers/users.js",
		"api/v2/handlers/orders.js",
		"handlers/root.js",
		"api/handlers/deep/nested.js",
	];
	for (const f of files) {
		mkdirSync(join(dir, dirname(f)), { recursive: true });
		writeFileSync(join(dir, f), "x\n");
	}
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const find = (glob: string) => repoSearch(dir, { pattern: globLiteral(glob), glob, mode: "path" });

describe("repo_find globs on the runner (#1070)", () => {
	it("`*.test.js` finds all 90 test files — counted past the 50-result cap — and not the .snap beside them", () => {
		const r = find("*.test.js");
		expect(r.glob).toBe(true);
		expect(r.total).toBe(TESTS);
		expect(r.shown).toBe(SEARCH_MAX_RESULTS);
		expect(r.truncated).toBe(true);
		expect(r.matches.every((m) => m.path.endsWith(".test.js"))).toBe(true);
	});

	it("the issue's patterns: `*_test.dart`, `*e2e*` (a file or a folder), `**/handlers/*.js`", () => {
		expect(find("*_test.dart").matches.map((m) => m.path)).toEqual(["lib/widget_test.dart"]);
		expect(find("*e2e*").matches.map((m) => m.path).sort()).toEqual(["e2e/login.spec.ts", "tools/e2e-helpers.ts"]);
		expect(find("**/handlers/*.js").matches.map((m) => m.path).sort()).toEqual(["api/handlers/users.js", "api/v2/handlers/orders.js", "handlers/root.js"]);
	});

	it("a plain substring is unchanged — no glob, no `glob` flag", () => {
		const r = repoSearch(dir, { pattern: "widget", mode: "path" });
		expect(r.glob).toBeUndefined();
		expect(r.matches.map((m) => m.path).sort()).toEqual(["lib/widget.dart", "lib/widget_test.dart"]);
	});

	it("isGlob / globLiteral", () => {
		expect(isGlob("event_form")).toBe(false);
		expect(isGlob("*.ts")).toBe(true);
		expect(globLiteral("**/handlers/*.js")).toBe("handlers");
		expect(globLiteral("./src/*.ts")).toBe("src");
		expect(globLiteral("*")).toBe("");
		expect(globMatches("*", "a/b")).toBe(true);
	});
});
