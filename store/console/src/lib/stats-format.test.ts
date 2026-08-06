import { describe, expect, it } from "vitest";
import { dayLabel, formatValue, gapNote, historyNote, isAllGaps, partialNote, throughDayNote, windowStartDay } from "./stats-format";
import type { StatsPoint } from "./stats-types";

const pts = (values: Array<number | null>): StatsPoint[] => values.map((value, i) => ({ day: `2026-08-0${i + 1}`, value }));

describe("units", () => {
	it("renders each unit in its own terms", () => {
		expect(formatValue(1234, "count")).toBe("1,234");
		expect(formatValue(1500, "tokens")).toBe("1.5K");
		expect(formatValue(2_500_000, "usd_micros")).toBe("$2.50");
	});

	it("does not round a real, tiny cost down to zero", () => {
		// "$0.00" on a card that cost something is a confident wrong number in miniature.
		expect(formatValue(500, "usd_micros")).toBe("<$0.01");
		expect(formatValue(0, "usd_micros")).toBe("$0.00");
	});

	it("labels a day without localizing it", () => {
		// These are UTC days from the rollup. A locale-shifted label would name a different day
		// than the value belongs to.
		expect(dayLabel("2026-08-06")).toBe("08-06");
	});
});

describe("the gap disclosure fires exactly when there is a gap", () => {
	it("says nothing about an unbroken series", () => {
		expect(gapNote(pts([1, 2, 3]))).toBeNull();
	});

	it("explains the break, and says it is not a zero", () => {
		const note = gapNote(pts([1, null, 3])) ?? "";
		expect(note).toContain("1 day has");
		expect(note).toMatch(/not a zero/i);
	});

	it("treats a recorded 0 as data, not as a gap", () => {
		expect(gapNote(pts([0, 0, 0]))).toBeNull();
		expect(isAllGaps(pts([0, 0]))).toBe(false);
		expect(isAllGaps(pts([null, null]))).toBe(true);
		// An empty series is not "all gaps" — there is nothing to be missing.
		expect(isAllGaps([])).toBe(false);
	});
});

describe("history disclosure — no backfill, so a short series must explain itself", () => {
	it("stays quiet when history predates the window", () => {
		expect(historyNote("2026-01-01", "2026-08-06", 7)).toBeNull();
	});

	it("speaks when the rollup started inside the window", () => {
		const note = historyNote("2026-08-04", "2026-08-06", 7) ?? "";
		expect(note).toContain("2026-08-04");
		expect(note).toMatch(/not because the agent was idle/i);
	});

	it("is quiet on the exact boundary — that day IS the first day shown", () => {
		expect(historyNote("2026-07-31", "2026-08-06", 7)).toBeNull();
	});

	it("says so when there is no history at all", () => {
		expect(historyNote(null, "2026-08-06", 7)).toMatch(/has not started/i);
	});

	it("computes the window's first day inclusively", () => {
		expect(windowStartDay("2026-08-06", 7)).toBe("2026-07-31");
		expect(windowStartDay("2026-08-06", 1)).toBe("2026-08-06");
		expect(windowStartDay("not-a-day", 7)).toBeNull();
	});
});

describe("the other two things a reader would otherwise get wrong", () => {
	it("says where today went", () => {
		// Today is absent on purpose: a partial day charted beside complete ones reads as a
		// collapse. Unexplained, it reads as a stale chart.
		expect(throughDayNote("2026-08-06")).toContain("2026-08-06");
		expect(throughDayNote("2026-08-06")).toMatch(/partial day/i);
	});

	it("says when a breakdown is a sample", () => {
		expect(partialNote(500, 1200)).toMatch(/500 of 1,200/);
		expect(partialNote(undefined, undefined)).toBeNull();
	});
});
