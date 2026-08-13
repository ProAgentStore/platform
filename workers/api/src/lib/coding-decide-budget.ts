/**
 * The Pilot's spend gate around ONE `decide` call (#159).
 *
 * The LLM call is the only place the coding loop spends money, so it is the only place the budget
 * has to sit. Delegated runs reached the Pilot with a pool id and never drew on it — unbounded
 * spend on exactly the path a supervisor can trigger with nobody watching.
 *
 * EXTRACTED from `workflows/coding-session.ts` (#546), which sits on an 800-line ratchet, and which
 * this was only ever inlined into because it wraps a `step.do` callback. It does not need the
 * Workflow: it needs an account, an instance, a pool and the call to wrap. Kept whole rather than
 * split into reserve/settle halves, because the `finally` below is the reason it is correct.
 */
import { markExhausted, reserve, settle } from "./delegation-budget-store.js";
import { instanceSpendMicros } from "./usage.js";
import type { Env } from "../types.js";

/** Bounded worst case for one Pilot decide step, in USD micros. Settle refunds the rest. */
export const CODING_RESERVE_MICROS = 150_000; // $0.15

/** The shape the coding loop reads back — a terminal decision, or whatever `decide` returned. */
type Decided<T> = T | { finish: { status: "failed"; detail: string } };

export async function decideWithinBudget<T>(
	env: Env,
	scope: { userId: string; instanceId: string; budgetId?: string | null; depth?: number },
	decide: () => Promise<T>,
): Promise<Decided<T>> {
	const { userId, instanceId } = scope;
	const budgetId = scope.budgetId ?? null;
	if (!budgetId) return decide();

	const depth = scope.depth ?? 0;
	const draw = await reserve(env, userId, budgetId, { depth, estimatedCostMicros: CODING_RESERVE_MICROS });
	if (!draw.ok) {
		// `account_ceiling` is the ACCOUNT's rolling 24h backstop tripping, not this tree's pool
		// being spent. Closing the shared budget for it stops every sibling drawing on the same pool
		// and survives the window rolling off.
		if (draw.reason && draw.reason !== "not_found" && draw.reason !== "closed" && draw.reason !== "account_ceiling") {
			await markExhausted(env, userId, budgetId, draw.reason, depth).catch(() => undefined);
		}
		// A clean terminal decision rather than a throw: the loop stops with a reason the human can
		// read on the board, and the session is left intact to resume.
		return { finish: { status: "failed" as const, detail: draw.message ?? "This run hit its spend limit." } };
	}
	const before = await instanceSpendMicros(env, userId, instanceId);
	try {
		return await decide();
	} finally {
		// Settled in `finally` so a throwing decide still charges what it burned — otherwise a
		// failing loop would run free. The read may itself fail, and a `finally` must not throw (it
		// would replace the decide's real error), so an unreadable ledger charges the whole
		// reservation: over-charging stops a run early, under-charging lets a runaway continue.
		const after = await instanceSpendMicros(env, userId, instanceId).catch(() => before + (draw.reserved ?? CODING_RESERVE_MICROS));
		await settle(env, userId, budgetId, draw.reserved ?? CODING_RESERVE_MICROS, Math.max(0, after - before)).catch(() => undefined);
	}
}
