/**
 * suite-verdict.mjs — decide whether a full vitest run is green from evidence, not from
 * an exit code alone (#920).
 *
 * The false green this exists for: `pnpm test` run from a workspace package that has no
 * `test` script (e.g. `workers/api`) does not fail. pnpm falls back to `pnpm exec test`,
 * which finds the POSIX `test` utility — so `pnpm test --reporter=verbose` exits 0 and
 * `pnpm test` exits 1, both with ZERO bytes of output. Add zsh (where `$PIPESTATUS` is
 * empty) and `cmd | tee log; echo $?` (which reports tee's status, not cmd's) and a run
 * that never executed one test reads as "exit 0, all passed".
 *
 * So green requires all of: vitest wrote its JSON report, the report counts more than
 * zero tests, nothing in it failed, and the exit code agrees. Any one missing is red.
 */

/**
 * @param {{ exitCode: number | null, report: any }} run
 *   `report` is the parsed `--reporter=json` output, or null if the file was missing,
 *   empty, or not JSON.
 * @returns {{ ok: boolean, summary: string, reasons: string[], failedFiles: string[] }}
 */
export function suiteVerdict({ exitCode, report }) {
	const reasons = [];
	if (!report || typeof report !== "object") {
		reasons.push("no vitest JSON report was written — the suite did not run (or its output was lost)");
		if (exitCode !== 0) reasons.push(`vitest exited ${exitCode}`);
		return { ok: false, summary: "no report", reasons, failedFiles: [] };
	}

	const tests = {
		total: report.numTotalTests ?? 0,
		passed: report.numPassedTests ?? 0,
		failed: report.numFailedTests ?? 0,
	};
	const failedFiles = (report.testResults ?? []).filter((r) => r.status === "failed").map((r) => r.name);
	// Files from `testResults` (one entry per file). `numTotalTestSuites` counts describe
	// blocks too, so it does not match the "Test Files" line vitest prints.
	const files = { total: report.testResults?.length ?? 0, failed: failedFiles.length };
	const summary =
		`Test Files  ${files.failed} failed | ${files.total - files.failed} passed (${files.total})` +
		` · Tests  ${tests.failed} failed | ${tests.passed} passed (${tests.total})`;

	if (tests.total === 0) reasons.push("the report counts 0 tests — nothing was collected (wrong cwd or include glob?)");
	if (tests.failed > 0 || files.failed > 0 || report.success === false) reasons.push("the report records failures");
	if (exitCode !== 0) reasons.push(`vitest exited ${exitCode}`);
	else if (reasons.length > 0) reasons.push("vitest exited 0 despite the above — the exit code alone would have been a false green");

	return { ok: reasons.length === 0, summary, reasons, failedFiles };
}
