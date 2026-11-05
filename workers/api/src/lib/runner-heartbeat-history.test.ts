import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RealSchemaD1, realSchemaD1 } from "./d1-sqlite.js";
import { recordHeartbeatReceipt, runnerAvailability } from "./runner-heartbeat-history.js";

const NOW = Date.parse("2026-11-06T08:00:00Z");
const keys = Array.from({ length: 91 }, (_, i) => `machine-${i}`);
let db: RealSchemaD1;

beforeEach(async () => {
	db = realSchemaD1();
	db.exec("INSERT INTO users (id, github_login) VALUES ('owner', 'owner')");
	for (const [i, key] of keys.entries()) {
		// The omitted machine has a distinct bucket, so including it cannot hide in an aggregate.
		await recordHeartbeatReceipt({ DB: db.DB }, "owner", key, key, i === 90 ? NOW - 60_000 : NOW);
	}
});
afterEach(() => db.close());

describe("heartbeat machine-ID boundary (#1562)", () => {
	// Invariant: the D1 query includes at most 90 DISTINCT IDs and explicitly reports omissions.
	it.each([
		{ unique: 90, duplicates: false, truncated: false },
		{ unique: 90, duplicates: true, truncated: false },
		{ unique: 91, duplicates: true, truncated: true },
	])("bounds $unique unique IDs (duplicates: $duplicates) with truncated=$truncated", async ({ unique, duplicates, truncated }) => {
		const requested = keys.slice(0, unique).flatMap((key) => duplicates ? [key, key] : [key]);
		const result = await runnerAvailability({ DB: db.DB }, "owner", requested, NOW - 120_000, NOW, NOW);
		expect(result).toEqual({
			source: "heartbeat_receipts",
			bucketMs: 60_000,
			from: new Date(NOW - 120_000).toISOString(),
			to: new Date(NOW).toISOString(),
			retentionMs: 86_400_000,
			coverage: "observed_only",
			missingBucketMeaning: "no_recorded_receipt",
			error: null,
			truncated,
			buckets: [{ at: new Date(NOW).toISOString(), receipts: 90, firstReceivedAt: new Date(NOW).toISOString(), lastReceivedAt: new Date(NOW).toISOString() }],
		});
	});
});
