import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// The console's own route table, imported rather than restated — a guard that keeps its own idea
// of the routes is a second thing to drift. `routes.ts` is React-free for exactly this reason.
import { checkConsoleLink } from "../../../../store/console/src/lib/routes";
import * as links from "./console-links";

/**
 * The guard #344 asks for: a link is a string built in a Worker, the routes are declared in a
 * React app, and until this test nothing checked that the two agree. Two producers were wrong.
 *
 * It is complete in both directions:
 *   - every function exported from `console-links.ts` is called and checked here, so a new
 *     builder is covered the moment it is added;
 *   - no other module under `workers/api/src` may build a `/console/…` string, so a producer
 *     cannot avoid the check by being written somewhere else.
 */
describe("every console link this Worker builds resolves to a real page", () => {
	const builders = Object.entries(links).filter(([, v]) => typeof v === "function") as [string, (...a: string[]) => string][];

	it("has builders to check (a silently empty sweep is the failure mode of this shape of test)", () => {
		expect(builders.length).toBeGreaterThanOrEqual(7);
	});

	for (const [name, build] of builders) {
		it(`${name}() lands on a page that exists`, () => {
			const url = build("inst_1", "id_2");
			const check = checkConsoleLink(url);
			expect(check.ok, `${name}() → ${url}: ${check.ok === false ? check.reason : ""}`).toBe(true);
		});
	}

	// Every builder takes ids from the database. An id that needs escaping must not be able to
	// invent path segments or query parameters.
	for (const [name, build] of builders) {
		it(`${name}() survives an id that would otherwise change the path`, () => {
			const url = build("a/b?c", "d/e&f=g");
			const check = checkConsoleLink(url);
			expect(check.ok, `${name}() → ${url}: ${check.ok === false ? check.reason : ""}`).toBe(true);
		});
	}
});

describe("no producer escapes the check", () => {
	it("is the only place under workers/api/src that builds a /console path", () => {
		const offenders: string[] = [];
		for (const file of walk(join(__dirname, ".."))) {
			if (file.endsWith("/lib/console-links.ts") || /\.(test|spec)\.ts$/.test(file)) continue;
			// Strip comments first: the modules that USED to build these links explain what they no
			// longer do, and the explanation must not fail the test that protects it.
			const code = readFileSync(file, "utf8")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.split("\n")
				.map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
				.join("\n");
			if (/["'`]\/console(\/|["'`])/.test(code)) offenders.push(file.slice(file.indexOf("workers/api")));
		}
		expect(offenders, "build the link in lib/console-links.ts, where it is checked against the router").toEqual([]);
	});
});

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}
