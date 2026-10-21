import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { floatingReason, runsOnValues, touchesPlaywright, violationsIn } from "./check-workflow-runner.mjs";

const wf = (runsOn, body = "run: npx playwright install") => `jobs:\n  ci:\n    runs-on: ${runsOn}\n    steps:\n      - ${body}\n`;

describe("workflow runner pin (#1266)", () => {
	it("flags ubuntu-latest in a workflow that installs Playwright", () => {
		expect(violationsIn(wf("ubuntu-latest"))).toEqual([{ line: 3, value: "ubuntu-latest", reason: "a floating `-latest` image" }]);
	});

	it("flags a workflow that only mentions browser-runner, case-insensitively", () => {
		expect(violationsIn(wf("ubuntu-latest", "run: pnpm --filter Browser-Runner test")).length).toBe(1);
	});

	it("accepts a pinned image, and ignores a trailing comment that says ubuntu-latest", () => {
		expect(violationsIn(wf("ubuntu-24.04  # pinned from ubuntu-latest, see #1266"))).toEqual([]);
		expect(violationsIn(wf("macos-15"))).toEqual([]);
	});

	it("does not judge a workflow that never touches Playwright", () => {
		expect(touchesPlaywright(wf("ubuntu-latest", "run: echo hi"))).toBe(false);
		expect(violationsIn(wf("ubuntu-latest", "run: echo hi"))).toEqual([]);
	});

	it("reads flow lists, quoted labels, and flags other floating or unreadable images", () => {
		expect(runsOnValues("    runs-on: [self-hosted, \"ubuntu-latest\"]\n").map((v) => v.value)).toEqual(["self-hosted", "ubuntu-latest"]);
		expect(floatingReason("macos-latest")).toMatch(/-latest/);
		expect(floatingReason("ubuntu")).toBe("no version");
		expect(floatingReason(["$", "{{ matrix.os }}"].join(""))).toMatch(/expression/);
		expect(floatingReason("ubuntu-24.04")).toBeNull();
	});

	it("flags every floating runs-on in a multi-job workflow, with its own line", () => {
		const text = "jobs:\n  a:\n    runs-on: ubuntu-24.04\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - run: playwright test\n";
		expect(violationsIn(text).map((v) => v.line)).toEqual([5]);
	});
});

describe("the repo's own workflows", () => {
	const ROOT = join(import.meta.dirname, "..");
	it("pass the guard", () => {
		const r = spawnSync(process.execPath, [join(ROOT, "scripts/check-workflow-runner.mjs")], { encoding: "utf8" });
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
	});

	it("CI runs the guard, and before the Playwright browsers are installed", () => {
		const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
		const guard = ci.indexOf("node scripts/check-workflow-runner.mjs");
		const install = ci.indexOf("node scripts/install-playwright-browsers.mjs");
		expect(guard).toBeGreaterThan(0);
		expect(guard).toBeLessThan(install);
	});
});
