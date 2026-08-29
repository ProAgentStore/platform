import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "./delegation-budget.js";
import {
	DAILY_CEILING_MICROS,
	DAILY_TOKEN_CEILING,
	openBudget,
	markExhausted,
	raiseBudget,
	reserve,
	resolveAccountCeilings,
	settle,
} from "./delegation-budget-store.js";
import type { Env } from "../types.js";

interface Write {
	sql: string;
	args: unknown[];
}

/** D1 stub: `changes` drives whether an UPDATE matched; `row` is what a SELECT reads back. */
function buildEnv(opts: { changes?: number; row?: Record<string, unknown> | null } = {}) {
	const writes: Write[] = [];
	const env = {
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async first() {
								return opts.row === undefined ? null : opts.row;
							},
							// resolveAccountCeilings uses .all() for account_budget_limits.
							// Return empty results so it falls through to the hard constants.
							async all() {
								return { results: [] };
							},
							async run() {
								writes.push({ sql, args });
								return { meta: { changes: opts.changes ?? 1 } };
							},
						};
					},
				};
			},
		},
	} as unknown as Env;
	return { env, writes };
}

const openRow = (over: Record<string, unknown> = {}) => ({
	id: "b1",
	user_id: "u1",
	root_instance_id: "i1",
	cost_micros_limit: 1_000_000,
	cost_micros_reserved: 0,
	cost_micros_spent: 1_000_000,
	delegations_limit: 10,
	delegations_used: 0,
	max_depth: 4,
	status: "open",
	exhausted_reason: null,
	exhausted_at_depth: null,
	created_at: "",
	updated_at: "",
	...over,
});

describe("reserve — the atomic draw", () => {
	it("tests affordability inside the UPDATE, not before it", async () => {
		// This is the whole correctness argument: a read-then-write would let two concurrent
		// siblings both pass and both spend. Whoever D1 applies second must see the first
		// reservation already subtracted and match zero rows.
		const { env, writes } = buildEnv({ changes: 1 });
		await reserve(env, "u1", "b1", { depth: 1, estimatedCostMicros: 100_000 });
		const sql = writes[0].sql.replace(/\s+/g, " ");
		expect(sql).toContain("UPDATE delegation_budgets");
		expect(sql).toContain("(cost_micros_limit - cost_micros_reserved - cost_micros_spent) >= ?3");
		expect(writes).toHaveLength(1); // one statement, not check-then-write
	});

	it("guards depth and the delegation count in the same statement", async () => {
		// In SQL rather than in JS, so a concurrent sibling cannot slip past the count.
		const { env, writes } = buildEnv({ changes: 1 });
		await reserve(env, "u1", "b1", { depth: 2, estimatedCostMicros: 1 });
		const sql = writes[0].sql.replace(/\s+/g, " ");
		expect(sql).toContain("delegations_used < delegations_limit");
		expect(sql).toContain("<= max_depth");
		expect(sql).toContain("status = 'open'");
	});

	it("increments the delegation count as part of the reservation", async () => {
		const { env, writes } = buildEnv({ changes: 1 });
		await reserve(env, "u1", "b1", { depth: 1, estimatedCostMicros: 1 });
		expect(writes[0].sql.replace(/\s+/g, " ")).toContain("delegations_used = delegations_used + 1");
	});

	it("returns the exact amount held, so settle can release it", async () => {
		const { env } = buildEnv({ changes: 1 });
		const r = await reserve(env, "u1", "b1", { depth: 1, estimatedCostMicros: 250_000 });
		expect(r).toMatchObject({ ok: true, reserved: 250_000 });
	});

	it("floors a negative or fractional estimate", async () => {
		const { env, writes } = buildEnv({ changes: 1 });
		await reserve(env, "u1", "b1", { depth: 1, estimatedCostMicros: -5 });
		expect(writes[0].args[2]).toBe(0);
	});

	it("explains WHICH limit stopped it rather than failing generically", async () => {
		// "budget exhausted at depth 3" is actionable; a bare failure is not.
		const { env } = buildEnv({ changes: 0, row: openRow() });
		const r = await reserve(env, "u1", "b1", { depth: 1, estimatedCostMicros: 100_000 });
		expect(r.ok).toBe(false);
		expect(r.reason).toBe("cost_exhausted");
		expect(r.message).toContain("$1.00");
	});

	it("distinguishes an exhausted count from exhausted money", async () => {
		const { env } = buildEnv({ changes: 0, row: openRow({ cost_micros_spent: 0, delegations_used: 10 }) });
		expect((await reserve(env, "u1", "b1", { depth: 1, estimatedCostMicros: 1 })).reason).toBe("delegations_exhausted");
	});

	it("reports a missing pool distinctly from an exhausted one", async () => {
		const { env } = buildEnv({ changes: 0, row: null });
		expect((await reserve(env, "u1", "b1", { depth: 1, estimatedCostMicros: 1 })).reason).toBe("not_found");
	});

	/**
	 * #594 — the refusal named a state the system cannot enter.
	 *
	 * `closeBudget` was the only writer of `'closed'` and had no production caller. It is now
	 * deleted (#594 AC4). An EXHAUSTED pool is the only non-open state a real row can reach.
	 *
	 * These tests cover the exhausted-pool path; the old `status: "closed"` tests are removed
	 * because `toView` now maps unknown status values to `"open"` and `BudgetView.status` no
	 * longer includes `"closed"` — the dead-vocabulary decision is recorded in `status-domain.ts`.
	 */
	describe("an exhausted pool is refused with the right message (#594)", () => {
		const refuse = (over: Record<string, unknown>) =>
			reserve(buildEnv({ changes: 0, row: openRow({ status: "exhausted", cost_micros_spent: 0, ...over }) }).env, "u1", "b1", { depth: 1, estimatedCostMicros: 1 });

		it("says EXHAUSTED, and does not say closed", async () => {
			const r = await refuse({ exhausted_reason: "cost_exhausted", exhausted_at_depth: 3 });
			expect(r.ok).toBe(false);
			expect(r.message).toContain("EXHAUSTED");
			expect(r.message).not.toMatch(/already closed/);
		});

		it("names WHICH limit ran out, and at what depth", async () => {
			expect((await refuse({ exhausted_reason: "cost_exhausted", exhausted_at_depth: 3 })).message).toMatch(/spend limit.*depth 3/);
			expect((await refuse({ exhausted_reason: "delegations_exhausted", exhausted_at_depth: 1 })).message).toMatch(/number of delegations/);
			expect((await refuse({ exhausted_reason: "too_deep", exhausted_at_depth: 4 })).message).toMatch(/depth/);
		});

		it("promises no self-service remedy, because `raiseBudget` has no route", async () => {
			// The docblock on `markExhausted` used to say the work was "resumable once a human
			// raises the limit". Nothing can call `raiseBudget`, so that sentence sent an owner
			// looking for a button that does not exist. Saying who to ask is the honest form.
			const r = await refuse({ exhausted_reason: "cost_exhausted", exhausted_at_depth: 2 });
			expect(r.message).toContain("platform operator");
			expect(r.message).toContain("intact");
		});

		it("keeps the REASON code coarse, because two workflows branch on it", async () => {
			// `workflows/agent-loop.ts:113` and `coding-decide-budget.ts:38` read `closed` as "do
			// not call markExhausted", which is right for an exhausted pool too. The message is for
			// the human; the reason is control flow, and splitting it would change their branches.
			expect((await refuse({ exhausted_reason: "cost_exhausted", exhausted_at_depth: 1 })).reason).toBe("closed");
		});
	});

	it("is owner-scoped", async () => {
		const { env, writes } = buildEnv({ changes: 1 });
		await reserve(env, "u1", "b1", { depth: 1, estimatedCostMicros: 1 });
		expect(writes[0].sql).toContain("user_id = ?2");
		expect(writes[0].args[1]).toBe("u1");
	});
});

describe("settle", () => {
	it("releases the held amount and charges the actual", async () => {
		const { env, writes } = buildEnv();
		await settle(env, "u1", "b1", 200_000, 50_000);
		const sql = writes[0].sql.replace(/\s+/g, " ");
		expect(sql).toContain("cost_micros_reserved = MAX(0, cost_micros_reserved - ?3)");
		expect(sql).toContain("cost_micros_spent = cost_micros_spent + ?4");
		expect(writes[0].args[2]).toBe(200_000);
		expect(writes[0].args[3]).toBe(50_000);
	});

	it("clamps the release at zero so a duplicate settle cannot mint headroom", async () => {
		// Without MAX(0, …) a double settle would drive reserved negative, which reads as free
		// budget to the affordability test.
		const { env, writes } = buildEnv();
		await settle(env, "u1", "b1", 999_999, 0);
		expect(writes[0].sql).toContain("MAX(0,");
	});

	it("charges an overspend in full — the money is already gone", async () => {
		const { env, writes } = buildEnv();
		await settle(env, "u1", "b1", 100_000, 400_000);
		expect(writes[0].args[3]).toBe(400_000);
	});
});

describe("markExhausted", () => {
	it("is a distinct status from failure, and records why + how deep", async () => {
		// A human must be able to tell a runaway that was STOPPED from a subordinate that broke,
		// and resume the former after raising the limit.
		const { env, writes } = buildEnv();
		await markExhausted(env, "u1", "b1", "cost_exhausted", 3);
		const sql = writes[0].sql.replace(/\s+/g, " ");
		expect(sql).toContain("status = 'exhausted'");
		expect(sql).toContain("status = 'open'"); // only an open pool becomes exhausted
		expect(writes[0].args[2]).toBe("cost_exhausted");
		expect(writes[0].args[3]).toBe(3);
	});
});

describe("raiseBudget — the one place a budget goes UP", () => {
	it("adds headroom and re-opens the pool", async () => {
		const { env, writes } = buildEnv({ changes: 1 });
		expect(await raiseBudget(env, "u1", "b1", 5_000_000, 10)).toBe(true);
		const sql = writes[0].sql.replace(/\s+/g, " ");
		expect(sql).toContain("cost_micros_limit = cost_micros_limit + ?3");
		expect(sql).toContain("status = 'open'");
		expect(sql).toContain("exhausted_reason = NULL");
	});

	it("reports false when nothing was raised", async () => {
		const { env } = buildEnv({ changes: 0 });
		expect(await raiseBudget(env, "u1", "b1", 1)).toBe(false);
	});
});

// `closeBudget` has been deleted (#594 AC4): it was dead vocabulary with no production caller.
// Its test is deleted with it. The decision is recorded in `status-domain.ts`.

/** Env with an ai_usage history, for the derived-default path. */
function envWithHistory(costs: number[]) {
	const inserts: Write[] = [];
	const env = {
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async first() {
								return {
									id: "b1", user_id: "u1", root_instance_id: "i1",
									cost_micros_limit: Number(args[3] ?? 0),
									cost_micros_reserved: 0, cost_micros_spent: 0,
									delegations_limit: 50, delegations_used: 0, max_depth: 4,
									status: "open", exhausted_reason: null, exhausted_at_depth: null,
									created_at: "", updated_at: "",
								};
							},
							async all() {
								return sql.includes("FROM ai_usage")
									? { results: costs.map((c) => ({ cost_micros: c })) }
									: { results: [] };
							},
							async run() {
								inserts.push({ sql, args });
								return { meta: { changes: 1 } };
							},
						};
					},
				};
			},
		},
	} as unknown as Env;
	return { env, inserts };
}

describe("openBudget — defaults derived from the ledger, not guessed", () => {
	it("sizes the pool from this user's real spend when there is enough history", async () => {
		// A guessed ceiling is how a safety feature becomes an obstacle. 40 runs at 1M micros
		// ($1) each => p95 of 1M, times the headroom, well above the $5 placeholder.
		const { env, inserts } = envWithHistory(Array(40).fill(1_000_000));
		await openBudget(env, "u1", "i1");
		const limit = Number(inserts[0].args[3]);
		expect(limit).toBe(1_000_000 * 25);
		expect(limit).toBeGreaterThan(5_000_000); // not clamped back to the static default
	});

	it("keeps the static default when history is too thin to be meaningful", async () => {
		// A percentile from three rows is noise; a new account must still be bounded.
		const { env, inserts } = envWithHistory([1_000_000, 2_000_000, 3_000_000]);
		await openBudget(env, "u1", "i1");
		expect(Number(inserts[0].args[3])).toBe(DEFAULT_LIMITS.costMicros);
	});

	it("never derives BELOW the static default", async () => {
		// Cheap history must not shrink the floor into something that interrupts real work.
		const { env, inserts } = envWithHistory(Array(40).fill(100));
		await openBudget(env, "u1", "i1");
		expect(Number(inserts[0].args[3])).toBe(DEFAULT_LIMITS.costMicros);
	});

	it("still clamps an explicit request — to the measured ceiling, not a guess", async () => {
		const { env, inserts } = envWithHistory(Array(40).fill(1_000_000));
		await openBudget(env, "u1", "i1", { costMicros: 999_000_000 });
		expect(Number(inserts[0].args[3])).toBe(1_000_000 * 25);
	});

	it("honours a SMALLER explicit request", async () => {
		const { env, inserts } = envWithHistory(Array(40).fill(1_000_000));
		await openBudget(env, "u1", "i1", { costMicros: 250_000 });
		expect(Number(inserts[0].args[3])).toBe(250_000);
	});
});

describe("the account backstop — what a per-tree pool cannot see", () => {
	/** Env whose ai_usage rolling-window read returns `chargedMicros` and `tokens`. */
	function envSpent(chargedMicros: number, tokens = 0) {
		const writes: Write[] = [];
		const env = {
			// The account circuit breakers only BLOCK when enforcement is on (#485); these tests
			// exercise the breaker logic itself, so they opt in. The observe-only default is covered
			// by its own test below.
			BUDGET_ENFORCE: "1",
			DB: {
				prepare(sql: string) {
					return {
						bind() {
							return {
								async first() {
									if (sql.includes("FROM ai_usage")) return { charged_micros: chargedMicros, tokens };
									return openRow({ cost_micros_spent: 0 });
								},
								async all() { return { results: [] }; },
								async run() { writes.push({ sql, args: [] }); return { meta: { changes: 1 } }; },
							};
						},
					};
				},
			},
		} as unknown as Env;
		return { env, writes };
	}

	it("refuses a NEW draw once the account has run up its daily CHARGED spend", async () => {
		// A thousand small trees each stay inside their own pool while the bill grows; the
		// per-tree budget is blind to the account, so this is the only thing that catches it.
		const { env, writes } = envSpent(DAILY_CEILING_MICROS);
		const r = await reserve(env, "u1", "b1", { depth: 1, estimatedCostMicros: 1 });
		expect(r.ok).toBe(false);
		// The refusal must name what was counted and over what window (#343). "The $50 daily limit
		// has been hit" sent the user to a provider dashboard that showed nothing for that day.
		expect(r.message).toMatch(/charged/i);
		expect(r.message).toMatch(/24h/);
		expect(r.message).toMatch(/\$50\.00/);
		// Refused at ADMISSION — the pool is never touched.
		expect(writes.filter((w) => w.sql.includes("UPDATE delegation_budgets"))).toHaveLength(0);
	});

	it("admits normally while the account is under the ceiling", async () => {
		const { env } = envSpent(1_000_000);
		expect((await reserve(env, "u1", "b1", { depth: 1, estimatedCostMicros: 1 })).ok).toBe(true);
	});

	it("does NOT refuse over a mountain of tokens that cost nobody money", async () => {
		// #343 itself. 500M tokens of engine work on a Claude subscription is a huge amount of
		// notional list-price value and zero dollars. The old breaker summed the value and blocked
		// hours of queued work over a bill that did not exist. Under the token ceiling, so it runs.
		const { env } = envSpent(0, 200_000_000);
		expect((await reserve(env, "u1", "b1", { depth: 1, estimatedCostMicros: 1 })).ok).toBe(true);
	});

	it("still bounds that work — in tokens, which is the unit it consumes", async () => {
		// Removing the money ceiling from non-money must not leave it unbounded. The subscription
		// allowance it draws on is itself a rolling token window, so this is the matching unit.
		const { env } = envSpent(0, DAILY_TOKEN_CEILING);
		const r = await reserve(env, "u1", "b1", { depth: 1, estimatedCostMicros: 1 });
		expect(r.ok).toBe(false);
		expect(r.message).toMatch(/tokens/i);
		expect(r.message).not.toMatch(/\$/); // a token limit is never quoted in dollars
	});

	it("observe-only by default (#485): a run OVER a ceiling is still admitted when BUDGET_ENFORCE is unset", async () => {
		// The breakers are demoted to observe-only until paid launch — usage is measured against the
		// ceiling but a run is never stopped. Same over-ceiling fixture as above, minus the opt-in flag.
		const { env: enforced } = envSpent(DAILY_CEILING_MICROS);
		const observeOnly = { ...(enforced as unknown as Record<string, unknown>), BUDGET_ENFORCE: undefined } as unknown as Env;
		expect((await reserve(observeOnly, "u1", "b1", { depth: 1, estimatedCostMicros: 1 })).ok).toBe(true);
		const { env: tokensEnforced } = envSpent(0, DAILY_TOKEN_CEILING);
		const tokensObserve = { ...(tokensEnforced as unknown as Record<string, unknown>), BUDGET_ENFORCE: undefined } as unknown as Env;
		expect((await reserve(tokensObserve, "u1", "b1", { depth: 1, estimatedCostMicros: 1 })).ok).toBe(true);
	});

	it("reports BOTH ceilings as account_ceiling, not as the pool being spent", async () => {
		// The workflows key off this reason to keep the SHARED tree pool open for a transient
		// account-level fact. A second reason string would silently lose them that, and they would
		// markExhausted a pool with headroom left — the regression the reason code was added to fix.
		expect((await reserve(envSpent(DAILY_CEILING_MICROS).env, "u1", "b1", { depth: 1, estimatedCostMicros: 1 })).reason).toBe("account_ceiling");
		expect((await reserve(envSpent(0, DAILY_TOKEN_CEILING).env, "u1", "b1", { depth: 1, estimatedCostMicros: 1 })).reason).toBe("account_ceiling");
	});

	it("fails OPEN when the ledger read breaks", async () => {
		// A transient D1 blip must not freeze every agent — the per-tree pool still bounds work.
		const env = {
			DB: {
				prepare(sql: string) {
					return {
						bind() {
							return {
								async first() {
									if (sql.includes("FROM ai_usage")) throw new Error("D1 down");
									return openRow({ cost_micros_spent: 0 });
								},
								async all() { return { results: [] }; },
								async run() { return { meta: { changes: 1 } }; },
							};
						},
					};
				},
			},
		} as unknown as Env;
		expect((await reserve(env, "u1", "b1", { depth: 1, estimatedCostMicros: 1 })).ok).toBe(true);
	});
});

// ── resolveAccountCeilings ────────────────────────────────────────────────────────────────────

/** Build a minimal env whose account_budget_limits table returns the given rows. */
function envWithLimitRows(
	rows: Array<{ user_id: string } & Partial<{
		token_ceiling: number | null;
		charged_micros_ceiling: number | null;
		per_tree_cost_micros: number | null;
		delegations: number | null;
		max_depth: number | null;
	}>>,
	envVars: Partial<Pick<Env, "ACCOUNT_DAILY_CHARGED_MICROS_CEILING" | "ACCOUNT_DAILY_TOKEN_CEILING">> = {},
	throws = false,
): Env {
	return {
		...envVars,
		DB: {
			prepare() {
				return {
					bind() {
						return {
							async all() {
								if (throws) throw new Error("D1 down");
								return { results: rows };
							},
						};
					},
				};
			},
		},
	} as unknown as Env;
}

describe("resolveAccountCeilings — four-tier precedence", () => {
	it("falls through to hard constants when the table is empty", async () => {
		const c = await resolveAccountCeilings(envWithLimitRows([]), "u1");
		expect(c.chargedMicrosCeiling).toBe(DAILY_CEILING_MICROS);
		expect(c.tokenCeiling).toBe(DAILY_TOKEN_CEILING);
		expect(c.perTreeCostMicros).toBe(DEFAULT_LIMITS.costMicros);
		expect(c.perTreeDelegations).toBe(DEFAULT_LIMITS.delegations);
		expect(c.perTreeMaxDepth).toBe(DEFAULT_LIMITS.maxDepth);
	});

	it("uses the env var at tier 3, above the hard constant", async () => {
		const c = await resolveAccountCeilings(
			envWithLimitRows([], { ACCOUNT_DAILY_CHARGED_MICROS_CEILING: "75000000", ACCOUNT_DAILY_TOKEN_CEILING: "300000000" }),
			"u1",
		);
		expect(c.chargedMicrosCeiling).toBe(75_000_000);
		expect(c.tokenCeiling).toBe(300_000_000);
	});

	it("platform-default row overrides the env var (tier 2 > tier 3)", async () => {
		const c = await resolveAccountCeilings(
			envWithLimitRows(
				[{ user_id: "__platform__", charged_micros_ceiling: 100_000_000, token_ceiling: 500_000_000 }],
				{ ACCOUNT_DAILY_CHARGED_MICROS_CEILING: "75000000" },
			),
			"u1",
		);
		expect(c.chargedMicrosCeiling).toBe(100_000_000);
		expect(c.tokenCeiling).toBe(500_000_000);
	});

	it("per-account row overrides the platform default (tier 1 > tier 2)", async () => {
		const c = await resolveAccountCeilings(
			envWithLimitRows([
				{ user_id: "__platform__", charged_micros_ceiling: 100_000_000 },
				{ user_id: "u1", charged_micros_ceiling: 200_000_000 },
			]),
			"u1",
		);
		expect(c.chargedMicrosCeiling).toBe(200_000_000);
	});

	it("a NULL in a per-account row falls through to the next tier for that field", async () => {
		// Per-account overrides token ceiling only; money ceiling comes from platform default.
		const c = await resolveAccountCeilings(
			envWithLimitRows([
				{ user_id: "__platform__", charged_micros_ceiling: 80_000_000, token_ceiling: null },
				{ user_id: "u1", charged_micros_ceiling: null, token_ceiling: 400_000_000 },
			]),
			"u1",
		);
		expect(c.chargedMicrosCeiling).toBe(80_000_000); // from platform row
		expect(c.tokenCeiling).toBe(400_000_000);        // from per-account row
	});

	it("clamps an override to the maximum sane value", async () => {
		const c = await resolveAccountCeilings(
			envWithLimitRows([{ user_id: "u1", charged_micros_ceiling: 999_999_999_999_999 }]),
			"u1",
		);
		// $10 000 / 24h cap
		expect(c.chargedMicrosCeiling).toBe(10_000_000_000);
	});

	it("fails open on a D1 error, falling back to the hard constant", async () => {
		const c = await resolveAccountCeilings(envWithLimitRows([], {}, true), "u1");
		expect(c.chargedMicrosCeiling).toBe(DAILY_CEILING_MICROS);
		expect(c.tokenCeiling).toBe(DAILY_TOKEN_CEILING);
	});

	it("reserve() reads the effective ceiling rather than the bare constant", async () => {
		// Use envSpent to build an env with $60 of charged spend (above the $50 hard constant),
		// but override the platform ceiling to $100 via env var.
		// reserve() should be ADMITTED, not refused.
		const env = {
			ACCOUNT_DAILY_CHARGED_MICROS_CEILING: "100000000", // $100
			DB: {
				prepare(sql: string) {
					return {
						bind() {
							return {
								async first() {
									if (sql.includes("FROM ai_usage")) return { charged_micros: 60_000_000, tokens: 0 };
									return openRow({ cost_micros_spent: 0 });
								},
								async all() { return { results: [] }; },
								async run() { return { meta: { changes: 1 } }; },
							};
						},
					};
				},
			},
		} as unknown as Env;
		const r = await reserve(env, "u1", "b1", { depth: 1, estimatedCostMicros: 1 });
		// $60 < $100 ceiling → should be admitted
		expect(r.ok).toBe(true);
	});
});
