/**
 * CI's Playwright browser install stays bounded (#1047). Reads `.github/workflows/ci.yml` itself, so
 * putting the bare `playwright install` back — or dropping a bound, or the E2E run after it — is red.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CI = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
const lines = CI.split("\n");

/** The `- ` step block containing `needle`: from its dash to the next step at the same indent. */
function stepWith(needle) {
	const at = lines.findIndex((l) => l.includes(needle) && !l.trimStart().startsWith("#"));
	if (at < 0) return null;
	let start = at;
	while (start > 0 && !/^\s*- /.test(lines[start])) start--;
	const indent = lines[start].match(/^(\s*)-/)[1].length;
	let end = start + 1;
	while (end < lines.length && !(new RegExp(`^\\s{${indent}}- `).test(lines[end]) || /^\S/.test(lines[end]))) end++;
	return { start, end, text: lines.slice(start, end).join("\n") };
}

describe("CI's browser install step (#1047)", () => {
	const step = stepWith("node scripts/install-playwright-browsers.mjs");

	it("runs through the bounded wrapper, never the bare command", () => {
		expect(step).not.toBeNull();
		const bare = lines.filter((l) => /playwright install/.test(l) && !l.trimStart().startsWith("#"));
		expect(bare).toEqual([]);
	});

	it("has its own timeout-minutes", () => {
		expect(step.text).toMatch(/^\s+timeout-minutes:\s*\d+\s*$/m);
	});

	it("the job has an overall timeout-minutes", () => {
		const job = CI.slice(CI.indexOf("\n  ci:\n"), CI.indexOf("    steps:"));
		expect(job).toMatch(/^\s{4}timeout-minutes:\s*\d+\s*$/m);
	});

	it("E2E still runs, after the install", () => {
		const e2e = stepWith("pnpm test:e2e");
		expect(e2e).not.toBeNull();
		expect(e2e.start).toBeGreaterThan(step.start);
	});

	it("the wrapper exists, and installs both browsers with their dependencies", async () => {
		expect(existsSync(join(ROOT, "scripts/install-playwright-browsers.mjs"))).toBe(true);
		const { INSTALL_COMMAND } = await import("./install-playwright-browsers.mjs");
		expect(INSTALL_COMMAND[1]).toEqual(expect.arrayContaining(["--with-deps", "chromium", "webkit"]));
	});
});
