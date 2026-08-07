import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONSOLE_CATCH_ALL_ROUTES, CONSOLE_ROUTES, INSTANCE_TABS, checkConsoleLink } from "./routes";
import { SURFACE_IDS } from "./surfaces";

/**
 * A table copied from the app is only worth something while it still matches the app. These two
 * hold it against both of its sources — the router and the surface registry — so the guard cannot
 * quietly become a description of a console that no longer exists.
 */
describe("the table is the app's, not a copy of it", () => {
	it("lists exactly the routes App.tsx declares", () => {
		const src = readFileSync(join(__dirname, "..", "App.tsx"), "utf8");
		const declared = [...src.matchAll(/<Route[^>]*\spath="([^"]+)"/g)].map((m) => m[1]);
		expect(new Set(declared)).toEqual(new Set([...CONSOLE_ROUTES, ...CONSOLE_CATCH_ALL_ROUTES]));
	});

	it("lists exactly the tabs the surface registry can render", () => {
		expect([...INSTANCE_TABS].sort()).toEqual([...SURFACE_IDS].sort());
	});
});

describe("checkConsoleLink", () => {
	it("accepts the links the product actually sends", () => {
		for (const url of [
			"/console/",
			"/console/profile",
			"/console/notifications",
			"/console/instances/i1",
			"/console/instances/i1/board",
			"/console/instances/i1/knowledge",
			"/console/instances/i1/coding",
			"/console/instances/i1/coding/csess_1",
			"/console/instances/i1/coding?builds=repo_1",
			"/console/instances/i1/tasks/task_1",
		]) {
			expect(checkConsoleLink(url), url).toEqual(expect.objectContaining({ ok: true }));
		}
	});

	/**
	 * The bug, as a case. `instances/:id/*` matches this happily — the router has no opinion about
	 * what is INSIDE a splat — so only the positional grammar catches it.
	 */
	it("rejects the #344 link: extra splat segments the page silently drops", () => {
		const bad = checkConsoleLink("/console/instances/i1/coding/repos/repo_1/summary");
		expect(bad.ok).toBe(false);
		expect(bad.ok === false && bad.reason).toMatch(/splat segments/);
	});

	it("rejects a #fragment path, which a BrowserRouter never reads", () => {
		const bad = checkConsoleLink("/console/#/instances/i1");
		expect(bad.ok).toBe(false);
		expect(bad.ok === false && bad.reason).toMatch(/BrowserRouter/);
	});

	it("rejects a tab that is not a surface, which lands on Assistant instead", () => {
		expect(checkConsoleLink("/console/instances/i1/builds").ok).toBe(false);
		expect(checkConsoleLink("/console/instances/i1/summary").ok).toBe(false);
	});

	it("rejects a path no route claims, which the catch-all would swallow", () => {
		expect(checkConsoleLink("/console/runs/run_1").ok).toBe(false);
		expect(checkConsoleLink("/console/instances").ok).toBe(true); // …but this one is real
	});

	it("rejects anything a notification tap cannot navigate to", () => {
		for (const url of ["", "https://github.com/acme/app/actions/runs/2", "javascript:alert(1)", "instances/i1"]) {
			expect(checkConsoleLink(url).ok, url).toBe(false);
		}
	});
});
