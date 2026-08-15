/**
 * The page-fitting rules `vector_stats` and `my_agents` now depend on (#595).
 *
 * `wire-size.test.ts` proves the two tools fit on production-sized bodies; this file proves the
 * PROPERTIES that make that a fix rather than a coincidence — that paging terminates, that it
 * loses nothing, and that the budget is counted in the unit a host actually applies.
 */

import { describe, expect, it } from "vitest";
import { WIRE_BUDGET_BYTES, WIRE_LIMIT_BYTES, fitPage, wireBytes } from "./wire-budget.js";

const rows = (n: number, size = 400) =>
	Array.from({ length: n }, (_, i) => ({ id: `row-${i}`, text: "x".repeat(size) }));

const page = (all: readonly { id: string }[], offset?: number, limit?: number, budget?: number) =>
	fitPage({ rows: all, offset, limit, budget, build: (r, meta) => ({ total: all.length, page: meta, rows: r }) });

describe("wireBytes — the unit a host limit is expressed in", () => {
	it("counts UTF-8 bytes, not UTF-16 code units", () => {
		// The distinction this whole file rests on. `"漢".length` is 1; on the wire it is 3. A
		// budget kept in `.length` under-reports exactly the payloads most likely to overflow —
		// a Chinese preview from the Language Buddy instance, an em dash in a description.
		expect("漢字".length).toBe(2);
		expect(wireBytes("漢字")).toBe(6);
		expect(wireBytes("plain")).toBe(5);
	});

	it("keeps a non-ASCII collection inside the budget that an ASCII count would miss", () => {
		const cjk = Array.from({ length: 400 }, (_, i) => ({ id: `r${i}`, text: "漢".repeat(300) }));
		const out = page(cjk, 0, undefined, 20_000);
		expect(wireBytes(out.text)).toBeLessThanOrEqual(20_000);
		// And the naive count would have let ~3x through: proof the arm above is load-bearing.
		expect(out.text.length).toBeLessThan(wireBytes(out.text));
	});
});

describe("fitPage — the whole collection is reachable, and the reply says so", () => {
	it("fits a collection that is many times the budget", () => {
		const all = rows(2000);
		const out = page(all);
		expect(wireBytes(JSON.stringify({ total: all.length, rows: all }))).toBeGreaterThan(WIRE_LIMIT_BYTES * 10);
		expect(wireBytes(out.text)).toBeLessThanOrEqual(WIRE_BUDGET_BYTES);
		expect(out.meta.hasMore).toBe(true);
		expect(out.meta.of).toBe(2000);
	});

	it("walks every row exactly once when the caller follows nextOffset", () => {
		// The property that makes paging a fix rather than a truncation with better manners: a
		// caller that follows the cursor sees the whole collection, in order, with no gap and no
		// repeat. A `nextOffset` off by one in either direction is silent data loss or an
		// infinite loop, and neither shows up in a size assertion.
		const all = rows(900);
		const seen: string[] = [];
		let offset: number | null = 0;
		let calls = 0;
		while (offset !== null) {
			const out = page(all, offset);
			seen.push(...(JSON.parse(out.text) as { rows: { id: string }[] }).rows.map((r) => r.id));
			offset = out.meta.nextOffset;
			if (++calls > 100) throw new Error("paging did not terminate");
		}
		expect(seen).toEqual(all.map((r) => r.id));
		expect(calls).toBeGreaterThan(1);
	});

	it("ends with hasMore false and nextOffset null, so a caller knows it is done", () => {
		const out = page(rows(3), 0);
		expect(out.meta).toMatchObject({ offset: 0, count: 3, of: 3, hasMore: false, nextOffset: null });
	});

	it("honours an explicit limit, and still budgets below it", () => {
		const all = rows(2000);
		expect(page(all, 0, 5).meta.count).toBe(5);
		// A limit larger than the budget allows is reduced, not refused — `page.count` is the
		// truth, which is what the argument's description promises.
		const big = page(all, 0, 2000);
		expect(big.meta.count).toBeLessThan(2000);
		expect(wireBytes(big.text)).toBeLessThanOrEqual(WIRE_BUDGET_BYTES);
	});

	it("clamps an offset past the end instead of throwing", () => {
		const out = page(rows(3), 99);
		expect(out.meta).toMatchObject({ offset: 3, count: 0, of: 3, hasMore: false, nextOffset: null });
	});

	it("counts the HEAD against the budget, not just the rows", () => {
		// #569's mistake in miniature: measuring the collection and not the document. A head that
		// is most of the budget must leave room for fewer rows, not the same number.
		const all = rows(200);
		const withHead = fitPage({ rows: all, budget: 20_000, build: (r, meta) => ({ legend: "L".repeat(15_000), page: meta, rows: r }) });
		const withoutHead = page(all, 0, undefined, 20_000);
		expect(wireBytes(withHead.text)).toBeLessThanOrEqual(20_000);
		expect(withHead.meta.count).toBeLessThan(withoutHead.meta.count);
	});
});

describe("fitPage — a row bigger than the whole budget", () => {
	const oversize = [{ id: "huge", text: "x".repeat(80_000) }, { id: "small", text: "y" }];

	it("still advances, so a caller following the cursor cannot loop forever", () => {
		// The corner that turns a budget into a hang. Emitting zero rows and leaving `nextOffset`
		// where it was is an infinite sequence of empty pages; skipping the row is silent loss.
		const out = page(oversize, 0, undefined, 10_000);
		expect(out.meta.count).toBe(1);
		expect(out.meta.nextOffset).toBe(1);
		expect(out.meta.hasMore).toBe(true);
	});

	it("says the page is over budget rather than pretending it is not", () => {
		const out = page(oversize, 0, undefined, 10_000);
		expect(out.meta.note).toContain("over this tool's");
		expect(out.meta.note).toContain("bytes on its own");
	});

	it("carries no note when nothing was oversized", () => {
		expect(page(rows(10), 0, undefined, 20_000).meta.note).toBeUndefined();
	});
});
