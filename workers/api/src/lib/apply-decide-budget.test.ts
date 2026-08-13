/**
 * The apply run's spend gate (#516).
 *
 * The store and the ledger are stubbed, because what is being asserted is the DECISION each
 * refusal produces — which reason closes the shared pool, what the loop is handed back, and that
 * the reservation is returned on every exit including a throwing decide. Those are the parts that
 * were wrong on the two paths this one is modelled on (`account_ceiling` closing a pool with money
 * left; `50e56ed`'s swallowed settle leaking headroom forever).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const reserve = vi.fn();
const settle = vi.fn(async () => undefined);
const markExhausted = vi.fn(async () => undefined);
vi.mock("./delegation-budget-store.js", () => ({
	reserve: (...a: unknown[]) => reserve(...(a as [])),
	settle: (...a: unknown[]) => settle(...(a as [])),
	markExhausted: (...a: unknown[]) => markExhausted(...(a as [])),
}));

const instanceSpendMicros = vi.fn(async () => 0);
vi.mock("./usage.js", () => ({ instanceSpendMicros: (...a: unknown[]) => instanceSpendMicros(...(a as [])) }));

import { APPLY_RESERVE_MICROS, decideWithinBudget } from "./apply-decide-budget.js";
import type { Env } from "../types.js";

const env = {} as Env;
const scope = { userId: "u1", instanceId: "i1", budgetId: "pool-1", depth: 0 };

beforeEach(() => {
	vi.clearAllMocks();
	reserve.mockResolvedValue({ ok: true, reserved: APPLY_RESERVE_MICROS });
	instanceSpendMicros.mockResolvedValue(0);
});

describe("no pool = exactly the old behaviour", () => {
	it("runs the decide untouched when there is no budgetId", async () => {
		const decision = await decideWithinBudget(env, { userId: "u1", instanceId: "i1" }, async () => ({ thought: "go" }));
		expect(decision).toEqual({ thought: "go" });
		expect(reserve).not.toHaveBeenCalled();
		expect(settle).not.toHaveBeenCalled();
	});

	it("treats an explicit null budgetId the same — a queued run from before #516 still applies", async () => {
		await decideWithinBudget(env, { ...scope, budgetId: null }, async () => ({ thought: "go" }));
		expect(reserve).not.toHaveBeenCalled();
	});
});

describe("a granted draw", () => {
	it("reserves before the model runs, and settles the measured delta after", async () => {
		const order: string[] = [];
		reserve.mockImplementation(async () => {
			order.push("reserve");
			return { ok: true, reserved: APPLY_RESERVE_MICROS };
		});
		// $0.04 of charged spend appeared between the two reads.
		instanceSpendMicros.mockResolvedValueOnce(1_000_000).mockResolvedValueOnce(1_040_000);
		settle.mockImplementation(async () => {
			order.push("settle");
		});

		const decision = await decideWithinBudget(env, scope, async () => {
			order.push("decide");
			return { action: { action: "click" as const, ref: "e1" } };
		});

		expect(decision).toEqual({ action: { action: "click", ref: "e1" } });
		expect(order).toEqual(["reserve", "decide", "settle"]);
		expect(reserve).toHaveBeenCalledWith(env, "u1", "pool-1", { depth: 0, estimatedCostMicros: APPLY_RESERVE_MICROS });
		// Settles the ACTUAL cost, not the reservation — settling the held amount every step would
		// drain the pool at the worst case and the refund would never happen.
		expect(settle).toHaveBeenCalledWith(env, "u1", "pool-1", APPLY_RESERVE_MICROS, 40_000);
	});

	it("settles a throwing decide too, and does not swallow its error", async () => {
		// The tokens were spent either way, and a pool that only charges for successes lets a
		// failing loop run free — while the reservation it holds starves the pool forever (50e56ed).
		await expect(
			decideWithinBudget(env, scope, async () => {
				throw new Error("BYOK timed out");
			}),
		).rejects.toThrow("BYOK timed out");
		expect(settle).toHaveBeenCalledTimes(1);
	});

	it("charges the whole reservation when the ledger cannot be read back", async () => {
		instanceSpendMicros.mockResolvedValueOnce(500_000).mockRejectedValueOnce(new Error("D1 down"));
		await decideWithinBudget(env, scope, async () => ({ thought: "ok" }));
		// Over-charging stops a run early; under-charging lets a runaway continue.
		expect(settle).toHaveBeenCalledWith(env, "u1", "pool-1", APPLY_RESERVE_MICROS, APPLY_RESERVE_MICROS);
	});

	it("never settles a negative delta, so a shrinking read cannot hand out free headroom", async () => {
		instanceSpendMicros.mockResolvedValueOnce(900_000).mockResolvedValueOnce(100_000);
		await decideWithinBudget(env, scope, async () => ({ thought: "ok" }));
		expect(settle).toHaveBeenCalledWith(env, "u1", "pool-1", APPLY_RESERVE_MICROS, 0);
	});

	it("a settle failure does not replace the decision the caller was owed", async () => {
		settle.mockRejectedValue(new Error("D1 down"));
		await expect(decideWithinBudget(env, scope, async () => ({ thought: "ok" }))).resolves.toEqual({ thought: "ok" });
	});
});

describe("a refused draw ends the application instead of throwing", () => {
	it("hands the loop a terminal finish, and never calls the model", async () => {
		const decide = vi.fn();
		reserve.mockResolvedValue({ ok: false, reason: "cost_exhausted", message: "This run hit its budget." });

		const decision = await decideWithinBudget(env, scope, decide);

		// `runApplyLoop` ends the run on a `finish`, so the board shows a reason a human reads and
		// the transcript still reaches the per-ATS cache.
		expect(decision.finish).toEqual({ status: "blocked", detail: "This run hit its budget." });
		expect(decide).not.toHaveBeenCalled();
		// Nothing was reserved, so nothing may be released: a settle here would ADD spend to the
		// pool for a step that never ran.
		expect(settle).not.toHaveBeenCalled();
	});

	it("closes the shared pool for a pool-level refusal", async () => {
		reserve.mockResolvedValue({ ok: false, reason: "cost_exhausted", message: "spent" });
		await decideWithinBudget(env, scope, async () => ({ thought: "unreachable" }));
		expect(markExhausted).toHaveBeenCalledWith(env, "u1", "pool-1", "cost_exhausted", 0);
	});

	// The regression that produced the reason code: a pool with $4.90 of $5.00 left was closed
	// when the ACCOUNT's rolling 24h backstop tripped, every sibling then failed with "already
	// closed", and the window rolling off did not reopen it.
	it.each(["account_ceiling", "not_found", "closed"])("does NOT close the pool for %s", async (reason) => {
		reserve.mockResolvedValue({ ok: false, reason, message: "no" });
		await decideWithinBudget(env, scope, async () => ({ thought: "unreachable" }));
		expect(markExhausted).not.toHaveBeenCalled();
	});

	it("still produces a readable refusal when the store gave no message", async () => {
		reserve.mockResolvedValue({ ok: false, reason: "closed" });
		const decision = await decideWithinBudget(env, scope, async () => ({ thought: "unreachable" }));
		expect(decision.finish?.detail).toBe("This application hit its spend limit.");
	});

	it("a markExhausted failure does not turn a refusal into a crash", async () => {
		reserve.mockResolvedValue({ ok: false, reason: "cost_exhausted", message: "spent" });
		markExhausted.mockRejectedValue(new Error("D1 down"));
		await expect(decideWithinBudget(env, scope, async () => ({ thought: "x" }))).resolves.toMatchObject({
			finish: { status: "blocked" },
		});
	});
});

describe("the refusal wording cannot be mistaken for a human check", () => {
	// `apply-loop.ts:219` re-routes a `blocked` finish whose detail looks like a captcha to a HUMAN
	// TAKEOVER. A budget refusal that tripped that regex would page the owner to come and solve a
	// challenge that does not exist, on a run that has stopped for money — and the takeover would
	// wait out the full 15-minute handoff before failing.
	const CAPTCHA_REROUTE = /captcha|not a robot|are you (a )?human|verify you('?re| are) human|anti-?bot/i;

	it("is testing the SAME regex the loop re-routes on", async () => {
		// Copied rather than imported (it is an inline literal in the loop), so the copy is pinned
		// to the original — a guard against a regex that quietly stops being the one that runs.
		const fs = await import("node:fs");
		const path = await import("node:path");
		const src = fs.readFileSync(path.join(import.meta.dirname, "apply-loop.ts"), "utf8");
		expect(src).toContain(CAPTCHA_REROUTE.source);
	});

	it("the store's own refusal messages do not trip the re-route", async () => {
		// The real strings `reserve()` returns for a refusal, quoted from delegation-budget-store.ts
		// and delegation-budget.ts.
		for (const message of [
			"This run hit its budget.",
			"This run's budget is already closed.",
			"That delegation budget no longer exists.",
			"Stopped: $50.00 of charged AI spend in the last 24h across all your runs, against a $50.00 account circuit breaker.",
		]) {
			reserve.mockResolvedValue({ ok: false, reason: "cost_exhausted", message });
			const decision = await decideWithinBudget(env, scope, async () => ({ thought: "x" }));
			expect(decision.finish?.detail, message).not.toMatch(CAPTCHA_REROUTE);
		}
	});

	it("the fallback wording does not trip it either", async () => {
		reserve.mockResolvedValue({ ok: false, reason: "closed" });
		const decision = await decideWithinBudget(env, scope, async () => ({ thought: "x" }));
		expect(decision.finish?.detail).not.toMatch(CAPTCHA_REROUTE);
	});
});
