/**
 * #896 — two `pags up` on one machine, named rather than suspected.
 *
 * The live state this reports: three processes on one laptop, one owning the relay link, that link
 * wedged, every coding call 504, a run failed and the queue short an entry — with the platform
 * able to say nothing, because no runner process had an identity. The counter-requirement is just
 * as important: a SLOW machine with one runner must never read as a duplicate (#913, #922, #924).
 */
import { describe, expect, it } from "vitest";
import { DUPLICATE_WINDOW_MS, describeProcess, detectDuplicateRunners, type RunnerProcessIdentity } from "./runner-duplicates.js";

const NOW = Date.parse("2026-10-01T10:00:00Z");
const sample = (over: Partial<RunnerProcessIdentity> = {}): RunnerProcessIdentity => ({
	instanceId: "i1",
	node: "pink-laptop",
	startedAt: Date.parse("2026-10-01T09:12:00Z"),
	sampledAt: NOW - 10_000,
	...over,
});

describe("detecting a duplicate runner (#896)", () => {
	it("one process serving many agents is ONE runner, however many rows it writes", () => {
		const v = detectDuplicateRunners([sample({ instanceId: "i1" }), sample({ instanceId: "i2" }), sample({ instanceId: "i3" })], NOW);
		expect(v.duplicate).toBe(false);
		expect(v.processes).toHaveLength(1);
		expect(v.processes[0].instanceIds).toEqual(["i1", "i2", "i3"]);
		expect(v.detail).toBe("");
	});

	it("THE LIVE CASE: two start times for one machine is two processes, and it says which", () => {
		const v = detectDuplicateRunners(
			[
				sample({ instanceId: "i1", startedAt: Date.parse("2026-09-26T08:00:00Z"), pid: 4121, launch: "tty" }),
				sample({ instanceId: "i2", startedAt: Date.parse("2026-09-30T22:10:00Z"), pid: 977, launch: "tmux" }),
			],
			NOW,
		);
		expect(v.duplicate).toBe(true);
		expect(v.processes).toHaveLength(2);
		// Oldest first, so the reader sees the stale one at the front.
		expect(v.processes.map((p) => p.pid)).toEqual([4121, 977]);
		expect(v.detail).toMatch(/2 `pags up` processes are running on pink-laptop/);
		expect(v.detail).toMatch(/pid 4121, in a terminal/);
		expect(v.detail).toMatch(/pid 977, in a tmux session/);
		// The fix, not "restart `pags up`" — which with the old CLI made a third process.
		expect(v.detail).toMatch(/pags up --replace/);
		expect(v.detail).toMatch(/pags down/);
	});

	it("counts by `rsid` when the CLI reports one, so a restart at the same ms is still one process", () => {
		const v = detectDuplicateRunners([sample({ instanceId: "i1", rsid: "A" }), sample({ instanceId: "i2", rsid: "A" })], NOW);
		expect(v.duplicate).toBe(false);
		expect(v.processes[0].rsid).toBe("A");
	});

	it("two rsids on one machine is a duplicate even when their start times match", () => {
		const v = detectDuplicateRunners([sample({ rsid: "A", instanceId: "i1" }), sample({ rsid: "B", instanceId: "i2" })], NOW);
		expect(v.duplicate).toBe(true);
		expect(v.processes.map((p) => p.rsid)).toEqual(["A", "B"]);
	});

	it("a MIXED fleet counts correctly — the un-updated machines are the ones most likely to duplicate", () => {
		const v = detectDuplicateRunners([sample({ rsid: "new-cli", instanceId: "i1" }), sample({ startedAt: Date.parse("2026-09-26T08:00:00Z"), instanceId: "i2" })], NOW);
		expect(v.duplicate).toBe(true);
		expect(v.processes.map((p) => p.rsid)).toEqual([null, "new-cli"]);
	});

	it("a stale heartbeat is not a live process: a runner that exited is not blamed for a duplicate", () => {
		const gone = sample({ instanceId: "i2", startedAt: Date.parse("2026-09-26T08:00:00Z"), sampledAt: NOW - DUPLICATE_WINDOW_MS - 1 });
		expect(detectDuplicateRunners([sample(), gone], NOW).duplicate).toBe(false);
		// Right at the edge it still counts — three missed 30s beats, not two.
		const edge = { ...gone, sampledAt: NOW - DUPLICATE_WINDOW_MS };
		expect(detectDuplicateRunners([sample(), edge], NOW).duplicate).toBe(true);
	});

	it("SLOW IS NOT DUPLICATE: one runner on a saturated machine reports one process", () => {
		// The whole input is heartbeats, so load cannot manufacture a second identity. A machine at
		// 6 per core with one runner answers late and still has exactly one start time.
		const late = [sample({ instanceId: "i1", sampledAt: NOW - 80_000 }), sample({ instanceId: "i2", sampledAt: NOW - 85_000 })];
		expect(detectDuplicateRunners(late, NOW).duplicate).toBe(false);
	});

	it("ignores a sample with no process start time at all, rather than counting it as a process", () => {
		expect(detectDuplicateRunners([sample(), sample({ instanceId: "i2", startedAt: 0 })], NOW).duplicate).toBe(false);
		expect(detectDuplicateRunners([], NOW)).toEqual({ duplicate: false, processes: [], detail: "" });
	});

	it("describes a process a reader can go and find", () => {
		expect(describeProcess({ key: "k", rsid: "abcdef12-0000", pid: 4121, launch: "tmux", startedAt: "2026-10-01T09:12:00.000Z", instanceIds: [] })).toBe("pid 4121, in a tmux session, started 2026-10-01T09:12:00.000Z");
		// No pid (an older CLI): the runner id stands in, shortened.
		expect(describeProcess({ key: "k", rsid: "abcdef12-0000", pid: null, launch: null, startedAt: "x", instanceIds: [] })).toBe("runner abcdef12, started x");
		expect(describeProcess({ key: "k", rsid: null, pid: null, launch: null, startedAt: "x", instanceIds: [] })).toBe("an unidentified runner, started x");
	});
});
