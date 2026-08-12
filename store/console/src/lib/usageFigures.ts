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
