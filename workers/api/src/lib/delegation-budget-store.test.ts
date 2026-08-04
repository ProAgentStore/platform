import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "./delegation-budget.js";
import {
	closeBudget,
	openBudget,
	markExhausted,
	raiseBudget,
	reserve,
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

	it("refuses to draw against a closed pool", async () => {
		const { env } = buildEnv({ changes: 0, row: openRow({ status: "closed", cost_micros_spent: 0 }) });
		expect((await reserve(env, "u1", "b1", { depth: 1, estimatedCostMicros: 1 })).reason).toBe("closed");
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

	it("will not resurrect a closed tree", async () => {
		const { env, writes } = buildEnv({ changes: 1 });
		await raiseBudget(env, "u1", "b1", 1);
		expect(writes[0].sql).toContain("status != 'closed'");
	});

	it("reports false when nothing was raised", async () => {
		const { env } = buildEnv({ changes: 0 });
		expect(await raiseBudget(env, "u1", "b1", 1)).toBe(false);
	});
});

describe("closeBudget", () => {
	it("stops late work drawing against a finished tree", async () => {
		const { env, writes } = buildEnv();
		await closeBudget(env, "u1", "b1");
		expect(writes[0].sql).toContain("status = 'closed'");
	});
});

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
