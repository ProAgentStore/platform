/**
 * The `runs` field on an instance's state (#791).
 *
 * The reported defect: `get_instance_state` answered `status: "idle", inflight: []` while a coding
 * run was mid-investigation. Both fields were right about what they measure — chat turns — and the
 * payload simply had no field that could say a run was live.
 *
 * What is asserted here is the shape and, above all, the two ways this could go back to lying:
 *
 *   the verdict is IMPORTED    `health` must be `runHealth`'s answer, not a second derivation. #589
 *                              is the incident: two surfaces deriving activity independently
 *                              reported `working` and `waiting` about the same row at one instant.
 *   null is not zero           a failed lookup must not present as "nothing is running", which is
 *                              the exact false all-clear this ticket is about.
 */
import { describe, expect, it } from "vitest";
import { runLiveness, runLivenessUnavailable } from "./instance-run-liveness.js";
import { runHealth } from "./work-report.js";
import type { LoopRunView } from "./agent-loop-store.js";

const NOW = 1_700_000_000_000;

const run = (over: Partial<LoopRunView> = {}): LoopRunView => ({
	runId: "run-1",
	instanceId: "i1",
	objective: "work through the open issues",
	status: "running",
	stopReason: null,
	detail: null,
	iteration: 3,
	maxIterations: 15,
	cancelRequested: false,
	budgetId: "b1",
	startedAt: NOW - 10 * 60_000,
	finishedAt: null,
	lastProgressAt: NOW - 60_000,
	lastAliveAt: NOW - 5_000,
	waitingUntil: null,
	waitingReason: null,
	parkedSince: null,
	interruptions: 0,
	delegatedBy: null,
	sessionId: "csess_1",
	...over,
});

describe("an idle instance", () => {
	it("reports active: 0 with an empty list", async () => {
		expect(runLiveness([], NOW)).toEqual({ active: 0, runs: [] });
	});

	it("does NOT carry the unavailable marker — 0 is a measurement", () => {
		// The marker is what tells a caller nothing was measured. Present on a real zero, it would
		// make every idle instance look unreadable.
		expect(runLiveness([], NOW).unavailable).toBeUndefined();
	});
});

describe("an instance with a live run", () => {
	it("reports active: 1 and the run's own verdict", () => {
		const out = runLiveness([run()], NOW);
		expect(out.active).toBe(1);
		expect(out.runs).toHaveLength(1);
		expect(out.runs[0].health).toBe("working");
		expect(out.runs[0].runId).toBe("run-1");
	});

	it("carries every field a caller needs to check the verdict's arithmetic", () => {
		// The verdict is the answer; the fields are the evidence. A caller that wants to check it
		// must be able to, which is the same rule `withHealth` follows on the loop routes.
		const out = runLiveness([run()], NOW);
		expect(out.runs[0]).toMatchObject({
			status: "running",
			waitingReason: null,
			startedAt: NOW - 10 * 60_000,
			lastAliveAt: NOW - 5_000,
			lastProgressAt: NOW - 60_000,
			parkedSince: null,
			waitingUntil: null,
		});
	});

	it("takes `health` from runHealth rather than deriving one", () => {
		// #589: two surfaces deriving activity independently is how one row got reported as both
		// `working` and `waiting` at the same instant. Asserted against the function itself, so a
		// re-implementation here fails even if it happens to agree today.
		for (const r of [
			run(),
			run({ waitingReason: "platform_interrupt", parkedSince: NOW - 60_000 }),
			run({ waitingReason: "engine_limit", parkedSince: NOW - 60_000, waitingUntil: NOW + 60_000 }),
			run({ lastAliveAt: NOW - 60 * 60_000, lastProgressAt: NOW - 60 * 60_000 }),
		]) {
			expect(runLiveness([r], NOW).runs[0].health, r.waitingReason ?? "unparked").toBe(runHealth(r, NOW));
		}
	});

	it("counts a PARKED run as active — it still holds the session claim", () => {
		// The question `runs.active` answers is "is it safe to start new work here", and a parked or
		// stalled run still owns its single-flight claim and its budget pool. Counting only
		// `health === "working"` would answer a different question and re-open the 409 surprise.
		const parked = runLiveness([run({ waitingReason: "human", parkedSince: NOW - 60_000 })], NOW);
		expect(parked.active).toBe(1);
		expect(parked.runs[0].health).toBe("waiting");

		const wedged = runLiveness([run({ waitingReason: "platform_interrupt", parkedSince: NOW - 60 * 60_000 })], NOW);
		expect(wedged.active).toBe(1);
		expect(wedged.runs[0].health).toBe("stalled");
	});

	it("reports every open run, not just the newest", () => {
		const out = runLiveness([run({ runId: "run-a" }), run({ runId: "run-b" })], NOW);
		expect(out.active).toBe(2);
		expect(out.runs.map((r) => r.runId)).toEqual(["run-a", "run-b"]);
	});
});

describe("when the runs could not be read", () => {
	it("says active: null and marks itself unavailable", () => {
		expect(runLivenessUnavailable()).toEqual({ active: null, runs: [], unavailable: true });
	});

	it("is DISTINGUISHABLE from an idle instance", () => {
		// The whole point. `0` claims nothing is running; `null` says nobody looked. Collapsing the
		// second into the first is the false all-clear #791 was filed about, one layer along.
		expect(runLivenessUnavailable().active).not.toBe(runLiveness([], NOW).active);
		expect(runLivenessUnavailable().active).toBeNull();
	});
});
