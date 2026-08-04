// The delegation budget in D1 (#184, migration 0061). The arithmetic lives in the pure
// `delegation-budget.ts`; this module is the persistence, and specifically the ATOMIC draw.
//
// The atomicity is the whole correctness argument. Two sibling delegations running concurrently
// must not both pass an admission check against the same pool and then both spend — so the
// reservation is a single UPDATE whose WHERE clause carries the affordability test. Whoever
// D1 applies second sees the first one's reservation already subtracted and matches zero rows.
// A read-then-write would race; this cannot.

import type { Env } from "../types.js";
import {
	canAdmit,
	sanitizeLimits,
	type AdmissionRefusal,
	type BudgetLimits,
	type BudgetState,
	type Micros,
} from "./delegation-budget.js";

interface BudgetRow {
	id: string;
	user_id: string;
	root_instance_id: string;
	cost_micros_limit: number;
	cost_micros_reserved: number;
	cost_micros_spent: number;
	delegations_limit: number;
	delegations_used: number;
	max_depth: number;
	status: string;
	exhausted_reason: string | null;
	exhausted_at_depth: number | null;
	created_at: string;
	updated_at: string;
}

export interface BudgetView extends BudgetState {
	id: string;
	rootInstanceId: string;
	status: "open" | "exhausted" | "closed";
	exhaustedReason: AdmissionRefusal | null;
	exhaustedAtDepth: number | null;
	createdAt: string;
	updatedAt: string;
}

function toView(row: BudgetRow): BudgetView {
	return {
		id: row.id,
		rootInstanceId: row.root_instance_id,
		costMicrosLimit: row.cost_micros_limit,
		costMicrosReserved: row.cost_micros_reserved,
		costMicrosSpent: row.cost_micros_spent,
		delegationsLimit: row.delegations_limit,
		delegationsUsed: row.delegations_used,
		maxDepth: row.max_depth,
		status: (row.status === "exhausted" || row.status === "closed" ? row.status : "open"),
		exhaustedReason: (row.exhausted_reason as AdmissionRefusal | null) ?? null,
		exhaustedAtDepth: row.exhausted_at_depth,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/** Open a pool for a new delegation tree. Limits are clamped to the ceiling, so an agent asking
 *  for more than the default gets the default — raising a budget is a human action. */
export async function openBudget(
	env: Env,
	userId: string,
	rootInstanceId: string,
	requested?: Partial<BudgetLimits>,
): Promise<BudgetView> {
	const limits = sanitizeLimits(requested);
	const id = crypto.randomUUID();
	await env.DB.prepare(
		`INSERT INTO delegation_budgets
		   (id, user_id, root_instance_id, cost_micros_limit, delegations_limit, max_depth, status, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', datetime('now'), datetime('now'))`,
	)
		.bind(id, userId, rootInstanceId, limits.costMicros, limits.delegations, limits.maxDepth)
		.run();
	const row = await env.DB.prepare("SELECT * FROM delegation_budgets WHERE id = ?1").bind(id).first<BudgetRow>();
	return toView(row as BudgetRow);
}

export async function getBudget(env: Env, userId: string, id: string): Promise<BudgetView | null> {
	const row = await env.DB.prepare("SELECT * FROM delegation_budgets WHERE id = ?1 AND user_id = ?2")
		.bind(id, userId)
		.first<BudgetRow>();
	return row ? toView(row) : null;
}

export interface ReservationResult {
	ok: boolean;
	reason?: AdmissionRefusal | "not_found" | "closed";
	message?: string;
	/** Pass back to `settle` so the exact held amount is released. */
	reserved?: Micros;
}

/**
 * Reserve headroom for one step, atomically.
 *
 * Two guards, deliberately in different places:
 *  • depth and the delegation count are checked in SQL as part of the same UPDATE, so a
 *    concurrent sibling cannot slip past the count;
 *  • affordability is the `(limit - reserved - spent) >= need` term in the WHERE clause, which
 *    is what makes concurrent reservations serialize instead of overbooking.
 *
 * A zero-row update means someone else got there first — re-read to say WHY, rather than
 * reporting a generic failure for what is usually "the pool is spent".
 */
export async function reserve(
	env: Env,
	userId: string,
	budgetId: string,
	opts: { depth: number; estimatedCostMicros: Micros },
): Promise<ReservationResult> {
	const need = Math.max(0, Math.floor(opts.estimatedCostMicros));
	const res = await env.DB.prepare(
		`UPDATE delegation_budgets
		    SET cost_micros_reserved = cost_micros_reserved + ?3,
		        delegations_used     = delegations_used + 1,
		        updated_at           = datetime('now')
		  WHERE id = ?1
		    AND user_id = ?2
		    AND status = 'open'
		    AND ?4 <= max_depth
		    AND delegations_used < delegations_limit
		    AND (cost_micros_limit - cost_micros_reserved - cost_micros_spent) >= ?3`,
	)
		.bind(budgetId, userId, need, Math.max(0, Math.floor(opts.depth)))
		.run();

	if ((res.meta?.changes ?? 0) > 0) return { ok: true, reserved: need };

	// Refused. Re-read so the human is told which limit stopped them — "budget exhausted at
	// depth 3" is actionable; a bare failure is not.
	const current = await getBudget(env, userId, budgetId);
	if (!current) return { ok: false, reason: "not_found", message: "That delegation budget no longer exists." };
	if (current.status !== "open") return { ok: false, reason: "closed", message: "This run's budget is already closed." };
	const verdict = canAdmit(current, opts);
	return {
		ok: false,
		reason: verdict.reason ?? "cost_exhausted",
		message: verdict.message ?? "This run hit its budget.",
	};
}

/**
 * Settle a reservation with the actual cost.
 *
 * Releases exactly what was held and charges what was really spent — so an underspend gives
 * change back to the tree instead of silently shrinking it, and an overspend is charged in full
 * because the money is already gone and a pool that hides it would lie. Clamped at zero so a
 * duplicate settle cannot drive the reservation negative and hand out free headroom.
 */
export async function settle(
	env: Env,
	userId: string,
	budgetId: string,
	reserved: Micros,
	actual: Micros,
): Promise<void> {
	const held = Math.max(0, Math.floor(reserved));
	const spent = Math.max(0, Math.floor(actual));
	await env.DB.prepare(
		`UPDATE delegation_budgets
		    SET cost_micros_reserved = MAX(0, cost_micros_reserved - ?3),
		        cost_micros_spent    = cost_micros_spent + ?4,
		        updated_at           = datetime('now')
		  WHERE id = ?1 AND user_id = ?2`,
	)
		.bind(budgetId, userId, held, spent)
		.run();
}

/**
 * Record that the tree stopped because it ran out, and why.
 *
 * A distinct status from a failure: the work is intact and resumable once a human raises the
 * limit. Exhaustion must never destroy what was already paid for.
 */
export async function markExhausted(
	env: Env,
	userId: string,
	budgetId: string,
	reason: AdmissionRefusal,
	atDepth: number,
): Promise<void> {
	await env.DB.prepare(
		`UPDATE delegation_budgets
		    SET status = 'exhausted', exhausted_reason = ?3, exhausted_at_depth = ?4, updated_at = datetime('now')
		  WHERE id = ?1 AND user_id = ?2 AND status = 'open'`,
	)
		.bind(budgetId, userId, reason, Math.max(0, Math.floor(atDepth)))
		.run();
}

/**
 * Raise an exhausted pool and re-open it — the "continue (+$5)" action.
 *
 * Only a human path may call this: it is the one place a budget goes UP, which is exactly why
 * agents draw through `reserve` and never touch limits.
 */
export async function raiseBudget(
	env: Env,
	userId: string,
	budgetId: string,
	extraCostMicros: Micros,
	extraDelegations = 0,
): Promise<boolean> {
	const res = await env.DB.prepare(
		`UPDATE delegation_budgets
		    SET cost_micros_limit = cost_micros_limit + ?3,
		        delegations_limit = delegations_limit + ?4,
		        status = 'open', exhausted_reason = NULL, exhausted_at_depth = NULL,
		        updated_at = datetime('now')
		  WHERE id = ?1 AND user_id = ?2 AND status != 'closed'`,
	)
		.bind(budgetId, userId, Math.max(0, Math.floor(extraCostMicros)), Math.max(0, Math.floor(extraDelegations)))
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

/** Close a finished tree so late work cannot draw against it. */
export async function closeBudget(env: Env, userId: string, budgetId: string): Promise<void> {
	await env.DB.prepare(
		"UPDATE delegation_budgets SET status = 'closed', updated_at = datetime('now') WHERE id = ?1 AND user_id = ?2",
	)
		.bind(budgetId, userId)
		.run();
}
