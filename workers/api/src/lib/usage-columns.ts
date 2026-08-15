/**
 * A money figure may not be computed from a column the query did not select. (#647)
 *
 * ── The defect this exists to remove
 *
 * `loadAdminUsage` (`routes/admin.ts`) is the only cross-user scan of `ai_usage`. Its select list
 * omitted `payer`, while every charged figure downstream is decided from `payer` in JS —
 * `isCharged(r.payer)` at `lib/usage.ts:475` and `:314`. `r.payer` was `undefined` on every row,
 * `isCharged(undefined)` is false, and so the operator portal's "BYOK spend" headline read $0.00
 * permanently: the same value it would show if the platform were completely idle. The same omission
 * published `cacheReadTokens: 0` / `cacheWriteTokens: 0` on the whole daily series.
 *
 * ── Why nothing caught it, and why this is a runtime assert
 *
 * The three defences that should have all had a structural reason not to fire:
 *
 *   • **TypeScript.** `UsageRow.payer` is `payer?: string | null` and the fetch is an unchecked
 *     `.all<AdminJoinedRow>()` generic, so a column the SQL never selected is perfectly well typed.
 *   • **`lib/usage-aggregates.ts`**, the guard that exists for exactly this class, is a scanner
 *     over SQL string literals — it requires every `SUM(cost_micros)` to take a position on the
 *     payer. This aggregation happens in JS over rows already fetched, so the scanner has nothing
 *     to read.
 *   • **The unit tests.** `lib/usage-admin.test.ts`'s `row()` fixture never sets `payer` either, so
 *     it asserts the aggregator against exactly the row shape that produces the bug.
 *
 * What none of them can see is the GAP between a select list and its consumer, which lives in no
 * file. This does, by asking the rows themselves.
 *
 * ── `undefined` and `null` are different facts, and that is the whole mechanism
 *
 * D1 returns a row object with the key PRESENT and the value `null` for a selected column that is
 * NULL, and with the key ABSENT for a column that was not selected. So `"payer" in row`
 * distinguishes "this row's payer could not be established" — a first-class answer the ledger
 * records deliberately — from "this query never asked". `isCharged` collapses both to false; this
 * refuses to let the second one masquerade as the first.
 *
 * Throwing is deliberate. The select list is a literal, so this can only fail for a query shape
 * fixed at deploy time, never for particular data — which means the test suite meets it first and
 * production never does. The alternative is what shipped: a dollar headline that is confidently,
 * silently wrong, beside per-user figures from `lib/admin.ts:112` that are computed correctly in
 * SQL and therefore contradict it.
 */

/** The columns a charged-money aggregate reads out of a fetched `ai_usage` row. */
export const CHARGE_DECIDING_COLUMNS = ["payer"] as const;

/**
 * Assert that fetched ledger rows carry the columns the charged aggregates decide on.
 *
 * @param rows   the fetched rows; an empty set asserts nothing, because there is nothing to ask.
 * @param source names the query, so the failure says which select list to fix.
 */
export function assertChargeColumnsSelected(rows: readonly object[], source: string): void {
	const first = rows[0];
	if (!first) return;
	const missing = CHARGE_DECIDING_COLUMNS.filter((c) => !(c in first));
	if (missing.length > 0) {
		throw new Error(
			`${source}: ledger rows are missing ${missing.join(", ")}, so every charged figure computed from ` +
				`them would be 0 regardless of the data. Add the column(s) to the SELECT list.`,
		);
	}
}
