import { describe, expect, it } from "vitest";
import {
	applySettlement,
	canAdmit,
	DEFAULT_LIMITS,
	formatMicros,
	formatTokens,
	isExhausted,
	remainingCost,
	remainingDelegations,
	sanitizeLimits,
	type BudgetState,
} from "./delegation-budget.js";

const state = (over: Partial<BudgetState> = {}): BudgetState => ({
	costMicrosLimit: 1_000_000,
	costMicrosReserved: 0,
	costMicrosSpent: 0,
	delegationsLimit: 10,
	delegationsUsed: 0,
	maxDepth: 4,
	...over,
});

describe("remainingCost", () => {
	it("treats RESERVED money as unavailable — this is the overbooking fix", () => {
		// If reserved were ignored, N concurrent siblings would each see the full pool and
		// collectively overshoot by N × run_cost.
		expect(remainingCost(state({ costMicrosReserved: 400_000 }))).toBe(600_000);
	});

	it("subtracts both reserved and spent", () => {
		expect(remainingCost(state({ costMicrosReserved: 200_000, costMicrosSpent: 300_000 }))).toBe(500_000);
	});

	it("never goes negative when an actual overshoots its reservation", () => {
		expect(remainingCost(state({ costMicrosSpent: 5_000_000 }))).toBe(0);
	});
});

describe("canAdmit", () => {
	it("admits a step that fits", () => {
		expect(canAdmit(state(), { depth: 1, estimatedCostMicros: 100_000 }).ok).toBe(true);
	});

	it("refuses past the depth cap", () => {
		const a = canAdmit(state(), { depth: 5, estimatedCostMicros: 1 });
		expect(a.reason).toBe("too_deep");
		expect(a.message).toContain("depth 5");
	});

	it("refuses when the delegation COUNT is spent, even with money left", () => {
		// Depth alone bounds nothing: a supervisor can re-delegate sequentially at constant
		// depth forever. The count is what stops that.
		const a = canAdmit(state({ delegationsUsed: 10 }), { depth: 1, estimatedCostMicros: 1 });
		expect(a.reason).toBe("delegations_exhausted");
	});

	it("refuses when the reservation would exceed what is left", () => {
		const a = canAdmit(state({ costMicrosSpent: 950_000 }), { depth: 1, estimatedCostMicros: 100_000 });
		expect(a.reason).toBe("cost_exhausted");
	});

	it("counts in-flight reservations against a new sibling", () => {
		// Two siblings, each reserving 600k against a 1M pool: the second must be refused even
		// though nothing has SETTLED yet.
		const afterFirst = state({ costMicrosReserved: 600_000 });
		expect(canAdmit(afterFirst, { depth: 1, estimatedCostMicros: 600_000 }).reason).toBe("cost_exhausted");
	});

	it("reports money in a form a human reads, not micros", () => {
		const a = canAdmit(state({ costMicrosSpent: 1_000_000 }), { depth: 1, estimatedCostMicros: 1 });
		expect(a.message).toContain("$1.00");
	});

	it("allows a step that exactly consumes the remainder", () => {
		expect(canAdmit(state({ costMicrosSpent: 900_000 }), { depth: 1, estimatedCostMicros: 100_000 }).ok).toBe(true);
	});

	it("allows exactly the depth cap", () => {
		expect(canAdmit(state(), { depth: 4, estimatedCostMicros: 1 }).ok).toBe(true);
	});
});

describe("applySettlement", () => {
	it("releases the reservation and charges the actual", () => {
		const b = applySettlement(state({ costMicrosReserved: 200_000 }), 200_000, 50_000);
		expect(b.costMicrosReserved).toBe(0);
		expect(b.costMicrosSpent).toBe(50_000);
		// Change given back: 950k still drawable, not 800k.
		expect(remainingCost(b)).toBe(950_000);
	});

	it("charges an overspend in full rather than capping it at the reservation", () => {
		// The money is already gone; hiding it would make the pool lie.
		const b = applySettlement(state({ costMicrosReserved: 100_000 }), 100_000, 300_000);
		expect(b.costMicrosSpent).toBe(300_000);
		expect(remainingCost(b)).toBe(700_000);
	});

	it("cannot drive reserved below zero on a double settle", () => {
		const once = applySettlement(state({ costMicrosReserved: 100_000 }), 100_000, 10_000);
		const twice = applySettlement(once, 100_000, 0);
		expect(twice.costMicrosReserved).toBe(0);
	});
});

describe("isExhausted", () => {
	it("is false while work is still in flight", () => {
		expect(isExhausted(state({ costMicrosSpent: 1_000_000, costMicrosReserved: 50_000 }))).toBe(false);
	});

	it("is true once nothing is left and nothing is held", () => {
		expect(isExhausted(state({ costMicrosSpent: 1_000_000 }))).toBe(true);
	});
});

describe("sanitizeLimits", () => {
	it("clamps to the ceiling — a supervisor cannot raise its own budget", () => {
		// The pool only ever decreases downward. Raising it is a human action.
		const l = sanitizeLimits({ costMicros: 999_000_000, delegations: 10_000, maxDepth: 99 });
		expect(l.costMicros).toBe(DEFAULT_LIMITS.costMicros);
		expect(l.delegations).toBe(DEFAULT_LIMITS.delegations);
		expect(l.maxDepth).toBe(DEFAULT_LIMITS.maxDepth);
	});

	it("accepts a SMALLER request", () => {
		expect(sanitizeLimits({ costMicros: 1_000 }).costMicros).toBe(1_000);
	});

	it("defaults a tree nobody configured to something finite", () => {
		// "We'll set a limit later" is how the first runaway happens.
		const l = sanitizeLimits(undefined);
		expect(l).toEqual(DEFAULT_LIMITS);
		expect(Number.isFinite(l.costMicros)).toBe(true);
	});

	it("rejects junk without throwing", () => {
		expect(sanitizeLimits({ costMicros: "lots", maxDepth: NaN })).toEqual(DEFAULT_LIMITS);
		expect(sanitizeLimits({ costMicros: -5 }).costMicros).toBe(0);
	});
});

describe("remainingDelegations / formatMicros", () => {
	it("floors at zero", () => {
		expect(remainingDelegations(state({ delegationsUsed: 99 }))).toBe(0);
	});

	it("formats micros as dollars", () => {
		expect(formatMicros(1_250_000)).toBe("$1.25");
		expect(formatMicros(-1)).toBe("$0.00");
	});

	it("formats tokens as the magnitude a human compares against", () => {
		// The other unit a refusal can be denominated in (#343). "250000000 tokens" reads as
		// noise; every tool that shows this number shows it this way.
		expect(formatTokens(13_400_000)).toBe("13M");
		expect(formatTokens(2_500_000)).toBe("2.5M");
		expect(formatTokens(250_000_000)).toBe("250M");
		expect(formatTokens(1500)).toBe("2K");
		expect(formatTokens(-5)).toBe("0");
	});
});

describe("account ceiling vs pool exhaustion — distinguishable, because they mean opposite things", () => {
	it("names the account backstop separately from the pool being spent", async () => {
		// Both used to return `cost_exhausted`, so the workflow marked the SHARED tree budget
		// `exhausted` when the ACCOUNT's rolling 24h backstop tripped. A pool with $4.90 of $5.00
		// left was closed; every sibling loop drawing on it then failed with "This run's budget is
		// already closed"; and when the 24h window rolled off the pool was STILL exhausted, with
		// `raiseBudget` exported but reachable from no route. One is a terminal fact about the
		// pool, the other a transient fact about the account.
		const store = await import("./delegation-budget-store.js");
		const src = (await import("node:fs")).readFileSync(
			(await import("node:path")).join(import.meta.dirname, "delegation-budget-store.ts"),
			"utf8",
		);
		expect(store).toBeTruthy();
		// The daily-ceiling refusal must NOT reuse the pool's reason.
		const ceilingBlock = src.slice(src.indexOf("DAILY_CEILING_MICROS)"), src.indexOf("const res = await env.DB.prepare"));
		expect(ceilingBlock).toContain('reason: "account_ceiling"');
		expect(ceilingBlock).not.toContain('reason: "cost_exhausted"');
	});

	it("both workflows refuse to close the shared pool for an account-level trip", async () => {
		const fs = await import("node:fs");
		const path = await import("node:path");
		for (const f of ["agent-loop.ts", "coding-session.ts"]) {
			const src = fs.readFileSync(path.join(import.meta.dirname, "..", "workflows", f), "utf8");
			expect(src, `${f} must not markExhausted on account_ceiling`).toMatch(/draw\.reason !== "account_ceiling"/);
		}
	});
});
