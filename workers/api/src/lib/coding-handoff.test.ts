/**
 * The handover decision (#984), over every combination that matters.
 *
 * The incident in one line: a run for #978 was closed `interrupted` while its engine was still
 * executing #978's "commit, push and close" instruction, and #982 was started in that same session
 * and checkout. Each test below is one way that could silently come back.
 */
import { describe, expect, it } from "vitest";
import {
	HANDOFF_LABELS,
	HANDOFF_STATES,
	type HandoffProbe,
	type RecoveryClaim,
	continuesClaim,
	handoffVerdict,
	recoveryReasonForStop,
} from "./coding-handoff.js";

const CLAIM: RecoveryClaim = {
	sessionId: "csess_bef6cca7",
	runId: "run-978",
	issue: 978,
	objective: "Implement #978: application execution runs on the Board",
	reason: "interrupted",
	at: 1_700_000_000_000,
};

const probe = (over: Partial<HandoffProbe> = {}): HandoffProbe => ({ engine: "terminal", changedFiles: 0, ...over });
/** #982 — a DIFFERENT issue, which is the whole incident. */
const other = { issue: 982 };

describe("no claim: the ordinary start is untouched", () => {
	it("admits with no probe needed", () => {
		expect(handoffVerdict(null, null, other)).toMatchObject({ state: "safe_to_start_next", admit: true, recovering: false, detail: "" });
	});

	it("admits even when the tree is filthy — a dirty checkout nobody owns is #276's policy, not this gate", () => {
		// `repo-state.ts`: report it everywhere, refuse nothing, discard nothing. This gate refuses a
		// HANDOVER; it must not become a clean-tree precondition on starting work.
		expect(handoffVerdict(null, probe({ changedFiles: 12 }), other).admit).toBe(true);
	});
});

describe("a live engine settles it, whatever else is true", () => {
	it("refuses the next objective and says the engine is still running the previous run's work", () => {
		const v = handoffVerdict(CLAIM, probe({ engine: "live", changedFiles: 8 }), other);
		expect(v).toMatchObject({ state: "stalled", admit: false, recovering: false, release: false });
		expect(v.detail).toContain("run run-978 (issue #978)");
		expect(v.detail).toMatch(/STILL RUNNING/);
		// The remedy names who can act and what keeps its place — the queue is not drained.
		expect(v.detail).toMatch(/coding_session_capture|coding_session_end/);
		expect(v.detail).toMatch(/keeps its place/);
	});

	it("refuses a CLEAN tree too — the harm is the shared CLI, not the diff", () => {
		expect(handoffVerdict(CLAIM, probe({ engine: "live", changedFiles: 0 }), other).admit).toBe(false);
	});

	it("refuses the SAME issue as well: two Pilots on one engine interleave, continuation or not", () => {
		expect(handoffVerdict(CLAIM, probe({ engine: "live", changedFiles: 8 }), { issue: 978 }).admit).toBe(false);
		expect(handoffVerdict(CLAIM, probe({ engine: "live" }), { issue: 978, repair: true }).admit).toBe(false);
	});
});

describe("an unconfirmed engine is not a stopped engine", () => {
	it("refuses when the machine did not answer the capture probe", () => {
		// The requirement is CONFIRMED terminal. Reading silence as "stopped" is the collapse
		// `coding-run-state.ts` exists to prevent, and it is the one that produces the incident.
		const v = handoffVerdict(CLAIM, probe({ engine: "unknown", changedFiles: 0 }), other);
		expect(v).toMatchObject({ state: "stalled", admit: false, release: false });
		expect(v.detail).toMatch(/did not say|not a confirmation/);
	});

	it("treats a missing probe exactly as an unanswered one", () => {
		expect(handoffVerdict(CLAIM, null, other)).toMatchObject({ state: "stalled", admit: false });
	});
});

describe("a stopped engine with work left behind: attributed, never handed on", () => {
	it("refuses a DIFFERENT issue and names the owner, the count and the ways out", () => {
		const v = handoffVerdict(CLAIM, probe({ changedFiles: 8 }), other);
		expect(v).toMatchObject({ state: "interrupted_awaiting_recovery", admit: false, recovering: false });
		expect(v.detail).toContain("8 uncommitted files");
		expect(v.detail).toContain("run run-978 (issue #978)");
		expect(v.detail).toContain("issue #978");
		expect(v.detail).toMatch(/repair_checkout/);
		// The guarantee the issue asks for in both directions.
		expect(v.detail).toMatch(/nothing has been discarded/i);
		expect(v.detail).toMatch(/one commit carries two issues/);
	});

	it("ADMITS a run for the claimed issue, as a recovery, and tells it so", () => {
		const v = handoffVerdict(CLAIM, probe({ changedFiles: 8 }), { issue: 978 });
		expect(v).toMatchObject({ state: "interrupted_awaiting_recovery", admit: true, recovering: true, release: false });
		expect(v.detail).toMatch(/Recovering run run-978/);
		expect(v.detail).toMatch(/Inspect the diff/);
		expect(v.detail).toMatch(/did not start clean/);
	});

	it("admits a REPAIR run: its brief is to put the checkout right without discarding anything", () => {
		expect(handoffVerdict(CLAIM, probe({ changedFiles: 3 }), { issue: 982, repair: true })).toMatchObject({ admit: true, recovering: true });
	});

	it("admits an explicit continue of the claimed run, even with no issue to match on", () => {
		const unlinked = { ...CLAIM, issue: null };
		expect(handoffVerdict(unlinked, probe({ changedFiles: 2 }), { issue: null, continueFromRunId: "run-978" })).toMatchObject({ admit: true, recovering: true });
		// …and a continue of some OTHER run is not a recovery of this one.
		expect(handoffVerdict(unlinked, probe({ changedFiles: 2 }), { issue: null, continueFromRunId: "run-999" }).admit).toBe(false);
	});

	it("one file reads as one file", () => {
		expect(handoffVerdict(CLAIM, probe({ changedFiles: 1 }), other).detail).toContain("1 uncommitted file ");
	});

	it("refuses when the tree could not be read — unknown dirtiness is not a clean tree", () => {
		const v = handoffVerdict(CLAIM, probe({ changedFiles: null }), other);
		expect(v).toMatchObject({ state: "interrupted_awaiting_recovery", admit: false, release: false });
		expect(v.detail).toMatch(/could not be read/);
		expect(v.detail).toMatch(/nothing has been discarded/i);
	});

	it("does NOT admit a continuation on an unreadable tree either — nobody knows what is being inherited", () => {
		expect(handoffVerdict(CLAIM, probe({ changedFiles: null }), { issue: 978 }).admit).toBe(false);
	});
});

describe("a stopped engine and a clean tree is the end of the claim", () => {
	it("admits and RELEASES — a claim that outlives its reason blocks real work", () => {
		expect(handoffVerdict(CLAIM, probe(), other)).toMatchObject({ state: "safe_to_start_next", admit: true, release: true, recovering: false, detail: "" });
	});
});

describe("what counts as continuing someone else's work", () => {
	it("the same issue, an explicit continue, or a repair — and nothing else", () => {
		expect(continuesClaim(CLAIM, { issue: 978 })).toBe(true);
		expect(continuesClaim(CLAIM, { issue: 982 })).toBe(false);
		expect(continuesClaim(CLAIM, { issue: null })).toBe(false);
		expect(continuesClaim(CLAIM, { issue: 982, repair: true })).toBe(true);
		expect(continuesClaim(CLAIM, { issue: 982, continueFromRunId: "run-978" })).toBe(true);
	});

	it("an unlinked claim is never continued by an issue match — null is not an issue", () => {
		// The trap: `claim.issue === incoming.issue` is true for two nulls, which would make EVERY
		// objective with no issue a recovery of EVERY unlinked claim.
		expect(continuesClaim({ ...CLAIM, issue: null }, { issue: null })).toBe(false);
	});

	it("a similar-looking objective is not a continuation — only a statement is", () => {
		// Deliberately no fuzzy matching: that would hand #982 a tree full of #978 and call it a
		// recovery, which is the defect wearing the fix's clothes.
		expect(continuesClaim(CLAIM, { issue: 979 })).toBe(false);
	});
});

describe("the vocabulary", () => {
	it("every state has a label, and nothing publishes a fifth word", () => {
		expect(Object.keys(HANDOFF_LABELS).sort()).toEqual([...HANDOFF_STATES].sort());
		expect(HANDOFF_STATES).toEqual(["working", "stalled", "interrupted_awaiting_recovery", "safe_to_start_next"]);
	});

	it("every state the verdict can return is in it", () => {
		const seen = new Set(
			[
				handoffVerdict(null, null, other),
				handoffVerdict(CLAIM, probe({ engine: "live" }), other),
				handoffVerdict(CLAIM, probe({ engine: "unknown" }), other),
				handoffVerdict(CLAIM, probe({ changedFiles: 4 }), other),
				handoffVerdict(CLAIM, probe(), other),
			].map((v) => v.state),
		);
		for (const s of seen) expect(HANDOFF_STATES).toContain(s);
	});

	it("a platform-closed run's reason comes from how it was closed", () => {
		expect(recoveryReasonForStop("cancelled")).toBe("cancelled");
		expect(recoveryReasonForStop("interrupted")).toBe("interrupted");
		expect(recoveryReasonForStop("failed")).toBe("stalled");
		expect(recoveryReasonForStop("something_new")).toBe("stalled");
	});
});
