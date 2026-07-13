import { describe, expect, it } from "vitest";
import { aggregateUsage, denseDays, usageDay, type UsageRow } from "./usage.js";

const row = (over: Partial<UsageRow> = {}): UsageRow => ({
	agent_id: "a1", instance_id: "i1", provider: "anthropic", model: "claude-sonnet-4-6",
	kind: "chat", input_tokens: 1000, output_tokens: 200, cost_micros: 6000,
	created_at: "2026-07-14 10:00:00", ...over,
});

describe("usageDay", () => {
	it("takes the UTC date portion of a D1 timestamp", () => {
		expect(usageDay("2026-07-14 23:59:59")).toBe("2026-07-14");
	});
});

describe("denseDays", () => {
	it("returns an inclusive list", () => {
		expect(denseDays("2026-07-12", "2026-07-14")).toEqual(["2026-07-12", "2026-07-13", "2026-07-14"]);
	});
	it("is empty when to < from", () => {
		expect(denseDays("2026-07-14", "2026-07-12")).toEqual([]);
	});
});

describe("aggregateUsage", () => {
	it("sums totals across rows", () => {
		const s = aggregateUsage([row(), row({ input_tokens: 500, output_tokens: 100, cost_micros: 3000 })]);
		expect(s.totals).toEqual({ inputTokens: 1500, outputTokens: 300, costMicros: 9000, calls: 2 });
	});

	it("breaks down by model, kind and agent sorted by cost", () => {
		const s = aggregateUsage([
			row({ model: "claude-sonnet-4-6", kind: "chat", agent_id: "a1", cost_micros: 6000 }),
			row({ model: "claude-opus-4", kind: "coding", agent_id: "a2", cost_micros: 90000 }),
		]);
		expect(s.byModel[0].key).toBe("claude-opus-4"); // higher cost first
		expect(s.byKind.map((b) => b.key)).toContain("coding");
		expect(s.byAgent[0].key).toBe("a2");
		expect(s.byAgent[0].calls).toBe(1);
	});

	it("labels agents from the name map and marks null agent as Unassigned", () => {
		const s = aggregateUsage([row({ agent_id: "a1" }), row({ agent_id: null })], { agentNames: { a1: "Coder" } });
		const a1 = s.byAgent.find((b) => b.key === "a1");
		const un = s.byAgent.find((b) => b.key === "unassigned");
		expect(a1?.label).toBe("Coder");
		expect(un?.label).toBe("Unassigned");
	});

	it("produces a dense daily series with zero-filled gaps when a range is given", () => {
		const s = aggregateUsage(
			[row({ created_at: "2026-07-12 08:00:00" }), row({ created_at: "2026-07-14 08:00:00" })],
			{ fromDay: "2026-07-12", toDay: "2026-07-14" },
		);
		expect(s.daily.map((d) => d.date)).toEqual(["2026-07-12", "2026-07-13", "2026-07-14"]);
		expect(s.daily[1]).toMatchObject({ date: "2026-07-13", inputTokens: 0, calls: 0 }); // the gap day
		expect(s.daily[0].inputTokens).toBe(1000);
	});

	it("without a range, daily covers only days that have data (sorted)", () => {
		const s = aggregateUsage([row({ created_at: "2026-07-14 08:00:00" }), row({ created_at: "2026-07-10 08:00:00" })]);
		expect(s.daily.map((d) => d.date)).toEqual(["2026-07-10", "2026-07-14"]);
	});
});
