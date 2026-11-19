/**
 * #1517 — the evidence audit filed an unfiltered `pnpm test` as "a focused subset" and read a workflow id as a test count.
 *
 * Run 2bb43e1c reported `full suite: CONTRADICTED — the last run was a focused subset (/bin/zsh -lc 'pnpm test')`, though
 * the package's `test` script is exactly `vitest run`. Cause: engines run commands inside a shell wrapper, the runner
 * pattern reads to the end of the line, and the wrapper's CLOSING quote came back as the command's first argument — a lone
 * `'` that counted as a positional selector. Run bcd2576f's audit likewise took CI workflow id 41836264555 for a claimed
 * test count. Both are fixed at the parse; genuine false-success detection must survive, so the same file pins that too.
 */
import { describe, expect, it } from "vitest";
import { CompletionEvidence, judgeCompletion } from "./coding-completion-evidence.js";
import { testInvocations } from "./coding-scope-constraints.js";

const scopeOf = (command: string) => testInvocations(command).map((t) => t.scope);

describe("the scope of a test command typed inside a shell wrapper (#1517)", () => {
	it.each([
		`/bin/zsh -lc 'pnpm test'`,
		`/bin/zsh -lc "pnpm test"`,
		`bash -c 'pnpm test'`,
		`bash -lc "pnpm test"`,
		`sh -c 'pnpm test'`,
		`zsh -ic 'pnpm run test'`,
		`/bin/zsh -lc 'vitest run'`,
		`/bin/zsh -lc 'npx vitest run'`,
		`bash -lc 'cd workers/api && pnpm test'`,
		`/bin/zsh -lc 'pnpm test > /tmp/out.log 2>&1'`,
		`pnpm test`, // and unwrapped, as before
		`vitest run`,
	])("%s is the FULL suite", (command) => {
		expect(scopeOf(command)).toEqual(["full"]);
	});

	it.each([
		`/bin/zsh -lc 'pnpm test src/a.test.ts'`,
		`/bin/zsh -lc "pnpm test src/a.test.ts"`,
		`bash -c 'vitest run packages/x/y.test.ts'`,
		`/bin/zsh -lc 'pnpm exec vitest run workers/api/src/lib/foo.test.ts'`,
		`bash -lc 'pnpm test -t "export flow"'`,
		`bash -lc 'pnpm test -- -t "export flow"'`,
		`sh -c 'vitest run --project unit src/a.test.ts'`,
		`/bin/zsh -lc 'pnpm --filter @pags/api test'`,
		`/bin/zsh -lc 'pnpm test --shard=1/4'`,
	])("%s is a FOCUSED subset — a real filter is still read as one", (command) => {
		expect(scopeOf(command)).toEqual(["focused"]);
	});

	it("an option's value inside the wrapper is still consumed with it (a worker count selects nothing)", () => {
		expect(scopeOf(`/bin/zsh -lc 'pnpm test --maxWorkers 4'`)).toEqual(["full"]);
		expect(scopeOf(`bash -c "vitest run --reporter dot"`)).toEqual(["full"]);
	});

	it("only the wrapper's own quote is dropped: a quote that belongs to an argument still makes it focused", () => {
		expect(scopeOf(`bash -c 'pnpm test "src/a b.test.ts"'`)).toEqual(["focused"]);
	});

	it("a CUT command, whose wrapper never closes, is left as read and never throws", () => {
		expect(() => testInvocations(`/bin/zsh -lc 'pnpm test --reporter`)).not.toThrow();
		expect(testInvocations(`/bin/zsh -lc 'pnpm test`)[0].scope).toBe("full");
	});

	it("two invocations in one wrapper keep their own scope", () => {
		expect(scopeOf(`/bin/zsh -lc 'pnpm test src/a.test.ts && pnpm test'`)).toEqual(["focused", "full"]);
	});

	it("an unrelated -c with a CLOSED quote earlier in the line does not eat the command's arguments", () => {
		expect(scopeOf(`git -c user.name='x' log && pnpm test src/a.test.ts`)).toEqual(["focused"]);
		expect(scopeOf(`git -c core.pager='cat' log && pnpm test`)).toEqual(["full"]);
	});
});

const judge = (claim: string, pane: string) => {
	const ev = new CompletionEvidence();
	ev.observe(pane);
	return judgeCompletion(claim, ev);
};
const verdict = (j: ReturnType<typeof judgeCompletion>, claim: string) => j.verdicts.find((v) => v.claim === claim);
const paneFor = (command: string, ...output: string[]) =>
	["\n❯ [10:02:11] finish", `⚙ Bash ${JSON.stringify({ command })}`, ...output.map((l, i) => (i === 0 ? `  ↳✓ ${l}` : `  │ ${l}`)), "[10:02:40] done"].join("\n");
const FULL_OUTPUT = ["Test Files  12 passed (12)", "Tests  42 passed (42)"];

describe("the audit's verdict on 'the full suite passed' (#1517)", () => {
	it("THE REPORTED CASE: /bin/zsh -lc 'pnpm test' is not called a focused subset", () => {
		const j = judge("Ran the full suite and it passes.", paneFor(`/bin/zsh -lc 'pnpm test'`, ...FULL_OUTPUT));
		const v = verdict(j, "full_suite");
		expect(v?.status).not.toBe("contradicted");
		expect(v?.status).toBe("supported");
		expect(v?.why).not.toMatch(/focused subset/);
	});

	it("truncated or absent test output is UNVERIFIED evidence of the count, never contradicting evidence of the scope", () => {
		const j = judge("Ran the full suite, all 42 tests pass.", paneFor(`/bin/zsh -lc 'pnpm test'`, "…output cut…"));
		expect(verdict(j, "full_suite")?.status).not.toBe("contradicted");
		expect(verdict(j, "test_count")?.status).toBe("unverified");
	});

	it("a cut COMMAND is unknown, not a focused subset", () => {
		const j = judge("The full suite passes.", paneFor(`/bin/zsh -lc 'pnpm test --reporter`, ...FULL_OUTPUT).replace('{"command"', '{"command"'));
		expect(verdict(j, "full_suite")?.status).not.toBe("contradicted");
	});

	it("GENUINE false success is still caught: a wrapped, filtered run does not support 'the full suite'", () => {
		for (const command of [`/bin/zsh -lc 'pnpm test src/a.test.ts'`, `bash -c 'vitest run packages/x/y.test.ts'`, `pnpm test src/a.test.ts`]) {
			const v = verdict(judge("Ran the full suite and it passes.", paneFor(command, "Test Files  1 passed (1)", "Tests  3 passed (3)")), "full_suite");
			expect(v?.status, command).toBe("contradicted");
			expect(v?.why, command).toMatch(/focused subset/);
		}
	});

	it("GENUINE false success is still caught: a failing wrapped run contradicts 'the tests pass'", () => {
		const pane = ["\n❯ [10:02:11] finish", `⚙ Bash ${JSON.stringify({ command: "/bin/zsh -lc 'pnpm test'" })}`, "  ↳✗ Test Files  1 failed | 11 passed (12)", "  │ Tests  3 failed | 39 passed (42)", "[10:02:40] done"].join("\n");
		expect(verdict(judge("All tests pass.", pane), "tests_pass")?.status).toBe("contradicted");
	});
});

describe("an identifier is not a claimed test count (#1517)", () => {
	const countVerdict = (claim: string) => verdict(judge(claim, paneFor(`/bin/zsh -lc 'pnpm test'`, ...FULL_OUTPUT)), "test_count");

	it.each([
		"CI run 41850914402 passed.",
		"The full suite is green and workflow 41836264555 passed.",
		"GitHub Actions run 41850914402 passed after the push.",
		"Verified: job #123456 passed.",
		"workflow run id: 98765 passed.",
		"41836264555 passed", // eleven digits cannot be a test count, whatever precedes it
	])("%s claims no test count", (claim) => {
		expect(countVerdict(claim)).toBeUndefined();
	});

	it("a real count is still read, and still checked against what the run printed", () => {
		expect(countVerdict("All 42 tests pass.")?.status).toBe("supported");
		expect(countVerdict("376 tests passed.")?.status).toBe("contradicted");
		expect(countVerdict("CI: 42 tests passed.")?.status).toBe("supported");
		expect(countVerdict("The full suite is green; workflow 41836264555 passed and all 42 tests pass.")?.status).toBe("supported");
	});

	it("a count with thousands separators survives, and an absurd one does not", () => {
		expect(countVerdict("1,234 tests passed.")).toBeDefined();
		expect(countVerdict("98,765,432,109 tests passed.")).toBeUndefined();
	});
});
