/**
 * The apply brain's spend gate around ONE `decide` call (#516).
 *
 * `JobApplyWorkflow` was the last autonomous workflow with no pool: `grep -c budget
 * workflows/job-apply.ts` returned 0, so `reserve()` had two callers and neither was the apply
 * path. That is not the same gap as an unmetered path — apply spend has ALWAYS been recorded
 * (`decideAction` → `user-ai.ts` → `recordUsage`, `kind: "apply"`). What was missing is the pool:
 * a run with no `delegation_budgets` row has nothing that reserves, nothing that settles, no
 * account ceiling consulted, and — the consequence that matters — no row anyone can act on when an
 * application wedges on a captcha handoff, an unanswered `needs_input`, or an ATS that never
 * settles.
 *
 * Modelled on `coding-decide-budget.ts` (the Pilot's gate), for the same reason it gives: the LLM
 * call is the only place this loop spends money, so it is the only place the budget has to sit.
 * Kept whole rather than split into reserve/settle halves, because the `finally` below is the
 * reason it is correct.
 *
 * ── Why the settle delta is real HERE, and near-inert on the coding side
 *
 * `instanceSpendMicros` filters to `CHARGED_SQL` (`usage.ts:609`) deliberately: a pool is
 * denominated in dollars, so a subscription engine's large NOTIONAL value must not draw it down.
 * For apply that filter costs nothing — `recordUsage` hardcodes `payer='byok-api'` (`usage.ts:97`)
 * and every apply row goes through it, so the before/after delta is the real charge. Do NOT read
 * the coding gate and conclude the two behave alike: measured on the dogfood account 2026-08-13,
 * all 449 `kind:engine` rows carry `payer: unknown`, so the coding pool's settle sees almost none
 * of that consumption. Same mechanism, opposite outcome, because of who the payer is.
 *
 * ── Why the reservation cannot outlive the step
 *
 * Reserve and settle sit in ONE `step.do` callback joined by a `try/finally`, rather than in
 * separate durable steps the way `workflows/agent-loop.ts` has them. That shape is what makes the
 * leak in `50e56ed` structurally impossible here: a step that exhausts its retries aborts the whole
 * Workflow instance, and a settle written as a LATER step is the thing that gets skipped when it
 * does. Every attempt of this step settles its own draw before the throw leaves the callback, and
 * the pauses that actually strand an apply run — the captcha / stuck / needs_input handoffs, up to
 * 15 minutes of `step.sleep` each — all happen after `runApplyLoop` has returned, with nothing
 * held. The one leak left is an isolate death BETWEEN the reserve and the settle, which costs a
 * single reservation against this run's own pool: bounded, and it cannot starve anyone else,
 * because `startJobApply` opens the pool per application.
 *
 * ── What the pool actually bounds, so nobody is surprised by it
 *
 * Every `reserve()` increments `delegations_used`, and `settle` does not give it back (it refunds
 * money, not admissions). At the default per-tree ceiling that is 50 draws (`DEFAULT_LIMITS`,
 * `delegation-budget.ts:40`), while the apply loop is structurally bounded at 12 rounds × 60 steps.
 * So for a long application the POOL, not `maxSteps`, becomes the effective bound — at 50 model
 * decisions the run ends `blocked` with a readable reason instead of continuing. That is the
 * intended trade for a path that otherwise spends unattended BYOK tokens with nothing able to stop
 * it, and it is adjustable without a deploy: an operator raises `delegations` per account in
 * `account_budget_limits` (#474). Structural caps apply even though enforcement is observe-only
 * (`BUDGET_ENFORCE` off, #485) — only the two ACCOUNT ceilings are switched off, not the pool.
 */
import { markExhausted, reserve, settle } from "./delegation-budget-store.js";
import { instanceSpendMicros } from "./usage.js";
import type { ApplyDecision } from "./apply-loop.js";
import type { Env } from "../types.js";

/**
 * Bounded worst case for one apply decide step, in USD micros. Settle refunds the rest.
 *
 * One decide is a single `claude-sonnet-4-6` call carrying the system prompt plus a whole ARIA
 * snapshot: ~40k input tokens at $3/M ≈ $0.12, plus a tool call of ~1k output at $15/M ≈ $0.015.
 * $0.15 covers that; a typical step settles back an order of magnitude less.
 */
export const APPLY_RESERVE_MICROS = 150_000; // $0.15

/**
 * Run one `decide` against the run's pool.
 *
 * No pool (`budgetId` absent) → the call runs exactly as before, which keeps every caller that has
 * not been given one working unchanged.
 */
export async function decideWithinBudget(
	env: Env,
	scope: { userId: string; instanceId: string; budgetId?: string | null; depth?: number },
	decide: () => Promise<ApplyDecision>,
): Promise<ApplyDecision> {
	const { userId, instanceId } = scope;
	const budgetId = scope.budgetId ?? null;
	if (!budgetId) return decide();

	const depth = scope.depth ?? 0;
	const draw = await reserve(env, userId, budgetId, { depth, estimatedCostMicros: APPLY_RESERVE_MICROS });
	if (!draw.ok) {
		// `account_ceiling` is the ACCOUNT's rolling 24h backstop tripping, not this tree's pool
		// being spent. Closing the shared budget for it stops every sibling drawing on the same pool
		// and survives the window rolling off.
		if (draw.reason && draw.reason !== "not_found" && draw.reason !== "closed" && draw.reason !== "account_ceiling") {
			await markExhausted(env, userId, budgetId, draw.reason, depth).catch(() => undefined);
		}
		// A clean terminal decision rather than a throw: `runApplyLoop` ends the application on a
		// `finish`, so the run stops with a reason the human reads on the board, the transcript is
		// still saved to the per-ATS cache, and the browser session is left as it is.
		//
		// `blocked` is the only honest one of the four `finish` statuses — it did not submit, the job
		// did not expire, and it is not `ready`. The wording matters more than it looks: a `blocked`
		// finish whose detail mentions a captcha is re-routed to a human takeover
		// (`apply-loop.ts:219`), so this sentence deliberately says nothing about robots or
		// verification, and the test beside this file holds it to that.
		return {
			thought: "the run's spend pool refused the next step",
			finish: { status: "blocked", detail: draw.message ?? "This application hit its spend limit." },
		};
	}
	const before = await instanceSpendMicros(env, userId, instanceId);
	try {
		return await decide();
	} finally {
		// Settled in `finally` so a throwing decide still charges what it burned — otherwise a
		// failing loop would run free, and the reservation would be held against the pool forever
		// (the leak `50e56ed` fixed on the chat loop, where a swallowed settle starved every sibling
		// on the same tree). The read may itself fail, and a `finally` must not throw (it would
		// replace the decide's real error), so an unreadable ledger charges the whole reservation:
		// over-charging stops a run early, under-charging lets a runaway continue.
		const after = await instanceSpendMicros(env, userId, instanceId).catch(() => before + (draw.reserved ?? APPLY_RESERVE_MICROS));
		await settle(env, userId, budgetId, draw.reserved ?? APPLY_RESERVE_MICROS, Math.max(0, after - before)).catch(() => undefined);
	}
}
