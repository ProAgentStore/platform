import { describe, expect, it } from "vitest";
import { composeInstanceActivity, instanceHealthFor, type ActivityRunRow } from "./instance-activity.js";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function run(over: Partial<ActivityRunRow> = {}): ActivityRunRow {
	return {
		instanceId: "i1",
		runId: "r1",
		status: "running",
		stopReason: null,
		finishedAt: null,
		startedAt: NOW - MIN,
		lastAliveAt: NOW - 1000,
		...over,
	};
}

describe("instanceHealthFor — one verdict, taken from runHealth and never re-derived (#589)", () => {
	it("is idle when the instance has never run", () => {
		expect(instanceHealthFor(null, NOW)).toBe("idle");
		expect(instanceHealthFor(undefined, NOW)).toBe("idle");
	});

	it("is working while the run is ticking", () => {
		expect(instanceHealthFor(run(), NOW)).toBe("working");
	});

	it("is waiting for a deliberate park, not working", () => {
		// A park has nothing ticking BY DESIGN. Reporting it as working oversells it; reporting it
		// as stalled reports a recovery in progress as a failure.
		expect(instanceHealthFor(run({ waitingReason: "platform_interrupt", parkedSince: NOW - MIN }), NOW)).toBe("waiting");
	});

	it("is STALLED for an open run that stopped ticking — the case an open row alone gets wrong", () => {
		// The whole reason this does not test `finished_at IS NULL`. Run fe53a0c1 (#790) sat wedged
		// for 25 minutes with an open row; "it has a run" would have painted that card green.
		expect(instanceHealthFor(run({ lastAliveAt: NOW - 60 * MIN }), NOW)).toBe("stalled");
	});

	it("is stalled for a park whose own deadline has come and gone", () => {
		expect(
			instanceHealthFor(run({ waitingReason: "platform_interrupt", parkedSince: NOW - 48 * 60 * MIN, lastAliveAt: NOW - 48 * 60 * MIN }), NOW),
		).toBe("stalled");
	});

	it("collapses runHealth's `ended` to idle — an instance does not end, its last run does", () => {
		for (const status of ["completed", "failed", "cancelled", "needs_human"]) {
			expect(instanceHealthFor(run({ status, finishedAt: NOW - MIN }), NOW)).toBe("idle");
		}
	});
});

describe("composeInstanceActivity", () => {
	it("returns a record per instance that has a run or a queue entry", () => {
		const out = composeInstanceActivity([run({ instanceId: "a" })], new Map([["b", 2]]), NOW);
		expect(out.map((r) => r.instanceId)).toEqual(["a", "b"]);
	});

	it("omits instances with neither — absence is idle, and the roster is a third query", () => {
		expect(composeInstanceActivity([], new Map(), NOW)).toEqual([]);
	});

	it("gives an instance with only a queue entry idle health and its depth", () => {
		const [rec] = composeInstanceActivity([], new Map([["b", 3]]), NOW);
		expect(rec).toEqual({ instanceId: "b", health: "idle", queueDepth: 3, lastOutcome: null, lastAdmissionFailure: null });
	});

	it("defaults queueDepth to 0 for an instance that never queues", () => {
		const [rec] = composeInstanceActivity([run({ instanceId: "a" })], new Map(), NOW);
		expect(rec.queueDepth).toBe(0);
	});

	it("carries lastOutcome while the run is STILL OPEN, not only after it ends", () => {
		const [rec] = composeInstanceActivity([run({ instanceId: "a", runId: "open-1" })], new Map(), NOW);
		expect(rec.health).toBe("working");
		expect(rec.lastOutcome).toEqual({
			runId: "open-1",
			status: "running",
			stopReason: null,
			finishedAt: null,
			startedAt: NOW - MIN,
			lastAliveAt: NOW - 1000,
		});
	});

	it("carries the run's own timestamps, which is what 'last active' is computed from", () => {
		// `last_activity_at` moves only on owner-driven events, so a Pilot working unattended for
		// two hours would sort below an instance the owner merely opened. These are the other two
		// terms of max(lastActivityAt, lastAliveAt, startedAt).
		const [rec] = composeInstanceActivity([run({ instanceId: "a", startedAt: NOW - 2 * MIN, lastAliveAt: NOW - 5000 })], new Map(), NOW);
		expect(rec.lastOutcome?.startedAt).toBe(NOW - 2 * MIN);
		expect(rec.lastOutcome?.lastAliveAt).toBe(NOW - 5000);
	});

	it("carries the stop reason, which is what separates 'raise the cap' from 'the objective is wrong'", () => {
		const [rec] = composeInstanceActivity(
			[run({ instanceId: "a", status: "failed", stopReason: "max_iterations", finishedAt: NOW - MIN })],
			new Map(),
			NOW,
		);
		expect(rec.health).toBe("idle");
		expect(rec.lastOutcome?.stopReason).toBe("max_iterations");
	});

	it("keeps the NEWEST row if the query ever yields more than one per instance", () => {
		const older = run({ instanceId: "a", runId: "old", startedAt: NOW - 10 * MIN, status: "failed", finishedAt: NOW - 9 * MIN });
		const newer = run({ instanceId: "a", runId: "new", startedAt: NOW - MIN });
		expect(composeInstanceActivity([older, newer], new Map(), NOW)[0].lastOutcome?.runId).toBe("new");
		expect(composeInstanceActivity([newer, older], new Map(), NOW)[0].lastOutcome?.runId).toBe("new");
	});

	it("is ordered by instance id, so two polls can be diffed", () => {
		const out = composeInstanceActivity(
			[run({ instanceId: "c" }), run({ instanceId: "a" })],
			new Map([["b", 1]]),
			NOW,
		);
		expect(out.map((r) => r.instanceId)).toEqual(["a", "b", "c"]);
	});

	it("merges a run and a queue entry on the same instance into ONE record", () => {
		const out = composeInstanceActivity([run({ instanceId: "a" })], new Map([["a", 4]]), NOW);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ instanceId: "a", health: "working", queueDepth: 4 });
	});

	describe("lastAdmissionFailure (#1404)", () => {
		const failure = (over: Partial<{ queueEntryId: string; reason: string | null; objective: string; failedAt: number }> = {}) => ({
			queueEntryId: "objq-1",
			reason: "Issue #9 is closed on GitHub.",
			objective: "fix #9",
			failedAt: NOW - MIN,
			...over,
		});

		it("is the only signal for an instance that never became a run and never had a queue depth — otherwise plain idle", () => {
			// The exact gap the issue reports: a closed-while-queued objective left `pending` the
			// moment it failed (depth 0) and never got a run row (no `lastOutcome`), so without this
			// the instance was indistinguishable from one that was simply never used.
			const [rec] = composeInstanceActivity([], new Map(), NOW, new Map([["a", failure()]]));
			expect(rec).toMatchObject({ instanceId: "a", health: "idle", queueDepth: 0, lastOutcome: null, lastAdmissionFailure: failure() });
		});

		it("defaults to null when nothing failed admission", () => {
			const [rec] = composeInstanceActivity([run({ instanceId: "a" })], new Map(), NOW);
			expect(rec.lastAdmissionFailure).toBeNull();
		});

		it("merges onto the same record as a run or queue entry on that instance, not a separate row", () => {
			const out = composeInstanceActivity([run({ instanceId: "a" })], new Map([["a", 2]]), NOW, new Map([["a", failure()]]));
			expect(out).toHaveLength(1);
			expect(out[0]).toMatchObject({ instanceId: "a", queueDepth: 2, lastAdmissionFailure: failure() });
		});
	});
});
