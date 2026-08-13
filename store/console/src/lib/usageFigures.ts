/**
 * The two money figures a Usage-page row carries, and what each one is allowed to claim (#543).
 *
 * Pure, and here rather than inline in JSX, because the distinction is a RULE and not a
 * decoration. The page prints a notional figure and a charged figure side by side; they differ by
 * two orders of magnitude on a real account ($9,566.69 of value against $36.35 of money), and the
 * failure this closes was a breakdown that printed only the first one, in the same `$` format and
 * the same column as the headline that showed the second.
 *
 * Three states, deliberately, because "we measured zero" and "we did not measure" are different
 * answers and were rendered identically before:
 *
 *  - `unmeasured` — the payload predates the per-bucket split, so there is no charged figure to
 *    show. The row renders nothing rather than `$0.00`, which would be a number we do not have.
 *  - `charged` — money someone is billed for.
 *  - `none` — measured, and none of this row is charged. NOT a claim that the work was free: the
 *    charged figure excludes subscription rows (no marginal charge) and rows whose payer was
 *    never established. {@link CHARGED_LEGEND} is what says so, and it renders with the column.
 */

export interface UsageFigures {
	costMicros: number;
	/** Absent on a response from an API older than #543 — never coerce it to zero. */
	chargedCostMicros?: number;
}

export type ChargedCell =
	| { kind: "unmeasured" }
	| { kind: "charged"; micros: number }
	| { kind: "none" };

/** What to render in a row's charged slot. */
export function chargedCell(r: UsageFigures): ChargedCell {
	if (typeof r.chargedCostMicros !== "number" || !Number.isFinite(r.chargedCostMicros)) return { kind: "unmeasured" };
	return r.chargedCostMicros > 0 ? { kind: "charged", micros: r.chargedCostMicros } : { kind: "none" };
}

/**
 * Whether this payload can decompose value into money at all.
 *
 * Gates the column header and the legend together: a page served by an older API shows one figure
 * per row, as it always did, rather than a header promising a second column that is never there.
 */
export function hasChargedFigures(rows: readonly UsageFigures[]): boolean {
	return rows.some((r) => typeof r.chargedCostMicros === "number");
}

/**
 * The sentence that stops `$0.00` being read as "free", and the charged total as complete.
 *
 * The second clause is the truthful minimum about #544 — `payer` was added by migration 0092 with
 * a deliberate no-backfill, so a 30-day charged figure counts only the days since. This states
 * that a longer range understates, without asserting a coverage date the page does not yet
 * compute; the exact counts belong to #544.
 */
export const CHARGED_LEGEND =
	"Value is the list price of everything in a row; charged is the part of it someone is actually billed for. A row showing $0.00 charged is not free — it ran on a subscription, which costs tokens rather than dollars, or on a credential the platform could not attribute. Charged is only recorded for calls made since payer tracking began, so a longer range understates it.";

/** The same understatement caveat, next to the headline that carries the charged total. */
export const CHARGED_COVERAGE_NOTE =
	"Charged is only recorded for calls made since payer tracking began, so a longer range understates it.";

/**
 * A day in the chart's series (#547).
 *
 * The cache fields are optional because a response from an API older than #547 does not carry
 * them — and that absence must read as "not reported", not as "no cache activity". Treating it as
 * zero in the SUM is the only arithmetic available, but the distinction is why the tooltip only
 * mentions cache when there is cache to mention.
 */
export interface UsageDay {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
}

/**
 * Every token the day cost — the SAME four columns the daily circuit breaker counts.
 *
 * This is the point of #547 and it is not a cosmetic sum. The chart plotted `input + output`,
 * while `accountUsageSince` counts input + output + cache read + cache write. On the account this
 * was measured on, cache reads were 98.2% of the counted total: the chart showed 4.2M tokens for
 * the day a 250M/day ceiling tripped at 268M, 137x out. A reader comparing one number against a
 * ceiling has to be shown the number the ceiling is denominated in.
 */
export function dayTokens(d: UsageDay): number {
	return (d.inputTokens || 0) + (d.outputTokens || 0) + (d.cacheReadTokens || 0) + (d.cacheWriteTokens || 0);
}

/**
 * The composition behind that total, in words: "4.2M I/O + 850M cache".
 *
 * The magnitude alone would be a second unexplained number. Splitting it in the tooltip is what
 * lets a reader see that a day is nearly all cache — which is the fact that makes the ceiling's
 * arithmetic legible, and the input to whether cache reads should be weighted in it at all (#485).
 * Falls back to the plain total when the payload carries no cache columns, rather than printing
 * "+ 0 cache" for a day whose cache is unknown.
 */
export function tokenSplitLabel(d: UsageDay, fmt: (n: number) => string): string {
	const io = (d.inputTokens || 0) + (d.outputTokens || 0);
	const cache = (d.cacheReadTokens || 0) + (d.cacheWriteTokens || 0);
	const reported = typeof d.cacheReadTokens === "number" || typeof d.cacheWriteTokens === "number";
	if (!reported || cache === 0) return `${fmt(io)} tokens`;
	return `${fmt(io)} I/O + ${fmt(cache)} cache`;
}
