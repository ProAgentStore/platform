import { describe, expect, it } from "vitest";
import { deferUntil, engineResetAt, infrastructureFailure, infrastructureFailureOfDetail } from "./verification-infrastructure.js";

const NOW = Date.UTC(2026, 10, 8, 0, 0);

describe("infrastructure failures of a verification run (#1611)", () => {
	it("reads codex's absolute reset and a relative one", () => {
		expect(engineResetAt("You've hit your usage limit. Try again at Nov 11th, 2026 5:38 PM.".replace("Try", "try"), NOW)).toBe(Date.UTC(2026, 10, 11, 17, 38));
		expect(engineResetAt("try again at Dec 1, 2026 12:05 AM", NOW)).toBe(Date.UTC(2026, 11, 1, 0, 5));
		expect(engineResetAt("usage limit, try again in 2 hours", NOW)).toBe(NOW + 2 * 3_600_000);
		expect(engineResetAt("usage limit", NOW)).toBeNull();
	});
	it("classifies only an engine limit and a runner overload", () => {
		expect(infrastructureFailure("engine_failed", "You've hit your usage limit.")).toMatchObject({ kind: "engine_quota" });
		expect(infrastructureFailure("runner_overloaded", "cpu")).toEqual({ kind: "runner_overloaded", resetAt: null });
		expect(infrastructureFailure("engine_failed", "codex crashed")).toBeNull();
		expect(infrastructureFailure("runner_lost", "You've hit your usage limit.")).toBeNull();
		expect(infrastructureFailure("engine_failed", null)).toBeNull();
	});
	it("reads a stored attempt detail back", () => {
		expect(infrastructureFailureOfDetail("The verification run ended failed (engine_failed): You've hit your usage limit ...")).toMatchObject({ kind: "engine_quota" });
		expect(infrastructureFailureOfDetail("The verification run ended failed (runner_overloaded): load")).toMatchObject({ kind: "runner_overloaded" });
		expect(infrastructureFailureOfDetail("The verification run ended failed (runner_lost).")).toBeNull();
		expect(infrastructureFailureOfDetail("The run reported no typed outcome.")).toBeNull();
	});
	it("defers to a future reset (capped), else a bounded backoff", () => {
		expect(deferUntil({ kind: "engine_quota", resetAt: NOW + 3_600_000 }, NOW)).toBe(NOW + 3_600_000);
		expect(deferUntil({ kind: "engine_quota", resetAt: NOW + 30 * 86_400_000 }, NOW)).toBe(NOW + 7 * 86_400_000);
		expect(deferUntil({ kind: "engine_quota", resetAt: NOW - 1 }, NOW)).toBe(NOW + 30 * 60_000);
		expect(deferUntil({ kind: "runner_overloaded", resetAt: null }, NOW)).toBe(NOW + 10 * 60_000);
	});
});
