/**
 * What the owner is told a Continue would carry forward (#806 item 2).
 *
 * The three-way answer is the whole point of this module, so most of what follows is about which
 * of the three a given checkpoint produces — in particular the two that look like success and are
 * not: a predecessor that exists but left nothing worth saying, and a predecessor that is a
 * DIFFERENT run from the one the owner is looking at. Both render as a Continue button today, and
 * both mean the button is a restart with a fresh budget.
 *
 * The tree assertions are here for the same reason the field is tri-state: `0` and "we could not
 * look" are different claims, and this surface exists because the platform kept making the first
 * one when it only had grounds for the second.
 */
import { describe, expect, it } from "vitest";
import type { ActItem } from "./instance-work.js";
import type { ResumeCheckpoint } from "./coding-resume-note.js";
import {
	CONTINUE_PREVIEW_TREE_UNAVAILABLE,
	MAX_PREVIEW_ACTS,
	continueBriefingPreview,
	continueBriefingSentence,
} from "./loop-continue-preview.js";

const act = (summary: string, ok: boolean | null = true): ActItem =>
	({ instanceId: "inst-1", kind: "push.trunk", summary, ok }) as ActItem;

const checkpoint = (over: Partial<ResumeCheckpoint> = {}): ResumeCheckpoint => ({
	predecessorRunId: "run-1",
	predecessorSessionId: "csess_a",
	endedBy: "max_iterations",
	landed: [act("pushed 3 commits to main")],
	unobserved: [],
	uncommittedFiles: 0,
	note: "PLATFORM NOTE (not from the human): …",
	...over,
});

const READ = { files: 0, read: "read" } as const;
const BLIND = { files: null, read: "unavailable" } as const;

describe("which run the briefing would be about", () => {
	it("names `this-run` when the checkpoint is about the run the owner asked about", () => {
		const p = continueBriefingPreview("run-1", checkpoint(), READ);
		expect(p.kind).toBe("this-run");
		expect(p.predecessorRunId).toBe("run-1");
		expect(p.landed).toEqual(["pushed 3 commits to main"]);
	});

	it("names `other-run` when a MORE RECENT stopped run is the immediate predecessor", () => {
		// `lastUnfinishedRunForRepo` takes the newest finished run on the repo, so an owner
		// pressing Continue on an older one gets a briefing about the newer. That is correct — the
		// checkpoint must not be handed out twice — but it is invisible from the UI, and the
		// owner's mental model ("continue THIS run") is wrong in a way that changes what they do.
		const p = continueBriefingPreview("run-1", checkpoint({ predecessorRunId: "run-9" }), READ);
		expect(p.kind).toBe("other-run");
		expect(p.predecessorRunId).toBe("run-9");
	});

	it("names `none` when there is no checkpoint at all", () => {
		// A verdict run in between ends the note's job, and so does a predecessor outside the
		// lookback. Either way the new run starts from the bare objective.
		const p = continueBriefingPreview("run-1", null, READ);
		expect(p.kind).toBe("none");
		expect(p.predecessorRunId).toBeNull();
		expect(p.note).toBeNull();
		expect(p.landed).toEqual([]);
	});

	it("names `none` when a predecessor EXISTS but left nothing worth saying", () => {
		// The distinct state `pendingCodingResumeCheckpoint` exists to expose: `codingResumeNote`
		// returned null (nothing landed, clean tree) while the row itself is real. "What would it
		// carry forward" is still nothing, so the kind is `none` — but the run is still named,
		// because "there was a predecessor and it had done nothing yet" is a different thing for an
		// owner to read than "there was no predecessor".
		const p = continueBriefingPreview("run-1", checkpoint({ landed: [], note: null }), READ);
		expect(p.kind).toBe("none");
		expect(p.predecessorRunId).toBe("run-1");
		expect(p.note).toBeNull();
	});
});

describe("what it says landed", () => {
	it("lists the landed summaries and counts the overflow", () => {
		const landed = Array.from({ length: MAX_PREVIEW_ACTS + 4 }, (_, i) => act(`push ${i}`));
		const p = continueBriefingPreview("run-1", checkpoint({ landed }), READ);
		expect(p.landed).toHaveLength(MAX_PREVIEW_ACTS);
		expect(p.landedOverflow).toBe(4);
	});

	it("lists more than the NOTE's cap — the two budgets are not the same budget", () => {
		// The note's cap is a prompt budget (8); this is a page a human scrolls. A single shared
		// constant would be wrong for one of them, and quietly.
		expect(MAX_PREVIEW_ACTS).toBeGreaterThan(8);
	});

	it("counts unobserved acts separately and never lists them as landed (#594)", () => {
		const p = continueBriefingPreview(
			"run-1",
			checkpoint({ landed: [act("pushed to main")], unobserved: [act("opened a PR", null), act("merged", null)] }),
			READ,
		);
		expect(p.landed).toEqual(["pushed to main"]);
		expect(p.unobserved).toBe(2);
	});
});

describe("the working tree is tri-state, because 0 and 'we could not look' are different claims", () => {
	it("reports the count and no caveat when the tree was read", () => {
		const p = continueBriefingPreview("run-1", checkpoint(), { files: 4, read: "read" });
		expect(p.uncommittedFiles).toBe(4);
		expect(p.workingTree).toBe("read");
		expect(p.caveat).toBeNull();
	});

	it("reports NULL, not zero, when the runner could not be reached", () => {
		// The expected case for this surface: #806 item 4 is an owner checking back the next
		// morning, when the machine is off. Zero here would be a clean tree the platform never saw.
		const p = continueBriefingPreview("run-1", checkpoint(), BLIND);
		expect(p.uncommittedFiles).toBeNull();
		expect(p.workingTree).toBe("unavailable");
		expect(p.caveat).toBe(CONTINUE_PREVIEW_TREE_UNAVAILABLE);
	});

	it("the caveat says the real briefing may carry MORE than this one", () => {
		expect(CONTINUE_PREVIEW_TREE_UNAVAILABLE).toMatch(/runner is not connected/);
		expect(CONTINUE_PREVIEW_TREE_UNAVAILABLE).toMatch(/briefing will say so/);
	});
});

describe("the sentence the owner reads", () => {
	it("says plainly that nothing carries forward", () => {
		const s = continueBriefingSentence(continueBriefingPreview("run-1", null, READ));
		expect(s).toMatch(/^Nothing carries forward/);
		expect(s).toContain("objective alone");
	});

	it("distinguishes this run's work from a more recent run's", () => {
		const mine = continueBriefingSentence(continueBriefingPreview("run-1", checkpoint(), READ));
		const theirs = continueBriefingSentence(continueBriefingPreview("run-1", checkpoint({ predecessorRunId: "run-9" }), READ));
		expect(mine).toContain("what this run left behind");
		expect(theirs).toContain("a more recent stopped run on the same repository");
	});

	it("counts landed actions including the overflow, not just the listed ones", () => {
		const landed = Array.from({ length: MAX_PREVIEW_ACTS + 3 }, (_, i) => act(`push ${i}`));
		const s = continueBriefingSentence(continueBriefingPreview("run-1", checkpoint({ landed }), READ));
		expect(s).toContain(`${MAX_PREVIEW_ACTS + 3} actions already landed`);
	});

	it("tells the owner to expect a verify step when outcomes were never observed", () => {
		const s = continueBriefingSentence(continueBriefingPreview("run-1", checkpoint({ unobserved: [act("merged", null)] }), READ));
		expect(s).toContain("1 whose outcome was never observed");
		expect(s).toContain("verify");
	});

	it("mentions the dirty tree only when the tree was actually read", () => {
		const seen = continueBriefingSentence(continueBriefingPreview("run-1", checkpoint(), { files: 2, read: "read" }));
		expect(seen).toContain("2 uncommitted files");
		// Same checkpoint, unreadable tree: it must not claim a count, in either direction.
		const blind = continueBriefingSentence(continueBriefingPreview("run-1", checkpoint(), BLIND));
		expect(blind).not.toMatch(/uncommitted/);
	});

	it("is singular for one file and one action", () => {
		const s = continueBriefingSentence(
			continueBriefingPreview("run-1", checkpoint({ landed: [act("pushed once")] }), { files: 1, read: "read" }),
		);
		expect(s).toContain("1 action already landed");
		expect(s).toContain("1 uncommitted file,");
	});

	it("says 'no landed action' rather than '0 actions' when only a dirty tree carries forward", () => {
		// #806's own incident: cut off at step 4 with a good partial fix on disk and nothing pushed.
		// The note exists in that case (slice iii), so the sentence must not read as an empty one.
		const p = continueBriefingPreview("run-1", checkpoint({ landed: [], note: "…" }), { files: 3, read: "read" });
		const s = continueBriefingSentence(p);
		expect(p.kind).toBe("this-run");
		expect(s).toContain("no landed action");
		expect(s).toContain("3 uncommitted files");
	});
});
