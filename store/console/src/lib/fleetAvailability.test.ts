import { describe, expect, it } from "vitest";
import { availabilityLanes, heartbeatAge, type HeartbeatAvailability } from "./fleetAvailability";
import { type FleetMachine, fleetRow } from "./fleetTelemetry";

const NOW = Date.parse("2026-11-06T06:00:00Z");
const stamp = (offset: number) => new Date(NOW + offset).toISOString();
const bucket = (first: number, last = first, receipts = 1) => ({ at: stamp(Math.floor(first / 60_000) * 60_000), receipts, firstReceivedAt: stamp(first), lastReceivedAt: stamp(last) });
const history = (over: Partial<HeartbeatAvailability> = {}): HeartbeatAvailability => ({ source: "heartbeat_receipts", bucketMs: 60_000, from: stamp(-7_200_000), to: stamp(0), retentionMs: 86_400_000, coverage: "observed_only", missingBucketMeaning: "no_recorded_receipt", error: null, truncated: false, buckets: [], ...over });
const machine = (name: string, availability?: HeartbeatAvailability): FleetMachine => ({ key: name, name, machineId: `id-${name}`, node: name, aka: [], lastSeenAt: stamp(-1000), sampledAt: stamp(-1000), stale: false, sampleAgeSec: 1, latest: null, points: [{ at: stamp(-1000), loadPerCpu: 1, memUsedPct: 40, diskUsedPct: 50, relayRttMs: 10, starts24h: 1, sessionCount: 1 }], availability });

describe("heartbeat receipt availability", () => {
	it("never manufactures heartbeat evidence from fresh resource samples or lastSeenAt", () => {
		const [lane] = availabilityLanes([machine("pink")], "dense", NOW);
		expect(lane.marks).toEqual([]);
		expect(lane.lastReceivedAt).toBeNull();
		expect(heartbeatAge(lane.lastReceivedAt, NOW)).toBe("No recorded heartbeat");
	});

	it("projects only actual receipt endpoints, without extending to bin edges or bridging empty bins", () => {
		const [lane] = availabilityLanes([machine("pink", history({ bucketMs: 300_000, buckets: [bucket(-300_000), bucket(-35_000, -25_000, 3)] }))], "coarse", NOW);
		expect(lane.marks).toHaveLength(2);
		expect(lane.marks[0].firstX).toBe(lane.marks[0].lastX);
		expect(lane.marks[1].firstMs).toBe(NOW - 35_000);
		expect(lane.marks[1].lastMs).toBe(NOW - 25_000);
		expect(lane.marks[1].lastX - lane.marks[1].firstX).toBeCloseTo(10_000 / 86_400_000 * 1000);
		expect(lane.lastReceivedAt).toBe(NOW - 25_000);
		expect(heartbeatAge(lane.lastReceivedAt, NOW)).toBe("Last heartbeat 25s ago");
	});

	it("ignores invalid, empty, future and out-of-window records", () => {
		const [lane] = availabilityLanes([machine("pink", history({ buckets: [bucket(-10_000), bucket(-20_000, -30_000, 2), bucket(-30_000, -20_000, 0), bucket(1000), bucket(-86_400_001), { ...bucket(-2000), firstReceivedAt: "corrupt" }] }))], "dense", NOW);
		expect(lane.marks).toHaveLength(1);
		expect(lane.marks[0].receipts).toBe(1);
	});

	it("shares canonical order and machine colors with the table across range and arrival changes", () => {
		const machines = [machine("tiny", history({ buckets: [bucket(-5000)] })), machine("Dell", history()), machine("pink", history())];
		for (const tier of ["dense", "coarse"] as const) {
			const lanes = availabilityLanes([...machines].reverse(), tier, NOW);
			expect(lanes.map((lane) => lane.name)).toEqual(["Dell", "pink", "tiny"]);
			for (const lane of lanes) expect(lane.colorIndex).toBe(fleetRow(machines.find((m) => m.key === lane.key)!).colorIndex);
		}
	});

	it("retains explicit unavailable/partial history instead of treating missing data as down", () => {
		const [lane] = availabilityLanes([machine("tiny", history({ error: "read failed", truncated: true }))], "dense", NOW);
		expect(lane).toMatchObject({ readError: true, partial: true, marks: [], lastReceivedAt: null });
	});
});
