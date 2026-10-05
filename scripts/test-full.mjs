#!/usr/bin/env node
/**
 * test-full.mjs — run the full vitest suite and print a verdict you can trust (#920).
 *
 * `pnpm test` + `tee` + `$?` produced false greens: a 0-byte log with exit 0. The cause
 * is in `scripts/lib/suite-verdict.mjs`. This wrapper removes every link of that chain:
 *
 *   • it always runs from the repo root, whatever the caller's cwd, so the include globs
 *     resolve (from `workers/api` vitest finds "No test files");
 *   • vitest writes a JSON report to `test-results/vitest.json` itself — no pipe or
 *     shell redirect involved — and the old file is deleted first, so a stale report can
 *     never stand in for a run that did not happen;
 *   • the last line is `SUITE GREEN` or `SUITE RED` with the counts, and the exit code is
 *     non-zero unless the report shows >0 tests and 0 failures.
 *
 * Run from anywhere: `pnpm -w test:full` (extra args go to vitest, e.g. `-- --project unit`).
 * Read the result: `tail -5` of whatever you captured, or `test-results/vitest-summary.txt`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { suiteVerdict } from "./lib/suite-verdict.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = resolve(ROOT, "test-results");
const REPORT = resolve(OUT_DIR, "vitest.json");
const SUMMARY = resolve(OUT_DIR, "vitest-summary.txt");

mkdirSync(OUT_DIR, { recursive: true });
rmSync(REPORT, { force: true });
rmSync(SUMMARY, { force: true });

const vitest = resolve(ROOT, "node_modules/.bin/vitest");
const run = spawnSync(
	vitest,
	["run", "--reporter=default", "--reporter=json", `--outputFile.json=${REPORT}`, ...process.argv.slice(2)],
	{ cwd: ROOT, stdio: "inherit" },
);
if (run.error) console.error(`could not start vitest: ${run.error.message}`);

let report = null;
try {
	if (existsSync(REPORT)) report = JSON.parse(readFileSync(REPORT, "utf8"));
} catch {
	// Truncated or empty JSON is the same verdict as no file: the suite's result is unknown.
}

const v = suiteVerdict({ exitCode: run.status, report });
const lines = [
	"",
	...v.failedFiles.map((f) => `  FAILED  ${f.startsWith(ROOT) ? f.slice(ROOT.length + 1) : f}`),
	...v.reasons.map((r) => `  - ${r}`),
	`${v.ok ? "SUITE GREEN" : "SUITE RED"}  ${v.summary}`,
];
writeFileSync(SUMMARY, `${lines.join("\n").trimStart()}\n`);
console.log(lines.join("\n"));
process.exit(v.ok ? 0 : 1);
