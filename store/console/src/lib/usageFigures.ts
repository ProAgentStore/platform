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

/**
 * The same understatement caveat, next to the headline that carries the charged total.
 *
 * Kept as the FALLBACK once #544 landed: an API that does not report `payerCoverage` leaves the
 * page unable to say how much is missing, and a vague true sentence beats a specific invented one.
 * When coverage IS reported, {@link chargedCoverageNote} replaces this with the counts.
 */
export const CHARGED_COVERAGE_NOTE =
	"Charged is only recorded for calls made since payer tracking began, so a longer range understates it.";

/**
 * What `/v1/usage` reports about the gap between the range and the payer's coverage (#544).
 *
 * Re-exported from the producer's own declaration rather than restated (#608): this file used to
 * carry a hand-copied structural twin, which is the third instance of the habit that let
 * `totals.cacheReadTokens` cross the wire for the whole life of #547 with neither side's type
 * saying so. See `workers/api/src/lib/usage-shape.ts` for why the import points that way.
 */
import type { PayerCoverage } from "../../../../workers/api/src/lib/usage-shape";
export type { PayerCoverage };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A D1 timestamp as a short UTC date — "2026-08-07 04:12:09" → "7 Aug 2026".
 *
 * Formatted by hand rather than through `toLocaleDateString`, which would make the sentence depend
 * on the browser's locale and the test's, and this string is asserted.
 */
export function coverageDate(ts: string): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ts || "");
	if (!m) return ts || "";
	return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/**
 * The sentence that says how far the charged figure's window actually reaches (#544).
 *
 * `Est. billed` read $36.35 at 7d, 30d and all-time — identical to the cent — because `payer`
 * shipped without a backfill, so every older row is NULL and cannot be charged. The arithmetic was
 * right and the implied range was not: real 30-day charged spend was roughly $81.
 *
 * What this says is deliberately narrow. It reports the earliest call IN THIS RANGE that carried a
 * payer, and the count and value of the calls before it — both literal facts about the rows the
 * totals were computed from. It does NOT say when payer tracking began, and it does not say WHY
 * those rows have no payer: NULL has two causes (older than the column, or a coding engine on a
 * machine login) and they are not distinguishable per row. Blaming the date for all of it would
 * replace one confident wrong number with another, on an account where the second cause is 99.6%
 * of the value. That half has its own note and its own remedy (#551).
 *
 * `null` when there is nothing before the boundary — the range is fully inside the payer's
 * coverage, and a caveat offered to someone who does not have the problem is how a page teaches
 * people to skip its notices.
 */
export function chargedCoverageNote(
	coverage: PayerCoverage | undefined,
	fmtUsd: (micros: number) => string,
): string | null {
	if (!coverage || coverage.unattributedBefore.calls <= 0 || !coverage.firstAttributedAt) return null;
	const { calls, costMicros } = coverage.unattributedBefore;
	return (
		`Charged counts only calls whose payer we could establish, and the earliest in this range is ` +
		`${coverageDate(coverage.firstAttributedAt)}. ${calls.toLocaleString()} ${calls === 1 ? "call" : "calls"} ` +
		`before that (${fmtUsd(costMicros)} of value) carry no payer at all, so none of them is counted above.`
	);
}

/**
 * What the reader can DO about the unattributed bucket (#551).
 *
 * On the account this was measured on, 99.62% of the notional value sits under "Payer not
 * established" — 3,462 calls worth $9,584.87 — because a coding engine in `auto` mode with no
 * stored `claude setup-token` runs on the machine's own login, which resolves to `machine-login`
 * and therefore to a NULL payer. The NULL is correct and must not be guessed at (migration 0092
 * exists to remove exactly that inference).
 *
 * What was missing is that the platform KNOWS how to make it knowable, and no surface said so.
 * Storing one token flips the largest row on the page from "Payer not established" to "Drawn from
 * a subscription" — which is the sentence that separates a $36 API bill from a subscription's
 * session limit, the two independent ceilings this owner is hitting.
 *
 * `null` when there is nothing to say: no unknown bucket, or one with no calls. A remedy offered
 * to someone who does not have the problem is noise, and it would appear on every account.
 */
export function unknownPayerRemedy(
	rows: readonly { key: string; costMicros: number; calls: number }[] | undefined,
	fmtUsd: (micros: number) => string,
): string | null {
	const b = rows?.find((r) => r.key === "unknown");
	if (!b || b.calls <= 0) return null;
	return (
		`${b.calls.toLocaleString()} ${b.calls === 1 ? "call" : "calls"} (${fmtUsd(b.costMicros)} of value) ran on a login stored on your machine, ` +
		"so we cannot tell whether they were billed. Store a Claude Code sign-in token under Profile → API Keys, " +
		"or set an engine's sign-in to your API key in the Coder's CLI engines panel, and this becomes attributable."
	);
}

/**
 * Whether a per-instance breakdown says anything the per-agent one does not (#526).
 *
 * The card exists because `byAgent` groups by template: seven Repo Coders collapse into one row and
 * the owner cannot see which of them spent the money. That collapse needs at least two instances to
 * exist — with one, the two cards carry identical rows under different names, and a second card
 * that repeats the first is noise on every small account.
 *
 * Counted over instances that actually have a bucket, not over the account's instance list: an
 * instance that did nothing in this range has nothing to show, and an owner with six idle coders
 * and one busy one is looking at a page that can already answer him.
 */
export function showsInstanceBreakdown(rows: readonly { key: string }[] | undefined): boolean {
	return (rows ?? []).filter((r) => r.key !== "unassigned").length >= 2;
}

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
