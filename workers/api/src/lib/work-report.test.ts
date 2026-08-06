import { describe, expect, it } from "vitest";
import { STALLED_AFTER_MS, describeLoopRun, describeWorkCheck, isStalled, recentWorkPrompt } from "./work-report.js";
import type { LoopRunView } from "./agent-loop-store.js";

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
		...over,
	};
}

describe("describeLoopRun", () => {
	it("states the outcome so a challenged agent can quote it", () => {
		const s = describeLoopRun(run(), NOW);
		expect(s).toContain("run-1");
		expect(s).toContain("completed");
		expect(s).toContain("git pull");
		expect(s).toContain("Already up to date");
		expect(s).toContain("step 1/10");
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
});
