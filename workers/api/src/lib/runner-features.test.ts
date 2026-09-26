import { describe, expect, it } from "vitest";
import { BOOTSTRAP_MIN_CLI, RUNNER_CONTROL_MIN_CLI, RUNNER_FEATURES, runnerFeatureGaps, runnerVersionView } from "./runner-features.js";

describe("what a runner version is too old for (#859)", () => {
	it("the machine in #859 (0.4.60) is behind on clone, force-attach and runner_update — and nothing older", () => {
		const gaps = runnerFeatureGaps("0.4.60")?.map((g) => g.feature) ?? [];
		expect(gaps).toEqual(expect.arrayContaining([expect.stringMatching(/^runner_update/), expect.stringMatching(/^coding_repo_add clone/), expect.stringMatching(/^force_runner_attach/)]));
		expect(gaps).not.toContain("fast-forward a stale checkout");
	});

	it("a current runner is behind on nothing; an unknown version is not judged", () => {
		expect(runnerFeatureGaps(BOOTSTRAP_MIN_CLI)).toEqual([]);
		expect(runnerFeatureGaps("")).toBeNull();
		expect(runnerVersionView(null)).toEqual({ runnerVersion: null, behind: null });
	});

	it("reports each gap with the version it needs", () => {
		expect(runnerVersionView("0.4.58").behind).toContain("fast-forward a stale checkout (needs 0.4.59)");
		expect(RUNNER_FEATURES.every((f) => /^\d+\.\d+\.\d+$/.test(f.minCli))).toBe(true);
	});

	it("a machine on 0.4.62 can be updated remotely but has no self-updating stub yet (#862)", () => {
		expect(runnerFeatureGaps(RUNNER_CONTROL_MIN_CLI)?.map((g) => g.feature)).toEqual(["self-updating pags up (never needs a manual install again)"]);
	});
});
