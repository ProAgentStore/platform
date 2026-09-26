/**
 * A ticket's own budget (#865, #757 §3): one delegation pool per ticket, drawn on by every run
 * started for it.
 *
 * Before this, spend was bounded per ACCOUNT (the rolling-24h backstop in `reserve()`) and per
 * delegation TREE (`delegation-budget-store.ts`), and the queue opened a fresh tree per run — so a
 * ticket that kept failing and being re-queued got a new allowance every time, and nothing bounded
 * the ticket as a unit of work. Now the ticket owns a pool (`tickets.budget_id`, migration 0163):
 *
 *   - Cumulative: every run for the ticket draws on the same pool, so its spend is the ticket's.
 *   - Concurrency-safe: draws go through `reserve()`'s atomic UPDATE, whose WHERE clause carries the
 *     affordability test, so two runs of one ticket cannot overbook it. Opening the pool is a
 *     conditional bind (`WHERE budget_id IS NULL`), so two concurrent starts end up on ONE pool.
 *   - Parks on its own limit: a run that cannot draw stops with reason `budget`, and the workflow's
 *     existing `markExhausted` closes the pool — the ticket stops without reaching the account's
 *     ceiling, and the queue will not pick an exhausted ticket again.
 *   - Resumes only by a person: `raiseTicketBudget` is the human path `raiseBudget` was written for
 *     (#594) — owner-scoped, bounded, audited — and it keeps what was already spent on the record.
 */
import { formatMicros } from "./delegation-budget.js";
import { type BudgetView, getBudget, openBudget, raiseBudget, resolveAccountCeilings } from "./delegation-budget-store.js";
import { logEvent } from "./events.js";
import { appendTicketProgress, dollars } from "./ticket-progress.js";
import type { Env } from "../types.js";

export interface TicketBudgetView {
	budgetId: string | null;
	/** The owner's allowance, or null for the account's per-tree default. */
	allowanceMicros: number | null;
	limitMicros: number | null;
	spentMicros: number;
	reservedMicros: number;
	remainingMicros: number | null;
	status: "unopened" | "open" | "exhausted";
	exhaustedReason: string | null;
}

interface TicketBudgetRow {
	budget_id: string | null;
	budget_limit_micros: number | null;
}

async function ticketRow(env: Env, instanceId: string, userId: string, ticketId: string): Promise<TicketBudgetRow | null> {
	return env.DB.prepare("SELECT budget_id, budget_limit_micros FROM tickets WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3")
		.bind(ticketId, instanceId, userId)
		.first<TicketBudgetRow>();
}

function view(row: TicketBudgetRow, pool: BudgetView | null): TicketBudgetView {
	if (!pool) {
		return { budgetId: null, allowanceMicros: row.budget_limit_micros, limitMicros: null, spentMicros: 0, reservedMicros: 0, remainingMicros: null, status: "unopened", exhaustedReason: null };
	}
	return {
		budgetId: pool.id,
		allowanceMicros: row.budget_limit_micros,
		limitMicros: pool.costMicrosLimit,
		spentMicros: pool.costMicrosSpent,
		reservedMicros: pool.costMicrosReserved,
		remainingMicros: Math.max(0, pool.costMicrosLimit - pool.costMicrosSpent - pool.costMicrosReserved),
		status: pool.status,
		exhaustedReason: pool.exhaustedReason,
	};
}

/** The ticket's budget as its owner sees it, or null when the ticket is not theirs. */
export async function ticketBudgetView(env: Env, instanceId: string, userId: string, ticketId: string): Promise<TicketBudgetView | null> {
	const row = await ticketRow(env, instanceId, userId, ticketId);
	if (!row) return null;
	const pool = row.budget_id ? await getBudget(env, userId, row.budget_id) : null;
	return view(row, pool);
}

/**
 * The ticket's pool, opening it on first use. Two concurrent first uses both open a pool, but only
 * ONE is bound (`WHERE budget_id IS NULL`); the loser uses the winner's, so every run of the ticket
 * draws on the same pool. The loser's pool is left with nothing drawn against it.
 */
export async function ensureTicketBudget(env: Env, instanceId: string, userId: string, ticketId: string): Promise<BudgetView> {
	const row = await ticketRow(env, instanceId, userId, ticketId);
	if (!row) throw new Error("Ticket not found");
	if (row.budget_id) {
		const pool = await getBudget(env, userId, row.budget_id);
		if (pool) return pool;
	}
	const opened = await openBudget(env, userId, instanceId, row.budget_limit_micros ? { costMicros: row.budget_limit_micros } : undefined);
	const bound = await env.DB.prepare(
		"UPDATE tickets SET budget_id = ?4, updated_at = datetime('now') WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3 AND (budget_id IS NULL OR budget_id = ?5)",
	)
		.bind(ticketId, instanceId, userId, opened.id, row.budget_id ?? "")
		.run();
	if ((bound.meta?.changes ?? 0) > 0) return opened;
	const winner = await ticketRow(env, instanceId, userId, ticketId);
	const pool = winner?.budget_id ? await getBudget(env, userId, winner.budget_id) : null;
	if (!pool) throw new Error("Ticket budget could not be bound");
	return pool;
}

export type RaiseResult = { ok: true; view: TicketBudgetView } | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * Set a ticket's allowance — the one way a ticket's budget goes UP, and a human action only.
 *
 * Before the ticket's first run it just records the allowance. After, it raises the pool to the new
 * limit and RE-OPENS it if it was exhausted (`raiseBudget`), keeping what was spent: that is the
 * resume. Lowering an opened pool is refused — money already reserved or spent cannot be un-spent,
 * and a limit under it would read as a pool with negative room. One raise may add at most the
 * account's per-tree ceiling, so a mistyped figure cannot open an unbounded pool. Audited.
 */
export async function raiseTicketBudget(env: Env, instanceId: string, userId: string, ticketId: string, limitMicros: number): Promise<RaiseResult> {
	const target = Math.floor(limitMicros);
	if (!Number.isFinite(target) || target <= 0) return { ok: false, status: 400, error: "limitMicros must be a positive number of micro-dollars" };
	const row = await ticketRow(env, instanceId, userId, ticketId);
	if (!row) return { ok: false, status: 404, error: "Ticket not found" };
	const ceilings = await resolveAccountCeilings(env, userId);
	const pool = row.budget_id ? await getBudget(env, userId, row.budget_id) : null;

	const current = pool ? pool.costMicrosLimit : 0;
	const extra = target - current;
	if (pool && extra < 0) {
		return { ok: false, status: 409, error: `This ticket's budget is ${formatMicros(current)} and ${formatMicros(pool.costMicrosSpent + pool.costMicrosReserved)} of it is spent or held — it can be raised, not lowered.` };
	}
	if (extra > ceilings.perTreeCostMicros) {
		return { ok: false, status: 400, error: `One raise may add at most ${formatMicros(ceilings.perTreeCostMicros)} (your per-run ceiling); raise again for more.` };
	}

	await env.DB.prepare("UPDATE tickets SET budget_limit_micros = ?4, updated_at = datetime('now') WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3")
		.bind(ticketId, instanceId, userId, target)
		.run();
	const wasExhausted = pool?.status === "exhausted";
	// Every step's `reserve()` also spends one delegation from the pool, and a ticket's pool spans all
	// its runs — so it can stop on the step count as surely as on money. A resume restores a full
	// per-run allowance of steps on top of what was used, or the re-opened pool would refuse its
	// first draw on the count it just ran out of.
	const extraSteps = pool && wasExhausted ? Math.max(0, pool.delegationsUsed + ceilings.perTreeDelegations - pool.delegationsLimit) : 0;
	if (pool && (extra > 0 || wasExhausted)) await raiseBudget(env, userId, pool.id, extra, extraSteps);

	await logEvent(env, {
		source: "ticket",
		event: "ticket.budget_raised",
		userId,
		instanceId,
		message: `ticket ${ticketId} budget set to ${formatMicros(target)}${wasExhausted ? " — re-opened after exhaustion" : ""}`,
		context: { ticketId, budgetId: pool?.id ?? null, from: pool ? current : row.budget_limit_micros, to: target, reopened: wasExhausted },
	});
	if (wasExhausted) {
		await appendTicketProgress(env, {
			ticketId,
			instanceId,
			userId,
			runId: null,
			kind: "resumed",
			body: `Budget raised to ${dollars(target)} by the owner (${dollars(pool?.costMicrosSpent ?? 0)} already spent) — the ticket can run again.`,
		});
	}
	const after = await ticketBudgetView(env, instanceId, userId, ticketId);
	return { ok: true, view: after as TicketBudgetView };
}
