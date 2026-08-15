// What the charged figure does NOT cover, as counts rather than as prose (#544).
//
// The symptom: `Est. billed` read $36.35 at 7d, at 30d and at all-time — identical to the cent,
// while 2,351 extra calls worth $36.42 of notional value appeared between the first two windows.
// None of it reached the charged figure, because `payer` (migration 0092) shipped with a deliberate
// no-backfill, so every row older than it resolves to NULL and `isCharged(null)` is false. The
// arithmetic was correct; the label was not. Measured on production: reported 30d charged $36.35,
// actual ≈ $81.06 — an understatement of ~55%.
//
// The no-backfill stays. 0092's own header says stamping a payer on retrospectively "would be the
// same confident-but-unfounded inference this column exists to remove", and that is right: the data
// to attribute those rows does not exist. What was missing is that the page presented "charged over
// this range" without disclosing that the range and the payer's coverage are DIFFERENT WINDOWS.
//
// ── What can be derived, and what cannot ────────────────────────────────────────────────────────
//
// It is tempting to state a start date: "payer has been recorded since 7 Aug". The page cannot know
// that, and three different things get confused if it claims to:
//
//   * The MIGRATION's own timestamp exists (D1 keeps `d1_migrations.applied_at`), but it is
//     infrastructure rather than application schema, it would couple this figure to a migration
//     FILENAME that nothing else enforces, and it cannot be exercised by a test without inventing
//     the table. It also answers the wrong question — see the next point.
//   * NULL has TWO causes and they are not distinguishable by inspecting a row. A row can predate
//     the column, or it can be a coding engine that signed in with `machine-login`, whose payer we
//     genuinely could not establish (#551). On the measured account the second cause is 99.6% of
//     the value. A disclosure that blamed the date for all of it would be a new confident wrong
//     number in place of the old one.
//   * The earliest row that CARRIES a payer is a lower bound on the start date, not the date: an
//     account that made no calls for a week after 0092 shipped has a later one.
//
// So this reports the boundary as exactly what it is — the earliest call IN THIS RANGE that we
// could attribute — and splits the unattributed rows around it. Both sides are literal counts over
// the same rows the totals are computed from. Neither asserts a cause, and the page can therefore
// say something true and specific where it previously hedged in prose.
//
// Computed from the row set already in memory rather than by a second query, deliberately: a
// separate `WHERE` is how the coverage figure and the total it qualifies start to disagree.

import { isCharged } from "./usage-payer.js";
import type { CoverageSlice, PayerCoverage } from "./usage-shape.js";

// The shapes moved to `usage-shape.ts` (#608), which the console imports directly: the console
// declared its own copy of `PayerCoverage` (`store/console/src/lib/usageFigures.ts`) and nothing
// made the two agree. Re-exported from here because this is the module that COMPUTES them.
export type { CoverageSlice, PayerCoverage } from "./usage-shape.js";

interface CoverageRow {
	payer?: string | null;
	cost_micros: number;
	created_at: string;
}

const slice = (): CoverageSlice => ({ calls: 0, costMicros: 0 });
const add = (s: CoverageSlice, r: CoverageRow) => {
	s.calls += 1;
	s.costMicros += r.cost_micros || 0;
};

/**
 * Split a range's rows into "we know who paid" and the two shapes of "we do not".
 *
 * `attributed` uses payer PRESENCE, not {@link isCharged}: a subscription row is fully attributed
 * and contributes nothing to the charged figure, and counting it as a coverage gap would tell the
 * reader to go looking for a credential that is already recorded.
 *
 * Two passes over an array that is already materialised, because the boundary is not known until
 * the first is done. The alternative — assuming the caller's `ORDER BY created_at` — would make
 * this silently wrong for any caller that sorted differently.
 */
export function payerCoverage(rows: readonly CoverageRow[]): PayerCoverage {
	let firstAttributedAt: string | null = null;
	for (const r of rows) {
		if (!hasPayer(r)) continue;
		if (firstAttributedAt === null || r.created_at < firstAttributedAt) firstAttributedAt = r.created_at;
	}

	const out: PayerCoverage = {
		firstAttributedAt,
		attributed: slice(),
		unattributedBefore: slice(),
		unattributedSince: slice(),
	};
	for (const r of rows) {
		if (hasPayer(r)) add(out.attributed, r);
		else if (firstAttributedAt !== null && r.created_at < firstAttributedAt) add(out.unattributedBefore, r);
		else add(out.unattributedSince, r);
	}
	return out;
}

/**
 * Whether a payer was established for this row.
 *
 * Broader than `isCharged` on purpose, and this is the distinction the whole module turns on:
 * `isCharged` answers "is this money", `hasPayer` answers "do we know". `subscription` is the row
 * where they differ — known, and not money.
 */
function hasPayer(r: CoverageRow): boolean {
	return isCharged(r.payer) || r.payer === "subscription";
}
