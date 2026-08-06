/**
 * Chart geometry for the Stats surface (#311) — pure, so it can be tested.
 *
 * ## Why the maths lives here and not in the component
 *
 * The console has no component-testing infrastructure and deliberately does not want any (#282:
 * pure functions over testing-library). The interesting part of a chart is not the JSX, it is the
 * projection — and the projection is where this feature can be silently undone. So the projection
 * is a function with a test, and the component is a dumb renderer over what it returns.
 *
 * ## The rule this file exists to hold
 *
 * **A missing day is a gap, not a zero.** `buildSeries` on the server returns
 * `{ day, value: number | null }` and never coalesces; a stored `0` and an absent day are different
 * facts all the way from the rollup. The last place that chain can be undone is a renderer that
 * draws `null` as a point on the axis — "you found no leads on Tuesday" when the truth is "nothing
 * ran on Tuesday", which is the #243 / #252 shape of a plausible value standing in for absent
 * information.
 *
 * Concretely, three properties, each with a test:
 *
 *   1. A `null` day produces NO point. The line breaks; the next run starts after it.
 *   2. A `null` day still OCCUPIES its slot on the x axis. Dropping the gap and re-indexing would
 *      close it up, which draws a continuous line across missing days — the same lie, told by
 *      layout instead of by value.
 *   3. A recorded `0` DOES produce a point, sitting on the baseline. That is the visible contrast
 *      that makes the break mean something.
 */
import type { StatsPoint } from "./stats-types";

export interface SparklineOpts {
	width: number;
	height: number;
	/** Vertical breathing room so the top and bottom marks are not clipped by the viewBox. */
	padY?: number;
}

export interface Mark {
	index: number;
	x: number;
	y: number;
	value: number;
	day: string;
}

export interface SparklineGeometry {
	/** One `points` string per contiguous run of ≥2 recorded days. A run never spans a gap. */
	runs: string[];
	/** Recorded days with no recorded neighbour. A one-point polyline draws nothing, so an
	 *  isolated day would otherwise be invisible — indistinguishable from the gap around it. */
	dots: Mark[];
	/** Every recorded day, for hover targets and labels. */
	marks: Mark[];
	/** Top of the value axis. `0` when every recorded value is 0 (a flat run on the baseline). */
	max: number;
	/** Days with no row at all. Surfaced as text beside the chart — the break is only legible if
	 *  the reader is told what a break means. */
	gapCount: number;
	/** Days that DO have a value. Zero of these means nothing is drawn at all. */
	recordedCount: number;
	/** Y of the value axis floor, i.e. where a recorded `0` sits. */
	baselineY: number;
}

const DEFAULT_PAD_Y = 6;

/** X for a slot, by POSITION in the day list — never by position among recorded days. */
export function xForIndex(index: number, count: number, width: number): number {
	if (count <= 1) return width / 2;
	return (index * width) / (count - 1);
}

/**
 * Project a day series into polyline runs, isolated dots and marks.
 *
 * The value axis is zero-based on purpose: every source here is a magnitude (tokens, dollars,
 * counts, collection size), and a chart whose floor is the minimum observed value exaggerates
 * ordinary variation into a cliff. Zero-based means a recorded `0` lands exactly on the floor,
 * which is what makes it visibly different from a break in the line.
 */
export function sparklineGeometry(points: readonly StatsPoint[], opts: SparklineOpts): SparklineGeometry {
	const { width, height } = opts;
	const padY = opts.padY ?? DEFAULT_PAD_Y;
	const baselineY = height - padY;
	const recorded = points.filter((p) => p.value !== null) as Array<StatsPoint & { value: number }>;
	const max = recorded.length ? Math.max(...recorded.map((p) => p.value)) : 0;
	const span = height - padY * 2;

	const yFor = (value: number) => {
		// max === 0 means every recorded day is a real zero. Dividing would be NaN, and picking a
		// non-zero axis top would lift a row of zeros off the floor and imply they were something.
		if (max <= 0) return baselineY;
		return baselineY - (value / max) * span;
	};

	const marks: Mark[] = [];
	points.forEach((p, index) => {
		if (p.value === null) return;
		marks.push({ index, x: xForIndex(index, points.length, width), y: yFor(p.value), value: p.value, day: p.day });
	});

	// Split at every gap. This loop is the whole point of the module: a run is a set of
	// CONSECUTIVE indices, so a null between two values ends one run and starts another rather
	// than being skipped over.
	const runs: string[] = [];
	const dots: Mark[] = [];
	let current: Mark[] = [];
	const flush = () => {
		if (current.length >= 2) runs.push(current.map((m) => `${round(m.x)},${round(m.y)}`).join(" "));
		else if (current.length === 1) dots.push(current[0]);
		current = [];
	};
	for (const mark of marks) {
		if (current.length && mark.index !== current[current.length - 1].index + 1) flush();
		current.push(mark);
	}
	flush();

	return {
		runs,
		dots,
		marks,
		max,
		gapCount: points.length - marks.length,
		recordedCount: marks.length,
		baselineY,
	};
}

function round(n: number): number {
	return Math.round(n * 100) / 100;
}

/**
 * Horizontal bar widths, as percentages of the widest row.
 *
 * A zero gets width 0 — not the "minimum visible sliver" trick. A sliver is a small lie in the
 * same family as a zero-filled gap: it says "a little" where the data says "none". The label and
 * the printed value carry the row; the bar is only ever the comparison.
 */
export function barPercents(values: readonly number[]): number[] {
	const max = Math.max(0, ...values);
	return values.map((v) => {
		if (!(v > 0)) return 0;
		if (max <= 0) return 0;
		// A tiny non-zero row still gets a visible stub, because "present but small" is exactly
		// what it is — the distinction being protected is only zero-versus-non-zero.
		return Math.max(2, (v / max) * 100);
	});
}

/**
 * A row's share of the total, as a percentage, or `null` when the total is zero.
 *
 * `null` rather than `0`: with nothing counted there is no share to state, and printing "0%"
 * against every row of an empty breakdown asserts a proportion nobody measured.
 */
export function sharePercent(value: number, total: number): number | null {
	if (!(total > 0)) return null;
	return (value / total) * 100;
}
