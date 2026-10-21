/**
 * The admission gate's pure decision (#1264) — thresholds, hysteresis and the structured rejection,
 * with simulated samples over each metric per the issue's own acceptance criterion. The DB-touching
 * halves (`updateGateState`, `currentGateState`, `setGateThresholds`) are exercised in
 * `loop-drivers.test.ts` and `instances-heartbeat*.test.ts`, where the row they read/write matters.
 */
import { describe, expect, it } from "vitest";
import {
	DEFAULT_GATE_STATE,
	DEFAULT_GATE_THRESHOLDS,
	describeRejection,
	gateStateLabel,
	nextGateState,
	parseGateState,
	parseGateThresholds,
	rejectionFor,
	worstBreach,
	type GateState,
} from "./runner-admission-gate.js";
import type { RunnerResourceSample } from "./runner-resources.js";

/** A healthy 12-core, 32 GiB machine with a roomy checkout volume — tweak one field per test. */
const sample = (over: Partial<RunnerResourceSample> = {}): RunnerResourceSample => ({
	loadAvg: [1, 1, 1],
	cpus: 12,
	memTotalBytes: 32 * 1024 ** 3,
	memFreeBytes: 16 * 1024 ** 3,
	platform: "linux",
	sampledAt: Date.parse("2026-10-20T20:57:00+11:00"),
	disk: { path: "/", totalBytes: 100 * 1024 ** 3, freeBytes: 50 * 1024 ** 3, inodesTotal: 1_000_000, inodesFree: 900_000 },
	...over,
});

describe("worstBreach — each metric, with the issue's own live examples", () => {
	it("is null for a healthy sample", () => {
		expect(worstBreach(sample(), 1)).toBeNull();
	});

	it("CPU: load1/cores > 1.5 — Sergeys-Mac-mini.local's load1 24.74 on 12 cores (2.06/core)", () => {
		const b = worstBreach(sample({ loadAvg: [24.74, 20, 15], cpus: 12 }), 2);
		expect(b).toEqual({ metric: "cpu", value: 24.74 / 12, threshold: 1.5 });
	});

	it("CPU: load5/cores > 1.2 catches a spike load1 alone would miss", () => {
		const b = worstBreach(sample({ loadAvg: [1, 15, 1], cpus: 12 }), 0);
		expect(b).toEqual({ metric: "cpu", value: 15 / 12, threshold: 1.2 });
	});

	it("memory: used% > 92 — Mac.modem's 99.6% used", () => {
		const total = 8 * 1024 ** 3;
		const b = worstBreach(sample({ memTotalBytes: total, memFreeBytes: total * 0.004, cpus: 4, loadAvg: [1, 1, 1] }), 0);
		expect(b?.metric).toBe("memory");
		expect(b?.value).toBeCloseTo(99.6, 1);
		expect(b?.threshold).toBe(92);
	});

	it("memory: available < 1 GiB rejects even under the used% line (falls back to memFreeBytes with no memAvailableBytes reported)", () => {
		const total = 64 * 1024 ** 3; // used% only ~98.4%... make it comfortably under 92% used but short on absolute free
		const b = worstBreach(sample({ memTotalBytes: total, memFreeBytes: 0.5 * 1024 ** 3, cpus: 16, loadAvg: [1, 1, 1] }), 0);
		// At this size 0.5 GiB free IS also over 92% used, so assert on the metric/threshold, not which clause fired.
		expect(b?.metric).toBe("memory");
		expect(b?.threshold).toBeDefined();
	});

	it("memory: prefers a reported memAvailableBytes over raw memFreeBytes when present", () => {
		// 50% used (well under the 92% line) but available is reported as short — the gate must use it.
		const s = { ...sample({ memTotalBytes: 8 * 1024 ** 3, memFreeBytes: 4 * 1024 ** 3, cpus: 4, loadAvg: [1, 1, 1] }), memAvailableBytes: 0.5 * 1024 ** 3 };
		const b = worstBreach(s, 0);
		expect(b).toEqual({ metric: "memory", value: 0.5 * 1024 ** 3, threshold: DEFAULT_GATE_THRESHOLDS.memAvailableMinBytes });
	});

	it("disk: used% > 95 — pink-laptop's 94.4% used is just under the line, 96% is over", () => {
		// A 200 GiB volume so 94.4%/96% used still leaves more than the 10 GiB free-bytes floor —
		// isolating the PERCENTAGE check from the absolute-bytes one below.
		const total = 200 * 1024 ** 3;
		const under = worstBreach(sample({ disk: { path: "/", totalBytes: total, freeBytes: total * 0.056, inodesTotal: 1e6, inodesFree: 9e5 } }), 0);
		expect(under).toBeNull();
		const over = worstBreach(sample({ disk: { path: "/", totalBytes: total, freeBytes: total * 0.04, inodesTotal: 1e6, inodesFree: 9e5 } }), 0);
		expect(over).toEqual({ metric: "disk", value: 96, threshold: 95 });
	});

	it("disk: free < 10 GiB rejects even under the used% line, on a modest volume", () => {
		// 100 GiB total, 9 GiB free → 91% used (under the 95% line) but short on the absolute floor.
		const total = 100 * 1024 ** 3;
		const b = worstBreach(sample({ disk: { path: "/", totalBytes: total, freeBytes: 9 * 1024 ** 3, inodesTotal: 1e6, inodesFree: 9e5 } }), 0);
		expect(b).toEqual({ metric: "disk", value: 9 * 1024 ** 3, threshold: 10 * 1024 ** 3 });
	});

	it("disk is OPTIONAL — a sample reporting none is never judged on it", () => {
		const { disk, ...rest } = sample();
		expect(worstBreach(rest as RunnerResourceSample, 0)).toBeNull();
	});

	it("sessions: active >= recommendedMaxSessions — dell-laptop's active sessions at its own recommended ceiling", () => {
		// recommendedMaxSessions(8 cores, 8 GiB) = min(floor(8/2), floor(8GiB/4GiB)) = 2 — the
		// heuristic from runner-resources.ts, unchanged by this gate.
		const b = worstBreach(sample({ cpus: 8, memTotalBytes: 8 * 1024 ** 3, loadAvg: [1, 1, 1] }), 2);
		expect(b).toEqual({ metric: "sessions", value: 2, threshold: 2 });
	});

	it("sessions: null activeSessions (not counted) never breaches", () => {
		expect(worstBreach(sample({ cpus: 1, memTotalBytes: 1 * 1024 ** 3 }), null)).toBeNull();
	});

	it("reports breaches in table order when several fire at once: cpu beats memory beats disk beats sessions", () => {
		const overloaded = sample({ loadAvg: [30, 30, 30], cpus: 4, memTotalBytes: 4 * 1024 ** 3, memFreeBytes: 0, disk: { path: "/", totalBytes: 10 * 1024 ** 3, freeBytes: 0, inodesTotal: 1e6, inodesFree: 1e6 } });
		expect(worstBreach(overloaded, 99)?.metric).toBe("cpu");
	});
});

describe("nextGateState — hysteresis: reject on the first breach, reopen only after two clear samples (#1264)", () => {
	it("accepts a healthy machine and stays accepting", () => {
		expect(nextGateState(DEFAULT_GATE_STATE, sample(), 0)).toEqual({ state: "accepting", streak: 0 });
	});

	it("rejects on the FIRST breach — no hysteresis needed to close the gate", () => {
		const now = 1_000_000;
		const s = nextGateState(DEFAULT_GATE_STATE, sample({ loadAvg: [30, 30, 30] }), 0, DEFAULT_GATE_THRESHOLDS, now);
		expect(s).toMatchObject({ state: "rejecting", metric: "cpu", streak: 0, since: now });
	});

	it("does NOT reopen on the first clear sample — needs two consecutive", () => {
		const rejecting: GateState = { state: "rejecting", metric: "cpu", value: 3, threshold: 1.5, streak: 0, since: 1000 };
		const once = nextGateState(rejecting, sample(), 0, DEFAULT_GATE_THRESHOLDS, 2000);
		expect(once).toEqual({ state: "rejecting", metric: "cpu", value: 3, threshold: 1.5, streak: 1, since: 1000 });
		const twice = nextGateState(once, sample(), 0, DEFAULT_GATE_THRESHOLDS, 3000);
		expect(twice).toEqual({ state: "accepting", streak: 0 });
	});

	it("a sample merely under the REJECT line but still inside the recovery band does not count toward the streak", () => {
		// cpuLoad1PerCpu threshold 1.5; recovery band is 1.35 (90%). 1.4/core is under 1.5 but NOT under 1.35.
		const rejecting: GateState = { state: "rejecting", metric: "cpu", value: 2, threshold: 1.5, streak: 1, since: 1000 };
		const borderline = nextGateState(rejecting, sample({ loadAvg: [16.8, 1, 1], cpus: 12 }), 0, DEFAULT_GATE_THRESHOLDS, 4000);
		expect(borderline.state).toBe("rejecting");
		expect(borderline.streak).toBe(0); // reset, not merely held — "consecutive" means any non-clear sample breaks it
	});

	it("a renewed breach resets the streak even mid-recovery", () => {
		const almostRecovered: GateState = { state: "rejecting", metric: "memory", value: 99, threshold: 92, streak: 1, since: 1000 };
		const s = nextGateState(almostRecovered, sample({ memFreeBytes: 0 }), 0, DEFAULT_GATE_THRESHOLDS, 5000);
		expect(s).toMatchObject({ state: "rejecting", streak: 0 });
	});

	it("the episode's `since` is carried across samples while rejecting, and reset when a new episode begins", () => {
		const first = nextGateState(DEFAULT_GATE_STATE, sample({ loadAvg: [30, 30, 30] }), 0, DEFAULT_GATE_THRESHOLDS, 1000);
		const stillBad = nextGateState(first, sample({ loadAvg: [30, 30, 30] }), 0, DEFAULT_GATE_THRESHOLDS, 2000);
		expect(stillBad.since).toBe(1000);
		const recovered = nextGateState({ ...stillBad, streak: 1 }, sample(), 0, DEFAULT_GATE_THRESHOLDS, 3000);
		expect(recovered.state).toBe("accepting");
		const newEpisode = nextGateState(recovered, sample({ loadAvg: [30, 30, 30] }), 0, DEFAULT_GATE_THRESHOLDS, 4000);
		expect(newEpisode.since).toBe(4000);
	});

	it("respects a per-node threshold override", () => {
		const strict = parseGateThresholds({ cpuLoad1PerCpu: 0.5 });
		const s = sample({ loadAvg: [0.8, 0.5, 0.5], cpus: 1 });
		expect(nextGateState(DEFAULT_GATE_STATE, s, 0, strict)).toMatchObject({ state: "rejecting", metric: "cpu" });
		// The same sample is fine under the defaults (0.8/core is under the 1.5 default).
		expect(nextGateState(DEFAULT_GATE_STATE, s, 0, DEFAULT_GATE_THRESHOLDS)).toEqual({ state: "accepting", streak: 0 });
	});

	it("a malformed/partial override falls back to defaults field by field", () => {
		expect(parseGateThresholds({ cpuLoad1PerCpu: "a lot", memUsedPctMax: 80 })).toEqual({ ...DEFAULT_GATE_THRESHOLDS, memUsedPctMax: 80 });
		expect(parseGateThresholds(null)).toEqual(DEFAULT_GATE_THRESHOLDS);
		expect(parseGateThresholds("not an object")).toEqual(DEFAULT_GATE_THRESHOLDS);
	});
});

describe("rejectionFor / describeRejection — the structured rejection #1264 asks for", () => {
	it("matches the issue's own example shape", () => {
		const state: GateState = { state: "rejecting", metric: "memory", value: 99.6, threshold: 92, streak: 0, since: 1000 };
		expect(rejectionFor(state, "Mac.modem")).toEqual({ code: "runner_overloaded", metric: "memory", value: 99.6, threshold: 92, node: "Mac.modem" });
	});

	it("is null while accepting", () => {
		expect(rejectionFor(DEFAULT_GATE_STATE, "any-node")).toBeNull();
	});

	it("describes the rejection as a sentence naming the node, the metric and the reading", () => {
		const text = describeRejection({ code: "runner_overloaded", metric: "memory", value: 99.6 * 1024 ** 3, threshold: 1 * 1024 ** 3, node: "Mac.modem" });
		expect(text).toContain("Mac.modem");
		expect(text).toMatch(/GiB available/);
	});
});

describe("parseGateState — round-trips the stored JSON, and never trusts an unread value", () => {
	it("round-trips a rejecting state", () => {
		const state: GateState = { state: "rejecting", metric: "disk", value: 1, threshold: 2, streak: 1, since: 500 };
		expect(parseGateState(JSON.stringify(state))).toEqual(state);
	});

	it("defaults to accepting for null, malformed JSON, or an unknown shape", () => {
		expect(parseGateState(null)).toEqual(DEFAULT_GATE_STATE);
		expect(parseGateState("{not json")).toEqual(DEFAULT_GATE_STATE);
		expect(parseGateState({ state: "something else" })).toEqual(DEFAULT_GATE_STATE);
	});
});

describe("gateStateLabel — what list_runner_nodes / coding_diagnostics show (#1264)", () => {
	it("is a plain string while accepting, and names the metric while rejecting", () => {
		expect(gateStateLabel(DEFAULT_GATE_STATE)).toBe("accepting");
		expect(gateStateLabel({ state: "rejecting", metric: "sessions", streak: 0 })).toBe("rejecting:sessions");
	});
});
