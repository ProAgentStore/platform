/**
 * #1390 — what makes closing conditional, found in the run's own words. The patterns are narrow on purpose: each fires on a phrase that plainly
 * gates or forbids closing, and the quoted sentence is what a reader of the decision sees.
 */
import { describe, expect, it } from "vitest";
import { closesSomething, closingGate, mentionsClosing } from "./question-objective-constraints.js";

describe("closingGate", () => {
	it.each([
		["the incident's objective", "Work #243. Close #243 only if all three are green (CI, deploy, and a dispatched production E2E); otherwise leave it open and report what failed.", "Close #243 only if all three are green"],
		["the incident's hint", "Close #243 only when the production E2E is fully green.", "Close #243 only when the production E2E is fully green."],
		["close ... unless", "Close the issue unless the deploy fails.", "Close the issue unless the deploy fails."],
		["only close", "Only close it after review.", "Only close it after review."],
		["do not close", "Do not close #12 — I will.", "Do not close #12"],
		["don't close yet", "Don't close it yet.", "Don't close it yet."],
		["never close", "Never close an issue without a linked PR.", "Never close an issue"],
		["must not close", "You must not close the ticket.", "must not close the ticket"],
		["leave it open", "If anything fails, leave it open.", "leave it open"],
		["keep open", "Keep #99 open until Friday.", "Keep #99 open"],
		["close when green", "Close #5 once CI passes.", "Close #5 once CI passes."],
	])("finds it: %s", (_name, text, quoted) => {
		const gate = closingGate([text]);
		expect(gate).not.toBeNull();
		expect(gate).toContain(quoted);
	});

	it.each([
		["an unconditional close", "Implement the export and close #243 when done."],
		["no mention of closing", "Fix the flaky test and open a PR."],
		["empty", ""],
		["a different 'open'", "Open a PR against main."],
		["closing a PR is not in a gate sentence of its own", "Refactor the loader."],
	])("does not fire on %s", (_name, text) => {
		expect(closingGate([text])).toBeNull();
	});

	it("reads the texts in order and returns the first sentence that gates, ignoring blanks and non-strings", () => {
		expect(closingGate([undefined, null, "", "Plain objective.", "Do not close #7."])).toBe("Do not close #7.");
		expect(closingGate([])).toBeNull();
	});

	it("quotes a long sentence clipped and marked, never whole", () => {
		const gate = closingGate([`Close #1 only if ${"everything is green and ".repeat(40)}done.`]) ?? "";
		expect(gate.length).toBeLessThanOrEqual(200);
		expect(gate).toMatch(/\[cut: showing the first \d+ of \d+ characters\]$/);
	});
});

describe("closesSomething and mentionsClosing", () => {
	it("an option that says it closes does", () => {
		for (const o of ["Close #243", "close it and file a separate issue", "Closing #243 as done", "Resolve the issue as fixed"]) expect(closesSomething(o, "What now?"), o).toBe(true);
	});

	it("leaving open, waiting, and an option that says NOT to close do not", () => {
		for (const o of ["Leave #243 open and report what failed", "Do not close #243", "Don't close it", "Wait for the re-run", "File a new issue instead of closing this one", "Keep it open"]) {
			expect(closesSomething(o, "What now?"), o).toBe(false);
		}
	});

	it("a bare yes closes only when the QUESTION asked whether to close", () => {
		expect(closesSomething("Yes", "Should I close #243?")).toBe(true);
		expect(closesSomething("Proceed", "Close #243 now?")).toBe(true);
		expect(closesSomething("No", "Should I close #243?")).toBe(false);
		expect(closesSomething("Yes", "Should I use the compact layout?")).toBe(false);
	});

	it("mentionsClosing ignores a negated clause", () => {
		expect(mentionsClosing("Please close #1")).toBe(true);
		expect(mentionsClosing("do not close #1")).toBe(false);
		expect(mentionsClosing("without closing it")).toBe(false);
		expect(mentionsClosing("no closing words here")).toBe(true); // 'closing' as a word is a mention; the gate decides what to do about it
	});
});
