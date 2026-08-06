/**
 * Number and disclosure formatting for the Stats surface (#311) — pure, so it can be tested.
 *
 * The disclosure sentences are here rather than inline in JSX because each of them is a CONDITION,
 * not a decoration: whether the rollup's history starts inside the window, whether a series has
 * gaps, whether a breakdown is a sample. A sentence that renders when it should not is as wrong as
 * one that never renders, and neither is checkable inside a component this repo does not
 * component-test (#282).
 *
 * What is deliberately NOT here: any restatement of a source's caveat. Those strings are served by
 * `GET /v1/stats/sources` and travel on every card, precisely so the console cannot drift from the
 * query.
 */
import type { StatsPoint, StatsUnit } from "./stats-types";

/** micros of USD → "$1.23" (matching the Usage page, which is the other place money is shown). */
export function usd(micros: number): string {
	const v = (micros || 0) / 1_000_000;
	if (v === 0) return "$0.00";
	if (v < 0.01) return "<$0.01";
	if (v < 1000) return `$${v.toFixed(2)}`;
	return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/** Compact token count: 1234 → "1.2K", 3_400_000 → "3.4M". */
export function tokens(n: number): string {
	const x = n || 0;
	if (x < 1000) return String(x);
	if (x < 1_000_000) return `${(x / 1000).toFixed(x < 10_000 ? 1 : 0)}K`;
	return `${(x / 1_000_000).toFixed(x < 10_000_000 ? 1 : 0)}M`;
}

/** A card's value in its own unit. `usd_micros` is 1,000,000 = $1. */
export function formatValue(value: number, unit: StatsUnit = "count"): string {
	if (unit === "usd_micros") return usd(value);
	if (unit === "tokens") return tokens(value);
	return (value || 0).toLocaleString();
}

/** `2026-08-06` → `08-06`. Deliberately not localized: these are UTC days from the rollup, and a
 *  locale-shifted label would name a different day than the one the value belongs to. */
export function dayLabel(day: string): string {
	return typeof day === "string" && day.length >= 10 ? day.slice(5) : String(day ?? "");
}

/**
 * What a break in the line means, in words.
 *
 * The visual break is only half the message — a reader who has never seen this chart full does not
 * know whether the gap is missing data or a deliberate style. `null` when the series is unbroken,
 * so an intact chart carries no noise.
 */
export function gapNote(points: readonly StatsPoint[]): string | null {
	const gaps = points.filter((p) => p.value === null).length;
	if (!gaps) return null;
	return `${gaps} ${gaps === 1 ? "day has" : "days have"} no recorded run — the line breaks there. That is missing data, not a zero.`;
}

/** Every day in the window is missing. Worth its own sentence: an empty chart otherwise looks
 *  broken, and "the agent did nothing" is a different claim from "nothing was recorded". */
export function isAllGaps(points: readonly StatsPoint[]): boolean {
	return points.length > 0 && points.every((p) => p.value === null);
}

/**
 * Where the daily rollup's history begins — but only when it begins INSIDE the window being
 * viewed, because that is the only case where it explains the shape on screen.
 *
 * There is no backfill: history starts the day the rollup shipped for this instance. A month-old
 * agent showing three days of trend has a young rollup, and a surface that says nothing is
 * implying the agent was idle.
 */
export function historyNote(historyStart: string | null, throughDay: string, windowDays: number): string | null {
	if (!historyStart) return "Daily history has not started for this agent yet — trends fill in from the next nightly rollup.";
	const start = windowStartDay(throughDay, windowDays);
	if (!start || historyStart <= start) return null;
	return `Daily history starts ${historyStart}. Earlier days are missing because the rollup had not run yet — not because the agent was idle.`;
}

/** The first day of a `windowDays` window ending at (and including) `throughDay`. */
export function windowStartDay(throughDay: string, windowDays: number): string | null {
	const ms = Date.parse(`${throughDay}T00:00:00.000Z`);
	if (!Number.isFinite(ms)) return null;
	return new Date(ms - (windowDays - 1) * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Why today is not on the chart.
 *
 * Stated, not hidden. The sweep writes yesterday only — a completed UTC day is immutable, and a
 * partial day charted beside complete ones reads as a collapse in the metric. Someone looking for
 * this morning's number needs to be told where it went rather than concluding the chart is stale.
 */
export function throughDayNote(throughDay: string): string {
	return `Trends end ${throughDay}, the last complete UTC day. Today is still in progress and is left off rather than charted as a partial day.`;
}

/** A breakdown that only scanned part of the collection says so, with the numbers. */
export function partialNote(scanned?: number, total?: number): string | null {
	if (scanned === undefined || total === undefined) return null;
	return `Covers ${scanned.toLocaleString()} of ${total.toLocaleString()} records — a sample, not the whole collection.`;
}

/** "7 days" / "30 days" / "90 days". */
export function windowLabel(days: number): string {
	return `${days} days`;
}
