import { describe, expect, it } from "vitest";
import { barPercents, sharePercent, sparklineGeometry, xForIndex } from "./stats-chart";
import type { StatsPoint } from "./stats-types";

const OPTS = { width: 100, height: 40, padY: 5 };

/** `[1, null, 3]` → the series shape, with days that sort in order. */
function series(values: Array<number | null>): StatsPoint[] {
	return values.map((value, i) => ({ day: `2026-08-${String(i + 1).padStart(2, "0")}`, value }));
}

describe("a missing day is a GAP, not a zero", () => {
	it("draws no point for a null day", () => {
		const g = sparklineGeometry(series([5, null, 7]), OPTS);
		expect(g.marks.map((m) => m.index)).toEqual([0, 2]);
		expect(g.gapCount).toBe(1);
		expect(g.recordedCount).toBe(2);
	});

	it("breaks the line rather than joining across the gap", () => {
		// The failure being prevented: one polyline through every recorded point, which draws a
		// straight line across the missing day and reads as a smooth trend that was never measured.
		const g = sparklineGeometry(series([1, 2, null, 4, 5]), OPTS);
		expect(g.runs).toHaveLength(2);
		for (const run of g.runs) expect(run.split(" ")).toHaveLength(2);
	});

	it("keeps the gap's SLOT on the x axis instead of closing it up", () => {
		// Re-indexing over recorded days only would tell the same lie through layout: the two
		// halves would sit next to each other and the missing day would vanish from the timeline.
		const withGap = sparklineGeometry(series([1, null, 3]), OPTS);
		const last = withGap.marks[withGap.marks.length - 1];
		expect(last.index).toBe(2);
		expect(last.x).toBe(100);
		// …and the first point is still at the left edge, so the gap is the whole middle.
		expect(withGap.marks[0].x).toBe(0);
	});

	it("a recorded 0 IS drawn, on the baseline — that contrast is what makes a break legible", () => {
		const g = sparklineGeometry(series([0, null, 4]), OPTS);
		const zero = g.marks.find((m) => m.index === 0);
		expect(zero).toBeDefined();
		expect(zero?.value).toBe(0);
		expect(zero?.y).toBe(g.baselineY);
		// The null did NOT get the same treatment.
		expect(g.marks.some((m) => m.index === 1)).toBe(false);
	});

	it("draws nothing at all when every day is missing", () => {
		// Not a flat line along the axis. A flat zero line claims the agent ran and produced
		// nothing; an empty plot claims nothing, which is the truth.
		const g = sparklineGeometry(series([null, null, null]), OPTS);
		expect(g.runs).toEqual([]);
		expect(g.dots).toEqual([]);
		expect(g.marks).toEqual([]);
		expect(g.gapCount).toBe(3);
		expect(g.recordedCount).toBe(0);
	});

	it("an isolated recorded day becomes a dot, because a one-point line is invisible", () => {
		const g = sparklineGeometry(series([null, 9, null]), OPTS);
		expect(g.runs).toEqual([]);
		expect(g.dots).toHaveLength(1);
		expect(g.dots[0].value).toBe(9);
	});
});

describe("the value axis is zero-based and never divides by zero", () => {
	it("puts the maximum at the top and zero on the floor", () => {
		const g = sparklineGeometry(series([0, 10]), OPTS);
		expect(g.max).toBe(10);
		expect(g.marks[0].y).toBe(g.baselineY);
		expect(g.marks[1].y).toBe(5); // padY
	});

	it("keeps an all-zero series flat on the floor instead of producing NaN", () => {
		const g = sparklineGeometry(series([0, 0, 0]), OPTS);
		expect(g.max).toBe(0);
		for (const m of g.marks) expect(m.y).toBe(g.baselineY);
	});

	it("centres a single day rather than pinning it to an edge", () => {
		expect(xForIndex(0, 1, 100)).toBe(50);
	});
});

describe("bar widths do not invent a value", () => {
	it("gives a zero row no bar at all", () => {
		// The "minimum visible sliver" habit is the same class of lie as a zero-filled gap: it
		// shows "a little" where the data says "none".
		expect(barPercents([10, 0, 5])).toEqual([100, 0, 50]);
	});

	it("still shows a stub for a tiny non-zero row", () => {
		expect(barPercents([1000, 1])[1]).toBe(2);
	});

	it("survives an all-zero breakdown", () => {
		expect(barPercents([0, 0])).toEqual([0, 0]);
		expect(barPercents([])).toEqual([]);
	});

	it("states no share at all when nothing was counted", () => {
		// "0%" on every row of an empty breakdown asserts a proportion nobody measured.
		expect(sharePercent(0, 0)).toBeNull();
		expect(sharePercent(3, 12)).toBe(25);
	});
});
