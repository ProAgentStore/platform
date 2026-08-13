import { describe, expect, it } from "vitest";
import { payerCoverage } from "./usage-coverage.js";
import { aggregateUsage, type UsageRow } from "./usage.js";

// #544 — "Est. billed" read $36.35 at 7d, at 30d AND at all-time, identical to the cent.
//
// Measured on production 2026-08-13: widening the window from 7d to 30d added 2,351 calls worth
// $36.42 of notional value, and not one cent of it reached the charged figure. `payer` (migration
// 0092) shipped with a deliberate no-backfill, so every older row is NULL and `isCharged(null)` is
// false. The arithmetic was right; the window it implied was not. Real 30d charged ≈ $81.06 against
// a reported $36.35 — an understatement of ~55%.
//
// The fixture below spans the boundary, because a coverage figure computed over rows that are all
// on one side of it cannot fail.

const row = (over: Partial<UsageRow> = {}): UsageRow => ({
	agent_id: "a1", instance_id: "i1", provider: "anthropic", model: "claude-sonnet-4-6",
	kind: "chat", input_tokens: 1000, output_tokens: 200, cost_micros: 6000,
	created_at: "2026-08-07 10:00:00", ...over,
});

/** Rows either side of the day payer tracking started producing values on this account. */
const spanningBoundary = () => [
	// Pre-0092: real spend, no payer recorded, and no way to attribute it now.
	row({ created_at: "2026-08-01 09:00:00", payer: null, cost_micros: 6_676_369 }),
	row({ created_at: "2026-08-05 09:00:00", payer: null, cost_micros: 3_658_372 }),
	row({ created_at: "2026-08-06 22:00:00", payer: null, cost_micros: 8_287_110 }),
	// From here the column exists.
	row({ created_at: "2026-08-07 04:12:09", payer: "byok-api", cost_micros: 20_000_000 }),
	row({ created_at: "2026-08-08 11:00:00", payer: "platform", cost_micros: 16_249 }),
	// Same period, no payer — but for the OTHER reason: a coding engine on a machine login (#551).
	row({ created_at: "2026-08-09 12:00:00", payer: null, kind: "engine", cost_micros: 900_000 }),
];

describe("payerCoverage (#544)", () => {
	it("finds the boundary and counts what falls before it", () => {
		const c = payerCoverage(spanningBoundary());
		expect(c.firstAttributedAt).toBe("2026-08-07 04:12:09");
		expect(c.unattributedBefore).toEqual({ calls: 3, costMicros: 6_676_369 + 3_658_372 + 8_287_110 });
	});

	it("keeps the two reasons for a missing payer apart", () => {
		// They have different remedies and only one of them is about time. Lumping the machine-login
		// row in with the pre-migration ones would blame the date for 99.6% of the measured
		// account's value — a new confident wrong number in place of the old one.
		const c = payerCoverage(spanningBoundary());
		expect(c.unattributedBefore.calls).toBe(3);
		expect(c.unattributedSince).toEqual({ calls: 1, costMicros: 900_000 });
	});

	it("counts a subscription row as attributed, though it is not charged", () => {
		// The distinction the module turns on: `isCharged` asks "is this money", coverage asks "do
		// we know who paid". A subscription is known and free. Counting it as a gap would send the
		// reader looking for a credential that is already recorded.
		const c = payerCoverage([
			row({ payer: "subscription", cost_micros: 3_000_000 }),
			row({ payer: "byok-api", cost_micros: 1000 }),
		]);
		expect(c.attributed).toEqual({ calls: 2, costMicros: 3_001_000 });
		expect(c.unattributedBefore.calls).toBe(0);
		expect(c.unattributedSince.calls).toBe(0);
	});

	it("every row lands in exactly one slice, so the three sum to the range", () => {
		const rows = spanningBoundary();
		const c = payerCoverage(rows);
		const calls = c.attributed.calls + c.unattributedBefore.calls + c.unattributedSince.calls;
		const value = c.attributed.costMicros + c.unattributedBefore.costMicros + c.unattributedSince.costMicros;
		expect(calls).toBe(rows.length);
		expect(value).toBe(rows.reduce((n, r) => n + r.cost_micros, 0));
	});

	it("reports no boundary, and no 'before', when nothing in the range could be attributed", () => {
		// An account whose whole range ran on a machine login. There is no first attributed call, so
		// there is nothing for a row to be on the far side of — the unattributed rows are a
		// credential problem, not a date one, and saying otherwise would invent a boundary.
		const c = payerCoverage([row({ payer: null }), row({ payer: null })]);
		expect(c.firstAttributedAt).toBeNull();
		expect(c.unattributedBefore).toEqual({ calls: 0, costMicros: 0 });
		expect(c.unattributedSince.calls).toBe(2);
	});

	it("does not depend on the caller's sort order", () => {
		// The route happens to ORDER BY created_at ASC. Assuming it would make this silently wrong
		// for any other caller, and `aggregateUsage` is called from more than one place.
		const asc = payerCoverage(spanningBoundary());
		const desc = payerCoverage([...spanningBoundary()].reverse());
		expect(desc).toEqual(asc);
	});

	it("is empty, not undefined, for a range with no rows", () => {
		const c = payerCoverage([]);
		expect(c.firstAttributedAt).toBeNull();
		expect(c.attributed).toEqual({ calls: 0, costMicros: 0 });
	});
});

describe("aggregateUsage reports coverage over the same rows as the totals (#544)", () => {
	it("attaches the coverage, computed from the range it just aggregated", () => {
		// The one thing to get right per the issue: coverage must come from the SAME filtered row
		// set as the aggregate, never a second query with its own WHERE — that is how the two start
		// to disagree.
		const rows = spanningBoundary();
		const s = aggregateUsage(rows);
		expect(s.payerCoverage.firstAttributedAt).toBe("2026-08-07 04:12:09");
		expect(s.payerCoverage.unattributedBefore.calls).toBe(3);

		// And the identity that makes the disclosure meaningful: the value it names is precisely the
		// part of the range that CANNOT be in the charged headline.
		expect(s.totals.chargedCostMicros).toBe(20_000_000 + 16_249);
		const unattributed = s.payerCoverage.unattributedBefore.costMicros + s.payerCoverage.unattributedSince.costMicros;
		expect(s.totals.costMicros - s.totals.chargedCostMicros).toBeGreaterThanOrEqual(unattributed);
	});
});
