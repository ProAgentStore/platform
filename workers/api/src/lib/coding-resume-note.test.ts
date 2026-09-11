/**
 * What a run started after a platform interruption is told (#523, item 4).
 *
 * The decision under test is "given what the last run was observed to do, what should the next one
 * be told" — a value, so it is tested as one. The two D1 reads that feed it are a thin
 * read-and-delegate (`pendingCodingResumeNote`) with no ordering to get wrong; the judgement worth
 * pinning is all here.
 *
 * The dangerous output is a note asserting "this is already done" about something that is NOT, so
 * most of this file is about the three states of `ok` (#594).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_ACT_CHARS, MAX_LISTED_ACTS, codingResumeNote } from "./coding-resume-note.js";
import type { ActItem } from "./instance-work.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function act(over: Partial<ActItem> = {}): ActItem {
	return {
		instanceId: "inst-1",
		kind: "push.trunk",
		summary: "pushed directly to the trunk origin main",
		ok: true,
		command: "git push origin main",
		irreversible: true,
		traceId: "run-1",
		at: 1_700_000_000_000,
		...over,
	};
}

describe("when there is nothing worth saying", () => {
	it("returns null for no acts at all", () => {
		// The common case on every ordinary start. A note saying "nothing landed" would be prompt
		// noise on every run that never had a predecessor.
		expect(codingResumeNote([])).toBeNull();
	});

	it("returns null when every act FAILED", () => {
		// "Attempted and failed" is not progress to preserve. A run told to skip it would skip the
		// retry that fixes it.
		expect(codingResumeNote([act({ ok: false }), act({ ok: false })])).toBeNull();
	});
});

describe("what it claims as already done", () => {
	it("names the landed acts and forbids repeating them", () => {
		const note = codingResumeNote([act({ summary: "pushed directly to the trunk origin main" })]);
		expect(note).toContain("Already done — do NOT do these again:");
		expect(note).toContain("- pushed directly to the trunk origin main");
	});

	it("says the platform interrupted the run, not that the objective failed", () => {
		// This ticket's opening complaint, one level down: the successor must not be told its
		// predecessor failed, because it did not.
		const note = codingResumeNote([act()]) ?? "";
		expect(note).toContain("interrupted by the platform");
		expect(note).toContain("It was not your objective failing");
		expect(note).not.toMatch(/\bfailed\b(?!.*objective)/);
	});

	it("tells the run to check the repo and continue rather than start over", () => {
		// The whole point of the checkpoint: #523's run closed ten issues, and restarting from the
		// objective would have re-implemented all ten.
		const note = codingResumeNote([act()]) ?? "";
		expect(note).toContain("continue from there rather than starting the objective over");
	});

	it("NEVER lists an act that failed, even beside ones that landed", () => {
		// The inversion that would make this feature dangerous: a failed push presented as done.
		const note =
			codingResumeNote([
				act({ summary: "pushed directly to the trunk origin main", ok: true }),
				act({ summary: "merged pull request #4", ok: false }),
			]) ?? "";
		expect(note).toContain("pushed directly to the trunk origin main");
		expect(note).not.toContain("merged pull request #4");
	});
});

describe("acts whose outcome was never observed", () => {
	it("counts them, and asks for verification instead of asserting them", () => {
		// `ok: null` is a real third state — only a stream-json engine reports an outcome at all —
		// and collapsing it into either neighbour is the #594 inversion.
		const note = codingResumeNote([act({ ok: null }), act({ ok: null })]) ?? "";
		expect(note).toContain("2 further actions were attempted whose outcome was never observed");
		expect(note).toContain("VERIFY them against the repository before repeating them");
		// It must NOT have claimed them as done.
		expect(note).not.toContain("Already done");
	});

	it("reads correctly for exactly one", () => {
		const note = codingResumeNote([act({ ok: null })]) ?? "";
		expect(note).toContain("1 further action was attempted");
		expect(note).toContain("VERIFY it against the repository before repeating it");
	});

	it("produces a note when unobserved acts are the ONLY acts", () => {
		// Progress that may have landed is still progress worth warning about — the gate is
		// "nothing could have landed", not "nothing was confirmed".
		expect(codingResumeNote([act({ ok: null })])).not.toBeNull();
	});

	it("reports both halves when the run has landed AND unobserved acts", () => {
		const note = codingResumeNote([act({ ok: true }), act({ ok: null, summary: "opened pull request #9" })]) ?? "";
		expect(note).toContain("Already done");
		expect(note).toContain("1 further action was attempted");
		expect(note).not.toContain("- opened pull request #9");
	});
});

describe("it stays bounded — this text is prepended to every prompt of the resumed run", () => {
	it(`lists at most ${MAX_LISTED_ACTS} acts and counts the rest`, () => {
		const note = codingResumeNote(Array.from({ length: 15 }, (_, i) => act({ summary: `pushed commit ${i}` }))) ?? "";
		const listed = note.split("\n").filter((l) => l.startsWith("- pushed commit "));
		expect(listed).toHaveLength(MAX_LISTED_ACTS);
		expect(note).toContain(`…and ${15 - MAX_LISTED_ACTS} more actions of the same kind.`);
	});

	it("says 'action' rather than 'actions' when exactly one is elided", () => {
		const note = codingResumeNote(Array.from({ length: MAX_LISTED_ACTS + 1 }, (_, i) => act({ summary: `c${i}` }))) ?? "";
		expect(note).toContain("…and 1 more action of the same kind.");
	});

	it("does not add an elision line when everything fits", () => {
		const note = codingResumeNote([act(), act()]) ?? "";
		expect(note).not.toContain("more action");
	});

	it("truncates a long summary rather than carrying 200 characters of it", () => {
		const note = codingResumeNote([act({ summary: "x".repeat(300) })]) ?? "";
		const line = note.split("\n").find((l) => l.startsWith("- x")) ?? "";
		// The "- " prefix is not part of the act's own budget.
		expect(line.length - 2).toBeLessThanOrEqual(MAX_ACT_CHARS);
		expect(line).toMatch(/…$/);
	});

	it("leaves a summary that already fits completely alone", () => {
		const note = codingResumeNote([act({ summary: "pushed to main" })]) ?? "";
		expect(note).toContain("- pushed to main");
		expect(note).not.toContain("…");
	});
});

describe("the wiring — the defect a unit test of this module cannot see", () => {
	// A note composed perfectly and never injected is this ticket's bug intact. The ONE caller is a
	// Workflow, and a Workflow can only be tested by running one, so the call shape is asserted from
	// source — the way `coding-run-report.test.ts` and `coding-resume.test.ts` assert theirs.
	const source = readFileSync(join(__dirname, "..", "workflows", "coding-session.ts"), "utf8");

	it("read the workflow at all — so a rename fails loudly instead of passing empty", () => {
		expect(source.length, "read no workflow source — this guard is measuring nothing").toBeGreaterThan(10_000);
	});

	it("asks for the note, in its own durable step", () => {
		expect(source).toContain('step.do("resume-note"');
		expect(source).toContain("pendingCodingResumeNote(env, { userId, instanceId, sessionId })");
	});

	it("injects it through goal.resumeNote — the existing platform-voice channel", () => {
		// NOT `userHint`, which renders as "The user just told you:". Attributing a platform action
		// to the human is exactly what #505 stamps reports for, and `CodingGoal.resumeNote` says so.
		expect(source).toContain("if (resumeNote) goal.resumeNote = resumeNote;");
		expect(source).not.toContain("goal.userHint = resumeNote");
	});

	it("sets it BEFORE the round loop, which is what clears it after round 0", () => {
		// `goal.resumeNote = undefined` runs after every round, so a note assigned after the loop
		// starts would be wiped before any brain ever read it. Order is the whole correctness here.
		// Matched on the loop's OPENING, not its whole condition: #801 added `&& !syncGate.blocked`
		// to it, and this assertion is about where the assignment sits relative to the loop — not
		// about what the loop tests. An `indexOf` of a full condition silently returns -1 when
		// someone edits it, which reads as "the assignment is after the loop" and fails for the
		// wrong reason.
		expect(source.indexOf("if (resumeNote) goal.resumeNote = resumeNote;")).toBeLessThan(source.indexOf("for (let round = 0; round < 12"));
		expect(source).toContain("goal.resumeNote = undefined;");
	});

	it("records it on the timeline, so a checkpoint that fired is visible", () => {
		// A checkpoint nobody can see is indistinguishable from one that never fired — and this is
		// the run whose predecessor's own report was lost.
		expect(source).toContain("if (resumeNote) await appendTimeline(env, { sessionId, instanceId, userId, type: \"brain\", content: resumeNote });");
	});
});
