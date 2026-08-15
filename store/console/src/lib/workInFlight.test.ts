import { describe, expect, it } from "vitest";
import { activityLabel, adoptableRun, isChatWorking, isOpen, runActivity, shouldAdopt, type LoopRunLike } from "./workInFlight";

const run = (over: Partial<LoopRunLike> & { runId: string; status: string; startedAt?: number }) => over;

describe("isOpen", () => {
	it("only the server's own word for open counts", () => {
		expect(isOpen({ status: "running" })).toBe(true);
		// The terminal vocabulary — none of these is an open run.
		for (const status of ["completed", "failed", "needs_human", "cancelled"]) {
			expect(isOpen({ status })).toBe(false);
		}
		expect(isOpen(null)).toBe(false);
		expect(isOpen(undefined)).toBe(false);
	});

	it("says OPEN, not alive — a parked and a stalled run are both still `running`", () => {
		// The comment that used to sit on this function said "a run is live only while the server
		// says `running`". Since `fd1c323` that is false: `running` covers working, waiting AND
		// stalled, and a comment asserting an agreement that no longer holds is worse than none.
		for (const health of ["working", "waiting", "stalled"] as const) {
			expect(isOpen(run({ runId: "r", status: "running", health })), health).toBe(true);
		}
	});
});

describe("runActivity — the console quotes the verdict instead of deriving a third one (#589)", () => {
	/**
	 * The measured run: parked 4.35 hours on the coding CLI's own usage limit. Every field here is
	 * what `GET /loop` sends for it. Before this, the row rendered "step 1/40 · started 4h ago"
	 * with a live Stop button and no hint that nothing had advanced since it parked — while
	 * `check_instance_loop` answered `waiting` about the same row at the same instant.
	 */
	const parked = run({
		runId: "70ea298e",
		status: "running",
		health: "waiting",
		waitNote: "WAITING, not stalled and not working — the coding CLI's own usage limit has to reset, expected to resume in 1h.",
		iteration: 1,
		maxIterations: 40,
		startedAt: Date.now() - 4.35 * 60 * 60_000,
	});

	it("reports a parked run as waiting, never as working", () => {
		expect(runActivity(parked)).toBe("waiting");
		expect(runActivity(parked)).not.toBe("working");
	});

	it("shows the owner WHY it is parked, in the server's own words", () => {
		const label = activityLabel(parked);
		expect(label).toMatch(/^Waiting/);
		expect(label).toContain("usage limit");
	});

	it("falls back to the bare word rather than inventing a reason", () => {
		expect(activityLabel(run({ runId: "r", status: "running", health: "waiting" }))).toMatch(/^Waiting/);
		expect(activityLabel(run({ runId: "r", status: "running", health: "waiting" }))).not.toContain("usage limit");
	});

	it("labels a stalled run so it stops looking like a working one", () => {
		expect(activityLabel(run({ runId: "r", status: "running", health: "stalled" }))).toMatch(/Stalled/);
	});

	it("says NOTHING for a healthy or a closed run — a label on those is noise", () => {
		expect(activityLabel(run({ runId: "r", status: "running", health: "working" }))).toBeNull();
		expect(activityLabel(run({ runId: "r", status: "completed", health: "ended" }))).toBeNull();
	});

	it("renders no verdict at all when the server sent none, rather than guessing one", () => {
		// A cached or older response. The page must not fill the gap: a plausible default is how
		// this surface came to state a liveness nobody had told it.
		expect(runActivity(run({ runId: "r", status: "running" }))).toBeNull();
		expect(runActivity(run({ runId: "r", status: "running", health: "nonsense" as never }))).toBeNull();
		expect(activityLabel(run({ runId: "r", status: "running" }))).toBeNull();
		expect(runActivity(null)).toBeNull();
	});
});

describe("adoptableRun", () => {
	it("THE BUG: a run started in another tab (or before a remount) is adoptable", () => {
		const runs = [run({ runId: "r1", status: "running", startedAt: 5 })];
		expect(adoptableRun(runs)?.runId).toBe("r1");
	});
	it("adopts a PARKED run — it is still the run in flight, and watching it is how you find out", () => {
		expect(adoptableRun([run({ runId: "r1", status: "running", health: "waiting", startedAt: 5 })])?.runId).toBe("r1");
	});
	it("picks the newest running run, not a stale one stuck at running", () => {
		const runs = [
			run({ runId: "old", status: "running", startedAt: 1 }),
			run({ runId: "new", status: "running", startedAt: 9 }),
		];
		expect(adoptableRun(runs)?.runId).toBe("new");
	});
	it("finished runs are never adopted — coming back to a done run must clear, not claim", () => {
		expect(adoptableRun([run({ runId: "r1", status: "completed" }), run({ runId: "r2", status: "cancelled" })])).toBeNull();
	});
	it("survives a missing/!array payload", () => {
		expect(adoptableRun(undefined)).toBeNull();
		expect(adoptableRun(null)).toBeNull();
		expect(adoptableRun([])).toBeNull();
	});
});

describe("shouldAdopt", () => {
	it("adopts a run this tab is not already watching", () => {
		expect(shouldAdopt(null, run({ runId: "r1", status: "running" }))).toBe(true);
		expect(shouldAdopt("other", run({ runId: "r1", status: "running" }))).toBe(true);
	});
	it("never re-adopts the run it is already watching (would re-announce completion)", () => {
		expect(shouldAdopt("r1", run({ runId: "r1", status: "running" }))).toBe(false);
	});
	it("nothing to adopt", () => {
		expect(shouldAdopt(null, null)).toBe(false);
	});
});

describe("isChatWorking", () => {
	it("in-flight markers are the answer", () => {
		expect(isChatWorking({ inflight: [{ turnId: "t", startedAt: 1 }] })).toBe(true);
		expect(isChatWorking({ inflight: [] })).toBe(false);
	});
	it("status alone is NOT trusted in either direction", () => {
		// A cold DO reports idle whatever happened; a dead one could leave `thinking` forever.
		expect(isChatWorking({ status: "thinking", inflight: [] })).toBe(false);
		expect(isChatWorking({ status: "idle", inflight: [{ turnId: "t", startedAt: 1 }] })).toBe(true);
	});
	it("an older server with no inflight field reads as not working", () => {
		expect(isChatWorking({ status: "thinking" })).toBe(false);
		expect(isChatWorking(null)).toBe(false);
	});
});
