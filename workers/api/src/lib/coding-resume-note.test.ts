/**
 * What a run started after a platform interruption is told (#523, item 4).
 *
 * The decision under test is "given what the last run was observed to do, what should the next one
 * be told" — a value, so it is tested as one. WHICH run it is about is not a value, and a stub
 * cannot test it: the lookup once asked `session_id = ?` and this file's stub answered regardless,
 * while the real successor was on a new session and was briefed about nothing (#806). That half is
 * pinned against the real schema in `coding-resume-note-repo.test.ts`.
 *
 * The dangerous output is a note asserting "this is already done" about something that is NOT, so
 * most of this file is about the three states of `ok` (#594).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lastUnfinishedRunForRepo, RESUMABLE_STOP_REASONS, type LoopRunRow } from "./agent-loop-store.js";
import { MAX_ACT_CHARS, MAX_LISTED_ACTS, codingResumeNote } from "./coding-resume-note.js";
import type { ActItem } from "./instance-work.js";
import type { LoopStopReason } from "./agent-loop.js";
import type { Env } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The pre-#806 note: every case below this block was written against a platform interruption. */
const interruptedNote = (acts: ActItem[]) => codingResumeNote(acts, "interrupted");

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
		expect(interruptedNote([])).toBeNull();
	});

	it("returns null when every act FAILED", () => {
		// "Attempted and failed" is not progress to preserve. A run told to skip it would skip the
		// retry that fixes it.
		expect(interruptedNote([act({ ok: false }), act({ ok: false })])).toBeNull();
	});
});

describe("what it claims as already done", () => {
	it("names the landed acts and forbids repeating them", () => {
		const note = interruptedNote([act({ summary: "pushed directly to the trunk origin main" })]);
		expect(note).toContain("Already done — do NOT do these again:");
		expect(note).toContain("- pushed directly to the trunk origin main");
	});

	it("says the platform interrupted the run, not that the objective failed", () => {
		// This ticket's opening complaint, one level down: the successor must not be told its
		// predecessor failed, because it did not.
		const note = interruptedNote([act()]) ?? "";
		expect(note).toContain("interrupted by the platform");
		expect(note).toContain("It was not your objective failing");
		expect(note).not.toMatch(/\bfailed\b(?!.*objective)/);
	});

	it("tells the run to check the repo and continue rather than start over", () => {
		// The whole point of the checkpoint: #523's run closed ten issues, and restarting from the
		// objective would have re-implemented all ten.
		const note = interruptedNote([act()]) ?? "";
		expect(note).toContain("continue from there rather than starting the objective over");
	});

	it("NEVER lists an act that failed, even beside ones that landed", () => {
		// The inversion that would make this feature dangerous: a failed push presented as done.
		const note =
			interruptedNote([
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
		const note = interruptedNote([act({ ok: null }), act({ ok: null })]) ?? "";
		expect(note).toContain("2 further actions were attempted whose outcome was never observed");
		expect(note).toContain("VERIFY them against the repository before repeating them");
		// It must NOT have claimed them as done.
		expect(note).not.toContain("Already done");
	});

	it("reads correctly for exactly one", () => {
		const note = interruptedNote([act({ ok: null })]) ?? "";
		expect(note).toContain("1 further action was attempted");
		expect(note).toContain("VERIFY it against the repository before repeating it");
	});

	it("produces a note when unobserved acts are the ONLY acts", () => {
		// Progress that may have landed is still progress worth warning about — the gate is
		// "nothing could have landed", not "nothing was confirmed".
		expect(interruptedNote([act({ ok: null })])).not.toBeNull();
	});

	it("reports both halves when the run has landed AND unobserved acts", () => {
		const note = interruptedNote([act({ ok: true }), act({ ok: null, summary: "opened pull request #9" })]) ?? "";
		expect(note).toContain("Already done");
		expect(note).toContain("1 further action was attempted");
		expect(note).not.toContain("- opened pull request #9");
	});
});

describe("it stays bounded — this text is prepended to every prompt of the resumed run", () => {
	it(`lists at most ${MAX_LISTED_ACTS} acts and counts the rest`, () => {
		const note = interruptedNote(Array.from({ length: 15 }, (_, i) => act({ summary: `pushed commit ${i}` }))) ?? "";
		const listed = note.split("\n").filter((l) => l.startsWith("- pushed commit "));
		expect(listed).toHaveLength(MAX_LISTED_ACTS);
		expect(note).toContain(`…and ${15 - MAX_LISTED_ACTS} more actions of the same kind.`);
	});

	it("says 'action' rather than 'actions' when exactly one is elided", () => {
		const note = interruptedNote(Array.from({ length: MAX_LISTED_ACTS + 1 }, (_, i) => act({ summary: `c${i}` }))) ?? "";
		expect(note).toContain("…and 1 more action of the same kind.");
	});

	it("does not add an elision line when everything fits", () => {
		const note = interruptedNote([act(), act()]) ?? "";
		expect(note).not.toContain("more action");
	});

	it("truncates a long summary rather than carrying 200 characters of it", () => {
		const note = interruptedNote([act({ summary: "x".repeat(300) })]) ?? "";
		const line = note.split("\n").find((l) => l.startsWith("- x")) ?? "";
		// The "- " prefix is not part of the act's own budget.
		expect(line.length - 2).toBeLessThanOrEqual(MAX_ACT_CHARS);
		expect(line).toMatch(/…$/);
	});

	it("leaves a summary that already fits completely alone", () => {
		const note = interruptedNote([act({ summary: "pushed to main" })]) ?? "";
		expect(note).toContain("- pushed to main");
		expect(note).not.toContain("…");
	});
});

describe("#806 — the other endings that leave work half-done without a verdict", () => {
	it("keeps the interrupted note's opening byte for byte", () => {
		// The pre-#806 sentence. Widening the gate must not quietly reword what #523 shipped. One word
		// moved on purpose — "session" → "repository" — when the lookup was re-keyed on the repo.
		expect((interruptedNote([act()]) ?? "").split("\n")[0]).toBe(
			"PLATFORM NOTE (not from the human): a previous run on this repository was interrupted by the platform before it could report. It was not your objective failing, and it did not finish — but the work below had ALREADY landed and is on the record.",
		);
	});

	it.each([
		["max_iterations", "used up its step limit"],
		["engine_limit", "the coding CLI's own usage limit had not reset in time"],
		["provider_credit", "the owner's AI provider account ran out of credit"],
	] as const)("names the TRUE cause for %s — never 'interrupted by the platform'", (reason, cause) => {
		const note = codingResumeNote([act()], reason) ?? "";
		expect(note).toContain(cause);
		expect(note).not.toContain("interrupted by the platform");
		// The two things every successor must not get wrong, whatever ended its predecessor.
		expect(note).toContain("It was not your objective failing, and it did not finish");
		expect(note).toContain("Already done — do NOT do these again:");
		expect(note).toContain("continue from there rather than starting the objective over");
		expect(note).not.toMatch(/\bfailed\b(?!.*objective)/);
	});

	it("gives every resumable stop reason its own opening", () => {
		const openings = RESUMABLE_STOP_REASONS.map((r) => (codingResumeNote([act()], r) ?? "").split("\n")[0]);
		expect(new Set(openings).size).toBe(RESUMABLE_STOP_REASONS.length);
	});
});

describe("#806 — work the predecessor left uncommitted is not an act, and is still worth a note", () => {
	it("briefs a successor whose predecessor pushed NOTHING but left files in the tree", () => {
		// #806's own incident: cut off at step 4 of 20, a good partial fix on disk, no act on record.
		const note = codingResumeNote([], "max_iterations", 3) ?? "";
		expect(note).toContain("a previous run on this repository used up its step limit");
		expect(note).toContain("The working tree holds 3 uncommitted files right now.");
		expect(note).toContain("READ the diff before you write anything");
	});

	it("claims NOTHING landed when nothing did — the 'already landed' opening would be false", () => {
		const note = codingResumeNote([act({ ok: false })], "interrupted", 2) ?? "";
		expect(note.split("\n")[0]).toContain("and nothing it did is on the record as landed.");
		expect(note).not.toContain("ALREADY landed");
		expect(note).not.toContain("Already done");
		expect(note).not.toContain("treat the listed work as done");
		expect(note).toContain("continue from what is there rather than starting the objective over");
	});

	it("never says the previous run WROTE the files — the platform saw the tree, not the author", () => {
		const note = codingResumeNote([], "interrupted", 1) ?? "";
		expect(note).toContain("The platform did not see who wrote it, but it may be that run's unfinished work");
		expect(note).not.toMatch(/(that|previous) run (wrote|left|made)/);
	});

	it("agrees with the REPOSITORY STATE instruction beside it: build on it, never discard it", () => {
		// `interrupted`, because `engine_limit`'s own opening says the usage limit "had not reset".
		const note = codingResumeNote([], "interrupted", 4) ?? "";
		expect(note).toContain("Do NOT discard it.");
		expect(note).not.toMatch(/\b(stash|reset|revert|clean)\b/i);
	});

	it("reads correctly for exactly one file", () => {
		expect(codingResumeNote([], "interrupted", 1)).toContain("holds 1 uncommitted file right now");
	});

	it("adds the clause to a note that ALSO has landed acts, and leaves the rest of it alone", () => {
		const clean = codingResumeNote([act()], "interrupted") ?? "";
		const dirty = codingResumeNote([act()], "interrupted", 2) ?? "";
		expect(dirty.split("\n")[0]).toBe(clean.split("\n")[0]);
		expect(dirty).toContain("Already done — do NOT do these again:");
		expect(dirty).toContain("The working tree holds 2 uncommitted files right now.");
		expect(dirty).toContain("treat the listed work as done");
	});

	it("says nothing about a clean tree — the note is byte-identical to the one before #806", () => {
		expect(codingResumeNote([act()], "interrupted", 0)).toBe(codingResumeNote([act()], "interrupted"));
		expect(codingResumeNote([], "interrupted", 0)).toBeNull();
	});
});

describe("the gate — which predecessor a run is briefed about", () => {
	function envWith(row: Partial<LoopRunRow> | null) {
		const binds: unknown[][] = [];
		const env = {
			DB: {
				prepare: () => ({
					bind: (...args: unknown[]) => {
						binds.push(args);
						return { first: async () => (row ? ({ run_id: "run-a", instance_id: "inst-1", started_at: 1, finished_at: 2, cancel_requested: 0, ...row } as LoopRunRow) : null) };
					},
				}),
			},
		} as unknown as Env;
		return { env, binds };
	}

	it.each(["interrupted", "max_iterations", "engine_limit", "provider_credit"] as const)("briefs the successor of a run that ended %s", async (reason) => {
		const { env } = envWith({ stop_reason: reason });
		const prev = await lastUnfinishedRunForRepo(env, "u1", "inst-1", "sess-1");
		expect(prev?.stopReason).toBe(reason);
		expect(prev?.runId).toBe("run-a");
	});

	it.each(["done", "failed", "escalated", "cancelled", "no_progress", "budget"] as const satisfies readonly LoopStopReason[])(
		"does NOT brief the successor of a run that ended %s — a verdict or a human's choice",
		async (reason) => {
			const { env } = envWith({ stop_reason: reason });
			expect(await lastUnfinishedRunForRepo(env, "u1", "inst-1", "sess-1")).toBeNull();
		},
	);

	it("briefs nobody when the session has no finished run in the window", async () => {
		const { env } = envWith(null);
		expect(await lastUnfinishedRunForRepo(env, "u1", "inst-1", "sess-1")).toBeNull();
	});

	it("still reads only the IMMEDIATE predecessor — a verdict in between ends the note's job", async () => {
		// The query takes the newest finished run and THEN judges it; it never asks SQL for the newest
		// resumable one, which would re-brief run C on run A's already-consumed checkpoint.
		const { env } = envWith({ stop_reason: "done" });
		expect(await lastUnfinishedRunForRepo(env, "u1", "inst-1", "sess-1")).toBeNull();
		const source = readFileSync(join(__dirname, "agent-loop-store.ts"), "utf8");
		const fn = source.slice(source.indexOf("export async function lastUnfinishedRunForRepo"));
		expect(fn.slice(0, fn.indexOf("\n}\n"))).not.toMatch(/stop_reason\s*(=|IN)/i);
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
		expect(source).toContain("pendingCodingResumeNote(env, { userId, instanceId, sessionId, uncommittedFiles: repair ? 0 : (repoState?.changedFiles ?? 0) })");
	});

	it("hands it the start-of-run tree count — and none to a repair run, whose brief already carries it (#806, #804)", () => {
		expect(source).toContain("uncommittedFiles: repair ? 0 : (repoState?.changedFiles ?? 0)");
		// Read BEFORE the note is asked for: the count is `repo-state-start`'s, not a second read.
		expect(source.indexOf('step.do("repo-state-start"')).toBeLessThan(source.indexOf('step.do("resume-note"'));
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
