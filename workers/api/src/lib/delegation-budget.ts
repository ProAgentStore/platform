// The spend bound for one delegation tree (#184) — pure arithmetic and admission rules.
//
// Shape of the thing, because the obvious design is wrong in three ways and the obvious design
// is what gets built by default:
//
//  1. Depth bounds almost nothing. A supervisor at depth 1 can re-delegate sequentially a
//     thousand times without ever going deeper. Depth caps tree HEIGHT, not work — so cost is
//     the real control, with a delegation COUNT beside it (a cheap model spins many iterations
//     before a cost cap bites).
//  2. A budget "carried down and decremented at each hop" is a per-path COPY: five siblings each
//     receive the full allowance and the tree total becomes allowance × fanout^depth — unbounded
//     in exactly the quantity being bounded. So the pool is shared, scoped to the ROOT, and drawn
//     atomically (the atomic part lives in the store; this module decides *whether* a draw fits).
//  3. Check-then-go overshoots. Cost is known only AFTER a run, so N concurrent branches all pass
//     an optimistic check and overshoot by N × run_cost — classic overbooking. Hence
//     reserve-before / settle-after, with `reserved` held against the pool while work is in
//     flight and released when the actual lands.
//
// `ai_usage` (0048) already records cost_micros faithfully, but it is a ledger, not a control:
// it tells you what a runaway cost, after it cost you.

/** Micros of USD, matching `ai_usage.cost_micros` (1e6 = $1). */
export type Micros = number;

export interface BudgetLimits {
	costMicros: Micros;
	delegations: number;
	maxDepth: number;
}

/**
 * Defaults for a tree nobody configured. Deliberately non-infinite: an unconfigured supervision
 * edge must be bounded, because "we'll set a limit later" is how the first runaway happens.
 * Tuned to sit well above a real session — the acceptance test for these numbers is what
 * fraction of historical runs they would have interrupted (target ~0), which needs the
 * `ai_usage` distribution per `kind`.
 */
export const DEFAULT_LIMITS: BudgetLimits = {
	costMicros: 5_000_000, // $5 across the whole tree
	delegations: 50,
	maxDepth: 4, // matches supervision-graph MAX_DEPTH
};

/** The mutable state of a pool. */
export interface BudgetState {
	costMicrosLimit: Micros;
	/** Held for in-flight work: reserved but not yet settled. */
	costMicrosReserved: Micros;
	/** Settled actuals. */
	costMicrosSpent: Micros;
	delegationsLimit: number;
	delegationsUsed: number;
	maxDepth: number;
}

/** What is still drawable. Reserved money is NOT available — that is the overbooking fix. */
export function remainingCost(b: BudgetState): Micros {
	return Math.max(0, b.costMicrosLimit - b.costMicrosReserved - b.costMicrosSpent);
}

export function remainingDelegations(b: BudgetState): number {
	return Math.max(0, b.delegationsLimit - b.delegationsUsed);
}

export type AdmissionRefusal = "cost_exhausted" | "delegations_exhausted" | "too_deep";

export interface Admission {
	ok: boolean;
	reason?: AdmissionRefusal;
	/** Phrased so a human reading the board knows a runaway was stopped, not that work broke. */
	message?: string;
}

/**
 * May this delegation start?
 *
 * `estimatedCostMicros` is the amount that will be RESERVED — a bounded maximum for the step,
 * not a prediction. Reserving too little is what re-opens the overshoot, so callers should
 * reserve the worst case and rely on settle to refund.
 */
export function canAdmit(
	b: BudgetState,
	opts: { depth: number; estimatedCostMicros: Micros },
): Admission {
	if (opts.depth > b.maxDepth) {
		return {
			ok: false,
			reason: "too_deep",
			message: `Stopped at depth ${opts.depth}: this delegation chain is deeper than the ${b.maxDepth}-level limit.`,
		};
	}
	if (remainingDelegations(b) <= 0) {
		return {
			ok: false,
			reason: "delegations_exhausted",
			message: `Stopped after ${b.delegationsUsed} delegations: this run hit its delegation limit.`,
		};
	}
	const need = Math.max(0, opts.estimatedCostMicros);
	if (need > remainingCost(b)) {
		return {
			ok: false,
			reason: "cost_exhausted",
			message: `Stopped at ${formatMicros(b.costMicrosSpent)} of ${formatMicros(b.costMicrosLimit)}: this run hit its spend limit.`,
		};
	}
	return { ok: true };
}

/**
 * Apply a settlement to a state.
 *
 * The reservation is released in full and the ACTUAL is charged — which is why an overspending
 * step still lands correctly (it eats more of the pool) and an underspending one gives change
 * back rather than silently shrinking the tree's remaining budget.
 */
export function applySettlement(b: BudgetState, reserved: Micros, actual: Micros): BudgetState {
	return {
		...b,
		costMicrosReserved: Math.max(0, b.costMicrosReserved - Math.max(0, reserved)),
		costMicrosSpent: b.costMicrosSpent + Math.max(0, actual),
	};
}

/** Is the pool effectively done — nothing left to draw and nothing in flight? */
export function isExhausted(b: BudgetState): boolean {
	return remainingCost(b) <= 0 && b.costMicrosReserved <= 0;
}

/** `$1.25` from micros. Small helper, but every refusal message shows money to a human. */
export function formatMicros(micros: Micros): string {
	return `$${(Math.max(0, micros) / 1_000_000).toFixed(2)}`;
}

/**
 * `13.4M` from a token count — the other unit a refusal can be denominated in (#343).
 *
 * A token ceiling that reported "250000000 tokens" would read as noise, and the number a human
 * has to compare it against ("my session used 13.4M") is always quoted this way by the tools that
 * show it. Rounded, never padded: this is a magnitude, not an accounting figure.
 */
export function formatTokens(n: number): string {
	const v = Math.max(0, Math.floor(Number(n) || 0));
	if (v < 1000) return String(v);
	if (v < 1_000_000) return `${Math.round(v / 1000)}K`;
	return `${(v / 1_000_000).toFixed(v < 10_000_000 ? 1 : 0)}M`;
}

/**
 * Normalize caller-supplied limits.
 *
 * Clamped to the defaults as a CEILING, not just a fallback: a supervisor must not be able to
 * raise its own budget by asking for more when it opens a child tree. The pool only ever
 * decreases downward — raising it is a human action, not an agent one.
 */
export function sanitizeLimits(raw: unknown, ceiling: BudgetLimits = DEFAULT_LIMITS): BudgetLimits {
	const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const num = (v: unknown, fallback: number, max: number): number => {
		const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : fallback;
		return Math.max(0, Math.min(n, max));
	};
	return {
		costMicros: num(o.costMicros, ceiling.costMicros, ceiling.costMicros),
		delegations: num(o.delegations, ceiling.delegations, ceiling.delegations),
		maxDepth: num(o.maxDepth, ceiling.maxDepth, ceiling.maxDepth),
	};
}
