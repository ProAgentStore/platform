import { describe, expect, it } from "vitest";
import { adoptableRun, isChatWorking, isRunning, shouldAdopt } from "./workInFlight";

const run = (over: Partial<Parameters<typeof isRunning>[0]> & { runId: string; status: string; startedAt?: number }) => over;

describe("isRunning", () => {
	it("only the server's own word for live counts", () => {
		expect(isRunning({ status: "running" })).toBe(true);
		// The terminal vocabulary — none of these should keep a "working" indicator up.
		for (const status of ["completed", "failed", "needs_human", "cancelled"]) {
			expect(isRunning({ status })).toBe(false);
		}
		expect(isRunning(null)).toBe(false);
		expect(isRunning(undefined)).toBe(false);
	});
});

describe("adoptableRun", () => {
	it("THE BUG: a run started in another tab (or before a remount) is adoptable", () => {
		const runs = [run({ runId: "r1", status: "running", startedAt: 5 })];
		expect(adoptableRun(runs)?.runId).toBe("r1");
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
