import { describe, expect, it } from "vitest";
import { aggregateAdminUsage, PLATFORM_PROVIDER, type AdminUsageRow } from "./usage.js";

function row(p: Partial<AdminUsageRow>): AdminUsageRow {
	return {
		user_id: "u1",
		agent_id: null,
		instance_id: null,
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		kind: "chat",
		input_tokens: 1000,
		output_tokens: 500,
		cost_micros: 10500,
		created_at: "2026-08-01 10:00:00",
		...p,
	};
}

describe("aggregateAdminUsage", () => {
	it("totals across all users and buckets by provider/model/kind/user", () => {
		const s = aggregateAdminUsage([
			row({ user_id: "u1", cost_micros: 100 }),
			row({ user_id: "u2", cost_micros: 300, model: "claude-opus-4" }),
			row({ user_id: "u2", cost_micros: 50, kind: "apply" }),
		]);
		expect(s.totals.calls).toBe(3);
		expect(s.totals.costMicros).toBe(450);
		// byUser sorted by cost: u2 (350) before u1 (100)
		expect(s.byUser.map((b) => b.key)).toEqual(["u2", "u1"]);
		expect(s.byUser[0].costMicros).toBe(350);
		expect(s.byModel.map((b) => b.key)).toContain("claude-opus-4");
		expect(s.byKind.map((b) => b.key).sort()).toEqual(["apply", "chat"]);
	});

	it("splits platform-paid from BYOK by provider", () => {
		const s = aggregateAdminUsage([
			row({ provider: "anthropic", cost_micros: 1000 }),
			row({ provider: "cloudflare", cost_micros: 0 }),
			row({ provider: PLATFORM_PROVIDER, cost_micros: 250, kind: "embedding" as AdminUsageRow["kind"] }),
		]);
		expect(s.split.platformPaid.costMicros).toBe(250);
		expect(s.split.platformPaid.calls).toBe(1);
		expect(s.split.byok.costMicros).toBe(1000);
		expect(s.split.byok.calls).toBe(2);
	});

	/**
	 * The split is on the VENDOR, so the bucket alone cannot say what was charged (#346).
	 *
	 * `anthropic` is reached both by a metered API key and by a Claude subscription that costs
	 * nothing per token. The operator dashboard's "BYOK spend" reads `chargedMicros` for exactly
	 * this reason — the value figure beside it counts a subscription's engine turns at list price,
	 * which is the arithmetic that refused a delegation in #343.
	 */
	it("keeps BYOK VALUE and BYOK SPEND apart — same vendor, different payer", () => {
		const s = aggregateAdminUsage([
			row({ provider: "anthropic", cost_micros: 48_760_000, payer: "subscription" }),
			row({ provider: "anthropic", cost_micros: 1_000_000, payer: "byok-api" }),
			row({ provider: PLATFORM_PROVIDER, cost_micros: 250, payer: "platform", kind: "embedding" as AdminUsageRow["kind"] }),
		]);
		expect(s.split.byok.costMicros).toBe(49_760_000);
		expect(s.split.byok.chargedMicros).toBe(1_000_000);
		expect(s.split.platformPaid.chargedMicros).toBe(250);
	});

	it("counts a row with no established payer as value, never as a charge", () => {
		// NULL is the honest answer for a machine-login engine; it must not become a bill.
		const s = aggregateAdminUsage([row({ provider: "anthropic", cost_micros: 900, payer: null })]);
		expect(s.split.byok.costMicros).toBe(900);
		expect(s.split.byok.chargedMicros).toBe(0);
	});

	it("carries the charged figure into byUser and byAgent, not only into the split (#543)", () => {
		// The operator view had the same defect as the owner's page: a per-user total that could
		// not be decomposed into money. Both breakdowns go through the shared `bump()`, so this
		// is the assertion that keeps the two aggregates from drifting apart again.
		const s = aggregateAdminUsage([
			row({ user_id: "u1", agent_id: "a1", cost_micros: 1_000_000, payer: "byok-api" }),
			row({ user_id: "u1", agent_id: "a2", cost_micros: 48_760_000, payer: "subscription" }),
			row({ user_id: "u2", agent_id: "a2", cost_micros: 900, payer: null }),
		]);
		expect(s.byUser.find((b) => b.key === "u1")).toMatchObject({ costMicros: 49_760_000, chargedCostMicros: 1_000_000 });
		expect(s.byUser.find((b) => b.key === "u2")).toMatchObject({ costMicros: 900, chargedCostMicros: 0 });
		expect(s.byAgent.find((b) => b.key === "a2")).toMatchObject({ costMicros: 48_760_900, chargedCostMicros: 0 });
		const sum = s.byUser.reduce((n, b) => n + b.chargedCostMicros, 0);
		expect(sum).toBe(s.totals.chargedMicros);
	});

	it("labels users and agents from the provided name maps", () => {
		const s = aggregateAdminUsage([row({ user_id: "u1", agent_id: "a1" })], {
			userNames: { u1: "alice" },
			agentNames: { a1: "Coder" },
		});
		expect(s.byUser[0].label).toBe("alice");
		expect(s.byAgent[0].label).toBe("Coder");
	});

	it("produces a dense daily series over the window", () => {
		const s = aggregateAdminUsage([row({ created_at: "2026-08-01 10:00:00" })], {
			fromDay: "2026-07-30",
			toDay: "2026-08-01",
		});
		expect(s.daily.map((d) => d.date)).toEqual(["2026-07-30", "2026-07-31", "2026-08-01"]);
		expect(s.daily[0].calls).toBe(0);
		expect(s.daily[2].calls).toBe(1);
	});
});
