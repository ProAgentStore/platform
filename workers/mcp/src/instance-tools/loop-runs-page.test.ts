/** The `coding_loop_status` listing pages instead of spilling or hiding old runs (#898). */
import { describe, expect, it } from "vitest";
import { WIRE_BUDGET_BYTES, wireBytes } from "../wire-budget.js";
import { loopRunsPage } from "./loop-runs-page.js";

const run = (i: number) => ({ runId: `run-${i}`, status: "done", detail: "d".repeat(2000), health: "ended" });

describe("loopRunsPage", () => {
	it("fits the budget and says where the next page starts in the WHOLE list", () => {
		const text = loopRunsPage({ runs: Array.from({ length: 50 }, (_, i) => run(i)), total: 120, offset: 50, nextOffset: 100, starts: [], repoCi: { ok: true } });
		expect(wireBytes(text)).toBeLessThanOrEqual(WIRE_BUDGET_BYTES);
		const out = JSON.parse(text) as { runs: unknown[]; page: { offset: number; count: number; of: number; nextOffset: number }; starts: unknown[]; repoCi: unknown };
		expect(out.page.of).toBe(120);
		expect(out.page.offset).toBe(50);
		expect(out.page.count).toBe(out.runs.length);
		expect(out.page.nextOffset).toBe(50 + out.runs.length);
		expect(out.starts).toEqual([]);
		expect(out.repoCi).toEqual({ ok: true });
	});

	it("ends the listing on the last page", () => {
		const out = JSON.parse(loopRunsPage({ runs: [run(1)], total: 1, offset: 0 })) as { page: { hasMore: boolean; nextOffset: null } };
		expect(out.page).toMatchObject({ hasMore: false, nextOffset: null });
	});
});
