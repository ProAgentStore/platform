import { describe, expect, it } from "vitest";
import type { LoopRunView } from "./agent-loop-store.js";
import {
	classifyBeforeStop,
	describeNothingToStop,
	describeStopOutcome,
	describeStopResult,
	stoppableRuns,
	type StopOutcome,
} from "./work-stop.js";

const run = (over: Partial<LoopRunView> = {}): LoopRunView => ({
	runId: "r1",
	instanceId: "i1",
	objective: "fix the failing test",
	status: "running",
	stopReason: null,
	detail: null,
	iteration: 3,
	maxIterations: 10,
	cancelRequested: false,
	budgetId: null,
	startedAt: Date.now() - 60_000,
	finishedAt: null,
	lastProgressAt: Date.now() - 10_000,
	delegatedBy: null,
	sessionId: null,
	...over,
});

const outcome = (over: Partial<StopOutcome> = {}): StopOutcome => ({
	kind: "requested",
	runId: "r1",
	objective: "fix the failing test",
	status: "running",
	stopReason: null,
	delegated: false,
	instanceId: "i1",
	...over,
});

describe("classifyBeforeStop — the four things a stop can meet", () => {
	it("a running run with no cancel yet is stoppable", () => {
		expect(classifyBeforeStop(run())).toBe("stoppable");
	});

	it("a run that already ended is not stopped again", () => {
		// `requestCancel` matches `status = 'running'`, so a cancel on a finished run changes
		// nothing and returns false — reporting that as a stop would be claiming credit for an
		// outcome that happened ten minutes earlier without you.
		expect(classifyBeforeStop(run({ status: "completed", stopReason: "done" }))).toBe("already-finished");
	});

	it("a run already asked to stop says so, rather than asking twice", () => {
		expect(classifyBeforeStop(run({ cancelRequested: true }))).toBe("already-requested");
	});
});

describe("stoppableRuns — what a bare 'stop' applies to", () => {
	it("is exactly the runs that are running", () => {
		const rows = [run({ runId: "a" }), run({ runId: "b", status: "completed" }), run({ runId: "c" })];
		expect(stoppableRuns(rows).map((r) => r.runId)).toEqual(["a", "c"]);
	});
});

describe("the report says REQUESTED, never STOPPED (#540)", () => {
	it("a successful stop is worded as a request, with the cooperative note", () => {
		const text = describeStopResult([outcome()]);
		expect(text).toMatch(/Asked run r1 to stop/);
		// The invariant this whole module exists for. Cancelling is cooperative — the step in flight
		// finishes and settles its spend — so at the moment this text is produced the run is still
		// working, and "it has stopped" is false every single time.
		expect(text).toMatch(/REQUEST, not a completed stop/);
		expect(text).toMatch(/do not say it has stopped/i);
		expect(text).toContain("check_work");
	});

	it("does not claim an ongoing stop when every run had already ended", () => {
		// "it can keep working for another minute" would be an invented ongoing action here.
		const text = describeStopResult([outcome({ kind: "already-finished", status: "completed", stopReason: "done" })]);
		expect(text).toMatch(/had already ended/);
		expect(text).toMatch(/Nothing was stopped/);
		expect(text).not.toMatch(/REQUEST, not a completed stop/);
	});

	it("names the agent a delegated run is on, so a supervisor can cite both", () => {
		const text = describeStopOutcome(outcome({ delegated: true, instanceId: "sub-1" }));
		expect(text).toContain("sub-1");
	});

	it("distinguishes a run that finished between the read and the write", () => {
		// Not a failure: `requestCancel` returning false after we read the run as running means it
		// ended in between, and saying "stopped" there would be the same over-claim.
		const text = describeStopOutcome(outcome({ kind: "vanished" }));
		expect(text).toMatch(/finished on its own/);
		expect(text).toMatch(/Nothing was stopped/);
	});

	it("reports an already-requested stop as still in progress, not as a fresh one", () => {
		expect(describeStopOutcome(outcome({ kind: "already-requested" }))).toMatch(/already been asked to stop/);
	});
});

describe("nothing to stop is an ANSWER, not an error", () => {
	it("tells the agent to say so, and forbids claiming a stop", () => {
		const text = describeNothingToStop();
		expect(text).toMatch(/Nothing is running/);
		expect(text).toMatch(/do NOT tell the user you stopped anything/);
	});

	it("points a coding agent at the session, which is the other thing 'finish' can mean", () => {
		// The owner's words were "finish the session". On a coding agent "nothing is running" and
		// "a session is still open" are true at the same time, so the run answer alone is correct
		// and incomplete — which is how a technically-true answer still ends in a complaint.
		expect(describeNothingToStop({ canEndSession: true })).toContain("end_coding_session");
	});

	it("does not name a tool an agent without a coding surface does not have", () => {
		// Naming it there would send the model looking for a tool it cannot call, which is the
		// shape that produces fabrications in the first place.
		expect(describeNothingToStop({ canEndSession: false })).not.toContain("end_coding_session");
	});
});
