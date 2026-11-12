import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("full-suite launcher (#1647)", () => {
	for (const [label, report, expectedExit, verdict] of [
		["populated passing report", { success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numFailedTestSuites: 0, testResults: [{ name: "one.test.ts", status: "passed" }] }, 0, "SUITE GREEN"],
		["failed report despite exit zero", { success: false, numTotalTests: 1, numPassedTests: 0, numFailedTests: 1, numFailedTestSuites: 1, testResults: [{ name: "one.test.ts", status: "failed" }] }, 1, "SUITE RED"],
		["missing report despite exit zero", null, 1, "SUITE RED"],
		["missing Vitest dependency", null, 1, "SUITE RED"],
	]) {
		it(`runs the Node entry and preserves the verdict for a ${label}`, () => {
			const root = mkdtempSync(join(tmpdir(), "pags suite café "));
			try {
				for (const dir of ["scripts/lib", "node_modules/vitest", "test-results"]) mkdirSync(join(root, dir), { recursive: true });
				copyFileSync(new URL("../test-full.mjs", import.meta.url), join(root, "scripts/test-full.mjs"));
				copyFileSync(new URL("./suite-verdict.mjs", import.meta.url), join(root, "scripts/lib/suite-verdict.mjs"));
				if (label !== "missing Vitest dependency") writeFileSync(join(root, "node_modules/vitest/package.json"), '{"name":"vitest"}');
				writeFileSync(join(root, "node_modules/vitest/vitest.mjs"), `import { writeFileSync } from 'node:fs';
const report = JSON.parse(process.env.FIXTURE_REPORT);
writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));
if (report) writeFileSync(process.argv.find(a => a.startsWith('--outputFile.json=')).slice('--outputFile.json='.length), JSON.stringify(report));`);
				// A stale green report must not survive a runner that writes nothing.
				writeFileSync(join(root, "test-results/vitest.json"), '{"success":true}');
				const args = ["--testNamePattern", "a b & café"];
				const result = spawnSync(process.execPath, [join(root, "scripts/test-full.mjs"), ...args], { cwd: tmpdir(), encoding: "utf8", env: { ...process.env, FIXTURE_REPORT: JSON.stringify(report) } });
				expect(result.error).toBeUndefined();
				expect(result.status, result.stderr).toBe(expectedExit);
				expect(result.stdout.trim().split("\n").at(-1)).toContain(verdict);
				expect(readFileSync(join(root, "test-results/vitest-summary.txt"), "utf8")).toContain(verdict);
				if (label === "missing Vitest dependency") expect(existsSync(join(root, "argv.json"))).toBe(false);
				else expect(JSON.parse(readFileSync(join(root, "argv.json"), "utf8")).slice(-2)).toEqual(args);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}
});
