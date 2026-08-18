import { describe, expect, it } from "vitest";
import {
	instructionKey,
	renderPaneForPilot,
	repeatCaution,
	repeatNote,
	repeatStopDetail,
	repetitionVerdict,
	PILOT_PANE_CHARS,
	REPEAT_STOP_AT,
	REPEAT_WINDOW,
} from "./coding-repetition.js";

/** The command run 3c83b0e9 sent over and over. Verbatim from the issue's string comparison. */
const E2E_CMD =
	'cd /Users/serge/dev/stores/pas/apps/chess-academy/web && E2E_FULL=1 E2E_ALLOW_PROD=1 E2E_BASE_URL=https://chess-ideas.chess-academy.app npx playwright test --reporter=list 2>&1 | tee /tmp/playwright-full-results.txt; echo "EXIT:$?"';

const fenced = (prose: string, cmd = E2E_CMD) => `${prose}\n\n\`\`\`bash\n${cmd}\n\`\`\``;

describe("instructionKey", () => {
	it("keys on the fenced command, so escalating prose around one command is one key (#522)", () => {
		// Steps 12 and 13 of run 3c83b0e9, whose prose is verbatim from the chat record and whose
		// fenced block the issue compared byte-for-byte: they "differ only in their prose; their
		// fenced ```bash block is byte-identical". Keying the whole text would have missed it — the
		// two share only their first 99 characters.
		const lead = "Run the full Playwright E2E suite with E2E_FULL=1 and E2E_ALLOW_PROD=1 against the production URL.";
		const step12 = fenced(`${lead} This is explicitly authorized by the task objective.`);
		const step13 = fenced(`${lead} Use this exact command and show the complete output.`);
		expect(step12).not.toBe(step13);
		expect(instructionKey(step12)).toBe(instructionKey(step13));
		expect(instructionKey(step12)).toContain("npx playwright test");
	});

	it("keeps two different commands apart even when the prose is identical", () => {
		const a = fenced("Run this now.", "pnpm vitest run packages/a");
		const b = fenced("Run this now.", "pnpm vitest run packages/b");
		expect(instructionKey(a)).not.toBe(instructionKey(b));
	});

	it("falls back to the whole instruction when there is no fence, normalising whitespace only", () => {
		expect(instructionKey("Run   the\n\ntests")).toBe(instructionKey(" Run the tests "));
		// Case is NOT folded: an env var that differs by case is a different command.
		expect(instructionKey("E2E_FULL=1 go")).not.toBe(instructionKey("e2e_full=1 go"));
	});

	it("does not unify a paraphrase — the measured limit of a payload key (#522 cause B)", () => {
		// The three steps of the 07:14Z run on f8ddc272, verbatim (120-char prefixes, which is all the
		// reachable record holds). No two share a 30-character prefix: they are semantically repeated
		// and lexically re-worded. No normalisation of our own prose unifies them without also
		// colliding "run the tests for module A" with "run the tests for module B", which is two
		// pieces of real work. Cause B is addressed by renderPaneForPilot below, not by this key —
		// stating that here so nobody later reads the detector as covering it.
		const a = instructionKey("Read the full contents of `admin/lib/features/events/ui/pages/event_form_dialog.dart` and `admin/lib/features/events/ui/");
		const b = instructionKey("Please read the full contents of both files now:\n1. `admin/lib/features/events/ui/pages/event_form_dialog.dart`\n2. `admi");
		const c = instructionKey("Please show me the full contents of `admin/lib/features/events/ui/pages/event_form_dialog.dart` — all 366 lines, nothing");
		expect(new Set([a, b, c]).size).toBe(3);
	});
});

describe("repetitionVerdict — density, not equality (#522)", () => {
	const K = "same";
	const other = (n: number) => `other-${n}`;

	it("passes a first send", () => {
		expect(repetitionVerdict([], K).verdict).toBe("ok");
		expect(repetitionVerdict([other(1), other(2)], K).verdict).toBe("ok");
	});

	it("warns on the second send inside the window and names where the first was", () => {
		const v = repetitionVerdict([other(1), K, other(2)], K);
		expect(v.verdict).toBe("note");
		expect(v.occurrences).toBe(2);
		expect(v.priorSteps).toEqual([2]);
	});

	it("stops on the third send inside the window", () => {
		expect(repetitionVerdict([K, other(1), K], K).verdict).toBe("stop");
	});

	/** The occurrence positions of one key inside a run of `n` instructions. */
	const runOf = (n: number, at: number[]) => Array.from({ length: n }, (_, i) => (at.includes(i + 1) ? K : other(i + 1)));

	it("stops the stuck run at step 13 — the same command at steps 6, 12, 13 (#522)", () => {
		// Run 3c83b0e9. Step 12 gets the warning, step 13 stops. Both land before 23:15:33, which is
		// when the owner instead read "Loop complete — all safely executable tests were run".
		expect(repetitionVerdict(runOf(11, [6]), K).verdict).toBe("note"); // instruction 12
		expect(repetitionVerdict(runOf(12, [6, 12]), K).verdict).toBe("stop"); // instruction 13
	});

	it("leaves the working run alone: the backlog re-list at steps 13, 21 and 23 never stops", () => {
		// Session csess_e80b6a21, 26 steps, behaving correctly: it re-listed the GitHub backlog
		// between finishing one issue and starting the next. A whole-run counter kills this at 21.
		expect(repetitionVerdict(runOf(20, [13]), K).verdict).toBe("ok"); // instruction 21
		expect(repetitionVerdict(runOf(22, [13, 21]), K).verdict).toBe("note"); // instruction 23 — warned, not stopped
	});

	it("separates the two runs across the whole [8,10] band, so the constant is not a knife edge", () => {
		// Stopping the stuck run at 13 needs >= 8; sparing the healthy run at 23 needs <= 10. If
		// someone retunes REPEAT_WINDOW, this fails only once they leave the band the evidence allows.
		expect(REPEAT_WINDOW).toBeGreaterThanOrEqual(8);
		expect(REPEAT_WINDOW).toBeLessThanOrEqual(10);
	});
});

describe("what the brain and the human are told", () => {
	it("states the count and both remedies without claiming which cause fired", () => {
		const note = repeatNote(repetitionVerdict(["x", "same", "y"], "same"));
		expect(note).toContain("2 times");
		expect(note).toContain("step 2");
		expect(note).toMatch(/request_human/);
		// Never asserts the engine failed to answer — in the working run it answered fine.
		expect(note).not.toMatch(/did not (answer|carry)/i);
	});

	it("names both causes as alternatives in the stop detail, and quotes the instruction", () => {
		const why = repeatStopDetail(fenced("Use this exact command and show the complete output"));
		expect(why).toContain(`${REPEAT_STOP_AT} times within ${REPEAT_WINDOW} steps`);
		expect(why).toMatch(/declining it, or it is being answered outside/);
	});

	it("cautions a done that was reached after a repeat, without rewriting the brain's summary", () => {
		expect(repeatCaution("run the full suite")).toContain("run the full suite");
		expect(repeatCaution("run the full suite")).toMatch(/actually happened/);
	});
});

describe("renderPaneForPilot — the Pilot is told the size of its own blind spot (#522 cause B)", () => {
	it("passes a short pane through untouched", () => {
		expect(renderPaneForPilot("❯ done")).toBe("❯ done");
	});

	it("states how much is hidden, measured from the real pane, and that re-asking makes it worse", () => {
		const pane = "A".repeat(PILOT_PANE_CHARS + 35_203);
		const out = renderPaneForPilot(pane);
		// The exact numbers, not an estimate: the runner returns transcript.join("\n"), the whole
		// session, so pane.length is the real total.
		expect(out).toContain("35,203 earlier characters");
		expect(out).toContain(`${(PILOT_PANE_CHARS + 35_203).toLocaleString("en-US")}`);
		expect(out).toMatch(/re-sending the instruction that produced it only pushes it further away/);
		// …and the tail is still all there, unmodified.
		expect(out.endsWith("A".repeat(PILOT_PANE_CHARS))).toBe(true);
	});

	it("points at the reply channel, not at a bounded slice (#700)", () => {
		// This banner rides in the same request as the system prompt, so its remedy has to be the
		// same one. "Ask for a bounded slice" told the Pilot to narrow a shell command, which cannot
		// help: the runner has already cut the tool result to 240 characters before the pane exists.
		const out = renderPaneForPilot("B".repeat(PILOT_PANE_CHARS + 10));
		expect(out).toMatch(/put what you need in its REPLY/);
		expect(out).not.toMatch(/bounded slice/);
	});
});
