/**
 * #1187 — a Grok run's completion claims are judged against what it actually ran.
 *
 * Before, the `grok` preset printed plain text, the pane held no tool calls, and every claim came back UNVERIFIED
 * ("this engine's tool calls are not observable") — on two live runs whose fixes GitHub CI later proved real. The
 * runner now reads Grok's `streaming-json` stream (packages/browser-runner/src/coding/grok-adapter.ts) and renders
 * each call into the pane exactly as it renders Claude's. The panes below are that rendering, byte for byte, as a
 * real Grok session produced it (grok-adapter.test.ts; a multi-line result continues under `  │ `,
 * transcript-lines.ts) — so the evidence check can now say supported or CONTRADICTED.
 */
import { describe, expect, it } from "vitest";
import { CompletionEvidence, judgeCompletion } from "./coding-completion-evidence.js";

const CLAIM = "Fixed the lint error. All tests pass and I pushed to main.";

const judge = (pane: string) => {
	const ev = new CompletionEvidence();
	ev.observe(pane);
	return { ev, j: judgeCompletion(CLAIM, ev) };
};
const statusOf = (j: ReturnType<typeof judgeCompletion>, claim: string) => j.verdicts.find((v) => v.claim === claim)?.status;

describe("the evidence check on a Grok run (#1187)", () => {
	it("BEFORE: a plain-text Grok pane shows no calls, so every claim is unverified — the reported failure", () => {
		const { ev, j } = judge("\n❯ [10:02:11] fix the lint error\nI fixed the lint error, ran the tests (all 42 pass) and pushed to main.\n");
		expect(ev.sawCalls).toBe(false);
		expect(statusOf(j, "tests_pass")).toBe("unverified");
		expect(j.verdicts.find((v) => v.claim === "tests_pass")?.why).toMatch(/not observable/);
	});

	it("NOW: the calls it ran are on the record, and a passing run and a push SUPPORT the claim", () => {
		const pane = [
			"\n❯ [10:02:11] fix the lint error",
			"[10:02:12] I'll run the tests, then push.",
			'⚙ Bash {"command":"pnpm test"}',
			"  ↳✓ Test Files  12 passed (12)",
			"  │ Tests  42 passed (42)",
			'⚙ Bash {"command":"git push origin main"}',
			"  ↳✓ To github.com:freeappstore-online/apps.git",
			"  │    1a2b3c4..5d6e7f8  main -> main",
			"[10:02:40] done",
		].join("\n");
		const { ev, j } = judge(pane);
		expect(ev.sawCalls).toBe(true);
		expect(statusOf(j, "tests_pass")).toBe("supported");
		expect(statusOf(j, "pushed")).toBe("supported");
	});

	it("NOW: a run whose last test command failed CONTRADICTS a claim that the tests pass", () => {
		const pane = [
			"\n❯ [10:02:11] fix the lint error",
			'⚙ Bash {"command":"pnpm test"}',
			"  ↳✗ Test Files  1 failed | 11 passed (12)",
			"  │ Tests  3 failed | 39 passed (42)",
			"[10:02:40] All tests pass.",
		].join("\n");
		const { j } = judge(pane);
		expect(statusOf(j, "tests_pass")).toBe("contradicted");
	});
});
