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
		expect(s.totals).toEqual({ inputTokens: 1500, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 9000, chargedCostMicros: 0, calls: 2 });
	});

	it("reports charged value separately from total list value — never added together", () => {
		// The page's whole correction (#346/#347). `cost_micros` is notional value on EVERY row:
		// tokens × list price, ours or Claude Code's. Only some of it is money anyone owes, and
		// a single "Est. cost" over the sum is what taught the product to read this as a bill.
		const s = aggregateUsage([
			row({ payer: "byok-api", cost_micros: 4000 }),
			row({ payer: "platform", cost_micros: 1000 }),
			row({ payer: "subscription", kind: "engine", cost_micros: 2_870_000 }),
			row({ payer: null, kind: "engine", cost_micros: 900_000 }),
		]);
		expect(s.totals.chargedCostMicros).toBe(5000);
		expect(s.totals.costMicros).toBe(3_775_000); // the value is real; the charge is $0.005
	});

	it("buckets by payer, with an unattributed row shown rather than dropped", () => {
		// A row we cannot attribute is still consumption the owner should see. Hiding it would
		// make the page's own attribution look more complete than it is.
		const s = aggregateUsage([
			row({ payer: "byok-api", cost_micros: 100 }),
			row({ payer: null, cost_micros: 900 }),
		]);
		expect(s.byPayer.map((b) => b.key).sort()).toEqual(["byok-api", "unknown"]);
		expect(s.byPayer.find((b) => b.key === "unknown")?.label).toBe("Payer not established");
	});

	it("treats a pre-payer row as unknown, not as charged", () => {
		// No backfill on migration 0092: rows written before it genuinely do not record who paid,
		// and stamping one on retrospectively is the inference the column exists to remove.
		const s = aggregateUsage([row({ cost_micros: 6000 })]);
		expect(s.totals.chargedCostMicros).toBe(0);
		expect(s.byPayer[0].key).toBe("unknown");
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

describe("prompt-cache tokens are reported separately (#212)", () => {
	it("keeps cache reads OUT of inputTokens, so the hit rate is computable", () => {
		// They used to be summed into input. That made the hit rate — cacheRead ÷ (input +
		// cacheRead) — impossible to compute, so nobody could tell whether prompt caching was
		// working, while the cost line silently priced every read at the full input rate.
		const s = aggregateUsage([row({ input_tokens: 200, cache_read_tokens: 1800, cache_write_tokens: 0 })]);
		expect(s.totals.inputTokens).toBe(200);
		expect(s.totals.cacheReadTokens).toBe(1800);
		const hitRate = s.totals.cacheReadTokens / (s.totals.inputTokens + s.totals.cacheReadTokens);
		expect(hitRate).toBeCloseTo(0.9);
	});

	it("carries the split into every breakdown, not just totals", () => {
		// The per-kind view is where you would actually look: "is the Coder's chat cache-hitting?"
		const s = aggregateUsage([
			row({ kind: "chat", input_tokens: 100, cache_read_tokens: 900 }),
			row({ kind: "coding", input_tokens: 1000, cache_read_tokens: 0 }),
		]);
		const chat = s.byKind.find((b) => b.key === "chat");
		const coding = s.byKind.find((b) => b.key === "coding");
		expect(chat?.cacheReadTokens).toBe(900);
		expect(coding?.cacheReadTokens).toBe(0);
	});

	it("treats a pre-migration NULL as zero for the sum without crashing", () => {
		// Rows written before 0074 have NULL — genuinely unknown. Aggregation has to add them up
		// somehow, and zero is the only sane arithmetic; the unknown-vs-zero distinction lives in
		// D1, not in a total.
		const s = aggregateUsage([row({ cache_read_tokens: null, cache_write_tokens: null })]);
		expect(s.totals.cacheReadTokens).toBe(0);
		expect(s.totals.cacheWriteTokens).toBe(0);
	});
});

