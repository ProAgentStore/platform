import { describe, expect, it } from "vitest";
import { BUILD_HISTORY_CAP, computeETag, mergeRuns, type BuildRun } from "./build-history.js";

const run = (n: number, updatedAt: string, extra: Partial<BuildRun> = {}): BuildRun => ({
	runNumber: n,
	url: `https://github.com/o/r/actions/runs/${n}`,
	updatedAt,
	sha: `sha${n}`,
	...extra,
});

describe("build-history — mergeRuns (CODER-002, #78)", () => {
	it("dedupes by runNumber, keeping the newer updatedAt on collision", () => {
		const stored = [run(5, "2026-08-01T10:00:00Z", { conclusion: "success" })];
		const live = [run(5, "2026-08-01T11:00:00Z", { conclusion: "failure" })]; // same run, newer + changed
		const merged = mergeRuns(stored, live);
		expect(merged).toHaveLength(1);
		expect(merged[0].conclusion).toBe("failure"); // newer wins
		expect(merged[0].updatedAt).toBe("2026-08-01T11:00:00Z");
	});

	it("merges disjoint runs and sorts newest-first", () => {
		const stored = [run(1, "2026-08-01T09:00:00Z"), run(2, "2026-08-01T10:00:00Z")];
		const live = [run(3, "2026-08-01T12:00:00Z")];
		const merged = mergeRuns(stored, live);
		expect(merged.map((r) => r.runNumber)).toEqual([3, 2, 1]);
	});

	it("caps the merged history at BUILD_HISTORY_CAP, keeping the newest", () => {
		const stored = Array.from({ length: 60 }, (_, i) => run(i + 1, `2026-08-01T${String(i % 24).padStart(2, "0")}:00:00Z`));
		// give each a strictly increasing timestamp so ordering is deterministic
		const stamped = stored.map((r, i) => ({ ...r, updatedAt: `2026-08-01T00:00:${String(i).padStart(2, "0")}Z` }));
		const merged = mergeRuns(stamped, []);
		expect(merged).toHaveLength(BUILD_HISTORY_CAP);
		expect(merged[0].runNumber).toBe(60); // newest kept
		expect(merged.some((r) => r.runNumber === 1)).toBe(false); // oldest dropped
	});

	it("falls back to URL as the dedupe key when runNumber is absent", () => {
		const a: BuildRun = { url: "https://x/1", updatedAt: "2026-08-01T10:00:00Z" };
		const b: BuildRun = { url: "https://x/1", updatedAt: "2026-08-01T11:00:00Z" };
		expect(mergeRuns([a], [b])).toHaveLength(1);
	});
});

describe("build-history — computeETag (CODER-002, #78)", () => {
	it("changes when a new build appears (latest run + count)", () => {
		const before = [run(5, "2026-08-01T10:00:00Z")];
		const after = [run(6, "2026-08-01T11:00:00Z"), run(5, "2026-08-01T10:00:00Z")];
		expect(computeETag(after)).not.toBe(computeETag(before));
	});

	it("is stable for an unchanged latest build", () => {
		const runs = [run(6, "2026-08-01T11:00:00Z"), run(5, "2026-08-01T10:00:00Z")];
		expect(computeETag(runs)).toBe(computeETag([...runs]));
	});

	it("changes when the latest run is updated in place (sha/timestamp)", () => {
		const before = [run(6, "2026-08-01T11:00:00Z", { sha: "old" })];
		const after = [run(6, "2026-08-01T11:05:00Z", { sha: "new" })];
		expect(computeETag(after)).not.toBe(computeETag(before));
	});

	it("returns a stable sentinel for empty history", () => {
		expect(computeETag([])).toBe('W/"builds-empty"');
	});
});
