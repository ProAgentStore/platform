/**
 * Unit tests for the full-suite verdict behind `scripts/test-full.mjs` (#920).
 *
 * Each case is a way a run has looked green without being green: no report at all, a
 * report that collected nothing, failures under an exit code of 0.
 */

import { describe, expect, it } from "vitest";
import { suiteVerdict } from "./suite-verdict.mjs";

const green = {
	success: true,
	numTotalTestSuites: 4, // describe blocks + files — not the file count
	numFailedTestSuites: 0,
	numTotalTests: 5,
	numPassedTests: 5,
	numFailedTests: 0,
	testResults: [
		{ name: "/r/a.test.ts", status: "passed" },
		{ name: "/r/b.test.ts", status: "passed" },
	],
};

describe("suiteVerdict", () => {
	it("is green only with a populated, failure-free report and exit 0", () => {
		const v = suiteVerdict({ exitCode: 0, report: green });
		expect(v.ok).toBe(true);
		expect(v.reasons).toEqual([]);
		expect(v.summary).toBe("Test Files  0 failed | 2 passed (2) · Tests  0 failed | 5 passed (5)");
	});

	it("is red when no report was written, even on exit 0 (the 0-byte-log case)", () => {
		const v = suiteVerdict({ exitCode: 0, report: null });
		expect(v.ok).toBe(false);
		expect(v.reasons[0]).toMatch(/no vitest JSON report/);
	});

	it("is red when the report collected 0 tests (run from a package dir)", () => {
		const empty = { ...green, numTotalTestSuites: 0, numTotalTests: 0, numPassedTests: 0, testResults: [] };
		const v = suiteVerdict({ exitCode: 0, report: empty });
		expect(v.ok).toBe(false);
		expect(v.reasons.join("\n")).toMatch(/0 tests/);
		expect(v.reasons.join("\n")).toMatch(/false green/);
	});

	it("is red and names the failing files when tests failed", () => {
		const red = {
			...green,
			success: false,
			numFailedTestSuites: 1,
			numPassedTests: 4,
			numFailedTests: 1,
			testResults: [green.testResults[0], { name: "/r/b.test.ts", status: "failed" }],
		};
		const v = suiteVerdict({ exitCode: 1, report: red });
		expect(v.ok).toBe(false);
		expect(v.failedFiles).toEqual(["/r/b.test.ts"]);
		expect(v.summary).toBe("Test Files  1 failed | 1 passed (2) · Tests  1 failed | 4 passed (5)");
	});

	it("flags an exit code of 0 that contradicts recorded failures", () => {
		const v = suiteVerdict({ exitCode: 0, report: { ...green, success: false, numFailedTests: 1 } });
		expect(v.ok).toBe(false);
		expect(v.reasons.join("\n")).toMatch(/false green/);
	});

	it("is red when vitest exits non-zero with a clean report (e.g. an unhandled error)", () => {
		const v = suiteVerdict({ exitCode: 1, report: green });
		expect(v.ok).toBe(false);
		expect(v.reasons).toEqual(["vitest exited 1"]);
	});
});
