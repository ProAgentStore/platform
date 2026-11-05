import { type FleetMachine, type FleetTier, machineColorIndex, sortedMachines, TIER_WINDOW_MS } from "./fleetTelemetry";

/** Received by PAGS, independently of resource timestamps and relay ping results. */
export interface HeartbeatAvailability {
	source: "heartbeat_receipts";
	bucketMs: number;
	from: string;
	to: string;
	retentionMs: number;
	coverage: "observed_only";
	missingBucketMeaning: "no_recorded_receipt";
	error: string | null;
	truncated: boolean;
	buckets: Array<{ at: string; receipts: number; firstReceivedAt: string; lastReceivedAt: string }>;
}

export interface HeartbeatMark {
	firstMs: number;
	lastMs: number;
	firstX: number;
	lastX: number;
	receipts: number;
}

export interface AvailabilityLane {
	key: string;
	name: string;
	colorIndex: number;
	marks: HeartbeatMark[];
	lastReceivedAt: number | null;
	partial: boolean;
	readError: boolean;
}

/** Observations only: never turn resource samples, bin width or a gap into an availability claim. */
export function availabilityLanes(machines: readonly FleetMachine[], tier: FleetTier, nowMs: number): AvailabilityLane[] {
	const from = nowMs - TIER_WINDOW_MS[tier];
	const x = (at: number) => Math.min(1000, Math.max(0, (at - from) / (nowMs - from) * 1000));
	return sortedMachines(machines).map((machine) => {
		const history = machine.availability;
		const marks: HeartbeatMark[] = [];
		if (history?.source === "heartbeat_receipts" && history.coverage === "observed_only") {
			for (const bucket of history.buckets) {
				const firstMs = Date.parse(bucket.firstReceivedAt), lastMs = Date.parse(bucket.lastReceivedAt);
				if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs) || firstMs > lastMs || !Number.isInteger(bucket.receipts) || bucket.receipts <= 0 || lastMs < from || firstMs > nowMs) continue;
				marks.push({ firstMs, lastMs, firstX: x(firstMs), lastX: x(lastMs), receipts: bucket.receipts });
			}
		}
		marks.sort((a, b) => a.firstMs - b.firstMs || a.lastMs - b.lastMs);
		return { key: machine.key, name: machine.name, colorIndex: machineColorIndex(machine), marks, lastReceivedAt: marks.length ? Math.max(...marks.map((mark) => mark.lastMs)) : null, partial: !!history?.truncated, readError: !!history?.error };
	});
}

export function heartbeatAge(at: number | null, nowMs: number): string {
	if (at === null) return "No recorded heartbeat";
	const age = Math.max(0, Math.floor((nowMs - at) / 1000));
	if (age < 90) return `Last heartbeat ${age}s ago`;
	if (age < 5400) return `Last heartbeat ${Math.round(age / 60)}m ago`;
	return `Last heartbeat ${Math.round(age / 3600)}h ago`;
}
