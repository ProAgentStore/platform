/** #1241 — the surface grows only by an appended, reasoned ceiling. */
import { describe, expect, it } from "vitest";
import { MCP_TOOL_COUNT, TOOL_COUNT_CEILINGS } from "./tool-count.js";

describe("TOOL_COUNT_CEILINGS (#1241)", () => {
	it("holds the tool count at or under the latest ceiling", () => {
		const ceiling = TOOL_COUNT_CEILINGS.at(-1)?.count ?? 0;
		expect(
			MCP_TOOL_COUNT,
			`MCP_TOOL_COUNT is ${MCP_TOOL_COUNT}, over the ceiling of ${ceiling}. Append an entry to TOOL_COUNT_CEILINGS in tool-count.ts — { count: ${MCP_TOOL_COUNT}, issue, date, reason } — saying why the surface needs to grow, after checking no existing tool already calls the same API route.`,
		).toBeLessThanOrEqual(ceiling);
	});

	it("starts from the audit's baseline, only ever rises, and gives every raise an issue, date and reason", () => {
		expect(TOOL_COUNT_CEILINGS[0]).toMatchObject({ count: 366, issue: "#1241", date: "2026-10-20" });
		for (const [i, c] of TOOL_COUNT_CEILINGS.entries()) {
			expect(c.issue).toMatch(/^#\d+$/);
			expect(c.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(c.reason.trim().length).toBeGreaterThan(10);
			if (i > 0) {
				expect(c.count).toBeGreaterThan(TOOL_COUNT_CEILINGS[i - 1].count);
				expect(c.date >= TOOL_COUNT_CEILINGS[i - 1].date).toBe(true);
			}
		}
	});
});
