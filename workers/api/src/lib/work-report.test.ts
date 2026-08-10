import { describe, expect, it } from "vitest";
import { STALLED_AFTER_MS, describeLoopRun, describeWorkCheck, engineClause, isStalled, recentWorkPrompt } from "./work-report.js";
import type { LoopRunView } from "./agent-loop-store.js";
import type { TerminalView } from "./terminal-label.js";

const NOW = 1_700_000_000_000;

function run(over: Partial<LoopRunView> = {}): LoopRunView {
	return {
		runId: "run-1",
		instanceId: "inst-1",
		objective: "Run `git pull` in ~/dev/stores/fas/platform",
		status: "completed",
		stopReason: "done",
		detail: "Already up to date on branch main.",
		iteration: 1,
		maxIterations: 10,
		cancelRequested: false,
		budgetId: null,
		startedAt: NOW - 60_000,
		finishedAt: NOW - 30_000,
		lastProgressAt: NOW - 40_000,
		delegatedBy: null,
		sessionId: null,
		...over,
	};
}

function tv(kind: TerminalView["kind"]): TerminalView {
	return { kind, text: kind === "live-active" ? "some terminal output" : "" };
}

describe("run times in the owner's zone (#329)", () => {
	it("adds a formatted wall clock beside the relative time when a zone is known", () => {
		// FORMATTED here, not converted by the model: #329's symptom was a Lead reporting "completed
		// at 22:34:19 UTC", which is a different claim from the one its reader hears.
		const s = describeLoopRun(run(), NOW, "Australia/Sydney");
		expect(s).toContain("1m ago");
		expect(s).toMatch(/AE[SD]T|GMT\+1[01]/);
	});

	it("says nothing absolute when the zone is unset — the pre-#329 output, unchanged", () => {
		// Relative times were always safe: they carry no zone, so they cannot be wrong about one. An
		// account that never set a timezone must keep exactly what it had rather than gain a
		// wall-clock in a zone nobody chose.
		expect(describeLoopRun(run(), NOW)).toBe(describeLoopRun(run(), NOW, undefined));
		expect(describeLoopRun(run(), NOW)).not.toMatch(/\d{2}:\d{2}/);
	});

	it("degrades to relative-only rather than failing a turn on an unresolvable zone", () => {
		// A stored zone can outlive the tz database that knew it. Losing the wall clock is a far
		// smaller failure than losing the chat turn it was decorating.
		const s = describeLoopRun(run(), NOW, "Australia/Melbourn");
		expect(s).toContain("1m ago");
	});

	it("reaches both the tool result and the prompt block, so the two agree", () => {
		// `work-report.ts`'s own contract: one rendering serves `check_work` and the automatic recent-
		// work block precisely so they can never tell different stories about one run.
		const zone = "Australia/Sydney";
		expect(describeWorkCheck([run()], NOW, { timeZone: zone })).toMatch(/AE[SD]T|GMT\+1[01]/);
		expect(recentWorkPrompt([run()], NOW, { timeZone: zone })).toMatch(/AE[SD]T|GMT\+1[01]/);
	});
});

describe("describeLoopRun", () => {
	it("states the outcome so a challenged agent can quote it", () => {
		const s = describeLoopRun(run(), NOW);
		expect(s).toContain("run-1");
		expect(s).toContain("completed");
		expect(s).toContain("git pull");
		expect(s).toContain("Already up to date");
		// "step 1/10" until #459 — it read as a progress bar and is a count of instructions sent.
		expect(s).toContain("instruction 1 of up to 10");
		expect(s).not.toMatch(/step \d+\/\d+/);
	});

	it("#459 — a healthy run states that it is NOT stalled, rather than saying nothing", () => {
		// The defect was silence. A live agent read "step 3/50 after 9 minutes" as a stuck progress
		// bar, called a working run stalled, and followed it with "nothing I can do" — with the
		// contradicting evidence in the same sentence. Liveness was only ever stated negatively, so
		// the model had to infer the positive case, and it inferred wrong.
		const s = describeLoopRun(run({ status: "running", finishedAt: null, iteration: 3, maxIterations: 50, startedAt: NOW - 9 * 60_000, lastProgressAt: NOW - 9 * 60_000 }), NOW);
		expect(s).toContain("NOT stalled");
		expect(s).not.toContain("STALLED");
		// The step counter carries how long THIS instruction has been running, so a long step reads
		// as a long step instead of as no progress.
		expect(s).toContain("instruction 3 of up to 50 (this one has been running 9m)");
	});

	it("#459 — the positive claim is about the RUN, never about an engine it cannot see", () => {
		// `lastProgressAt` is the orchestrator's last iteration, not the engine's last output. The
		// live `runState` is behind `/capture` on the coding surface, and this module describes loop
		// runs that may have no engine at all — asserting "engine: working" from this column would
		// replace a false stall with a false all-clear.
		const s = describeLoopRun(run({ status: "running", finishedAt: null, lastProgressAt: NOW - 1000 }), NOW);
		expect(s).not.toMatch(/engine/i);
	});

	it("#459 — a finished run makes no liveness claim in either direction", () => {
		for (const status of ["completed", "failed", "cancelled"]) {
			const s = describeLoopRun(run({ status, lastProgressAt: NOW - STALLED_AFTER_MS - 1 }), NOW);
			expect(s, status).not.toContain("stalled");
			expect(s, status).not.toContain("STALLED");
			expect(s, status).not.toContain("has been running");
		}
	});

	it("reports a silent `running` run as STALLED rather than as live work", () => {
		// A Workflow that dies mid-step leaves status='running' forever, so "running" alone is not
		// evidence anything is happening — reporting it as live would be the same over-claim in a
		// new place.
		const s = describeLoopRun(run({ status: "running", finishedAt: null, lastProgressAt: NOW - STALLED_AFTER_MS - 1 }), NOW);
		expect(s).toContain("STALLED");
	});

	it("a run that just reported progress is plainly running", () => {
		const s = describeLoopRun(run({ status: "running", finishedAt: null, lastProgressAt: NOW - 1000 }), NOW);
		expect(s).toContain("running");
		expect(s).not.toContain("STALLED");
	});

	it("#459 — a run one second under the threshold is NOT stalled; one second over it is", () => {
		// The boundary is the whole claim. `isStalled` is the platform's verdict and the prompt now
		// tells the agent to quote it, so the report and the predicate must never disagree.
		const under = run({ status: "running", finishedAt: null, lastProgressAt: NOW - STALLED_AFTER_MS + 1000 });
		const over = run({ status: "running", finishedAt: null, lastProgressAt: NOW - STALLED_AFTER_MS - 1000 });
		expect(isStalled(under, NOW)).toBe(false);
		expect(describeLoopRun(under, NOW)).toContain("NOT stalled");
		expect(isStalled(over, NOW)).toBe(true);
		expect(describeLoopRun(over, NOW)).toContain("STALLED");
		// The stalled branch must not also carry the reassurance — that would be both verdicts at once.
		expect(describeLoopRun(over, NOW)).not.toContain("NOT stalled");
	});

	it("falls back to startedAt when a run has never reported progress", () => {
		expect(isStalled(run({ status: "running", lastProgressAt: null, startedAt: NOW - STALLED_AFTER_MS - 1 }), NOW)).toBe(true);
		expect(isStalled(run({ status: "running", lastProgressAt: null, startedAt: NOW - 1000 }), NOW)).toBe(false);
	});

	it("only a running run can be stalled", () => {
		expect(isStalled(run({ status: "completed", lastProgressAt: 0 }), NOW)).toBe(false);
	});

	it("surfaces a pending cancel", () => {
		expect(describeLoopRun(run({ status: "running", finishedAt: null, cancelRequested: true, lastProgressAt: NOW }), NOW)).toContain("cancel");
	});
});

describe("describeWorkCheck — the answer to 'did you actually do that?'", () => {
	it("no runs is a real answer, not an error", () => {
		// An error would read as "could not tell", which is the state that produces a guess. This
		// has to be usable to CONTRADICT the agent's own earlier claim.
		const s = describeWorkCheck([], NOW);
		expect(s).toMatch(/have not started any work/);
		expect(s).toMatch(/that was wrong/);
	});

	it("tells the agent not to soften the record", () => {
		const s = describeWorkCheck([run()], NOW);
		expect(s).toContain("Already up to date");
		expect(s).toMatch(/do not soften or retract/);
	});

	it("lists several runs newest-first as given", () => {
		const s = describeWorkCheck([run({ runId: "a" }), run({ runId: "b" })], NOW);
		expect(s.indexOf("a")).toBeLessThan(s.indexOf("b"));
		expect(s).toContain("2 most recent runs");
	});

	// ── #318 ──────────────────────────────────────────────────────────────
	describe("a delegator's work is not on its own instance", () => {
		const delegated = run({ runId: "d1", instanceId: "sub-1", delegatedBy: "lead-1" });

		it("reports delegated runs as work the supervisor started", () => {
			const s = describeWorkCheck([], NOW, { delegated: [delegated] });
			expect(s).toContain("d1");
			// Named with the agent it ran on, so the supervisor can cite both halves of the fact.
			expect(s).toContain("sub-1");
			expect(s).toMatch(/do not soften or retract/);
		});

		it("does NOT accuse a supervisor of misleading the user when it has run nothing itself", () => {
			// The live failure: a Lead that had delegated 90 seconds earlier, and said so truthfully,
			// was told "if you told the user you did something, that was wrong; say so" — and
			// complied. Whether the user was misled is not something this record can see for an
			// agent whose work lives elsewhere.
			const s = describeWorkCheck([], NOW, { supervises: true });
			expect(s).not.toMatch(/that was wrong/);
			expect(s).toMatch(/check_delegation/);
		});

		it("leaves #254's correction exactly as it was for a non-delegator", () => {
			// The guard earns its place there — an agent that ran nothing and claimed it did.
			expect(describeWorkCheck([], NOW, { supervises: false })).toMatch(/that was wrong; say so/);
			expect(describeWorkCheck([], NOW)).toMatch(/that was wrong; say so/);
		});

		it("reports own runs and delegated runs together, separately labelled", () => {
			const s = describeWorkCheck([run({ runId: "own-1" })], NOW, { delegated: [delegated] });
			expect(s).toContain("own-1");
			expect(s).toContain("d1");
			expect(s.indexOf("own-1")).toBeLessThan(s.indexOf("delegating"));
		});
	});
});

// ── #465 — engine liveness in the run report ──────────────────────────────────────────────────

describe("engineClause (#465)", () => {
	it("live-active → working", () => {
		expect(engineClause(tv("live-active"))).toContain("working");
	});

	it("live-idle → idle, not working", () => {
		const c = engineClause(tv("live-idle"));
		expect(c).toContain("idle");
		expect(c).not.toContain("working");
	});

	it("capture-failed → do NOT infer idle or finished", () => {
		const c = engineClause(tv("capture-failed"));
		expect(c).toMatch(/could not be read/i);
		// The wording says "do NOT infer idle or finished" — the word "idle" appears in the
		// negation, which is correct. What must NOT appear is a positive claim of idleness.
		expect(c).toMatch(/do NOT infer/i);
		expect(c).not.toContain("working");
		expect(c).not.toMatch(/engine.*is idle/i);
	});

	it("runner-offline → machine is offline", () => {
		const c = engineClause(tv("runner-offline"));
		expect(c).toMatch(/offline/i);
		expect(c).not.toContain("working");
	});

	it("empty-pane → null (not enough signal)", () => {
		expect(engineClause(tv("empty-pane"))).toBeNull();
	});

	it("none → null", () => {
		expect(engineClause(tv("none"))).toBeNull();
	});

	it("absent → null", () => {
		expect(engineClause(null)).toBeNull();
		expect(engineClause(undefined)).toBeNull();
	});
});

describe("describeLoopRun engine clause (#465)", () => {
	const coding = run({ status: "running", finishedAt: null, sessionId: "sess-1", lastProgressAt: NOW - 1000 });

	it("live-active → 'engine: working' appears in a running coding run", () => {
		const s = describeLoopRun(coding, NOW, undefined, tv("live-active"));
		expect(s).toMatch(/engine.*working/i);
	});

	it("capture-failed → unreadable wording, never a positive idle or working claim", () => {
		const s = describeLoopRun(coding, NOW, undefined, tv("capture-failed"));
		expect(s).toMatch(/could not be read/i);
		// The clause wording says "do NOT infer idle" — the word appears in the negation, not as a
		// positive claim. What must NOT appear is "engine: idle" (the engineClause for live-idle).
		expect(s).not.toMatch(/engine: idle/i);
		expect(s).not.toMatch(/engine.*working/i);
	});

	it("runner-offline → offline wording, never 'working'", () => {
		const s = describeLoopRun(coding, NOW, undefined, tv("runner-offline"));
		expect(s).toMatch(/offline/i);
		expect(s).not.toMatch(/engine.*working/i);
	});

	it("no engineView → no engine clause (non-coding or pending view)", () => {
		// Existing test preserved verbatim: the positive claim must never come from lastProgressAt.
		const s = describeLoopRun(coding, NOW);
		expect(s).not.toMatch(/engine/i);
	});

	it("a completed run renders no engine clause even if a view is passed", () => {
		// The engine is no longer running once the run is done.
		const done = run({ status: "completed", sessionId: "sess-1" });
		const s = describeLoopRun(done, NOW, undefined, tv("live-active"));
		expect(s).not.toMatch(/engine/i);
	});

	it("a non-coding run (no sessionId) renders no engine clause", () => {
		// chat/pipeline driver: sessionId is null, engineView will never be resolved for it.
		const chat = run({ status: "running", finishedAt: null, sessionId: null, lastProgressAt: NOW - 1000 });
		expect(describeLoopRun(chat, NOW)).not.toMatch(/engine/i);
	});
});

describe("describeWorkCheck engine views (#465)", () => {
	it("threads engineViews map into each run description", () => {
		const r = run({ runId: "r1", status: "running", finishedAt: null, sessionId: "sess-1", lastProgressAt: NOW - 1000 });
		const views = new Map([["r1", tv("live-active")]]);
		const s = describeWorkCheck([r], NOW, { engineViews: views });
		expect(s).toMatch(/engine.*working/i);
	});

	it("a missing key in engineViews → no engine clause for that run", () => {
		const r = run({ runId: "r1", status: "running", finishedAt: null, sessionId: "sess-1", lastProgressAt: NOW - 1000 });
		const s = describeWorkCheck([r], NOW, { engineViews: new Map() });
		expect(s).not.toMatch(/engine/i);
	});

	it("capture-failed in engineViews → unreadable wording, never a positive idle claim", () => {
		const r = run({ runId: "r1", status: "running", finishedAt: null, sessionId: "sess-1", lastProgressAt: NOW - 1000 });
		const views = new Map([["r1", tv("capture-failed")]]);
		const s = describeWorkCheck([r], NOW, { engineViews: views });
		expect(s).toMatch(/could not be read/i);
		// "do NOT infer idle" is the correct wording — must not render "engine: idle" as a claim.
		expect(s).not.toMatch(/engine: idle/i);
	});
});

describe("recentWorkPrompt — the context block that removes the tool-call decision", () => {
	it("is empty when there is no work, so a quiet agent's prompt gains nothing", () => {
		expect(recentWorkPrompt([], NOW)).toBe("");
	});

	it("presents the runs as fact and points at check_work for more", () => {
		const p = recentWorkPrompt([run()], NOW);
		expect(p).toContain("## Your recent work");
		expect(p).toContain("check_work");
		expect(p).toContain("git pull");
	});

	it("carries a supervisor's delegations, which are the only work it ever has (#318)", () => {
		// The stronger half of the fix: the Lead in #318 DID call check_work and still recanted, so
		// the answer belongs in the prompt before the challenge arrives.
		const p = recentWorkPrompt([], NOW, { delegated: [run({ runId: "d1", instanceId: "sub-1", delegatedBy: "lead-1" })] });
		expect(p).toContain("## Your recent work");
		expect(p).toContain("d1");
		expect(p).toMatch(/Never deny one of these/);
	});
});
