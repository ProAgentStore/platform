/**
 * Account budget limits — per-account daily circuit breakers + per-tree run knobs (#474/#475/#477).
 *
 * Two routes:
 *   GET  /v1/budget/limits — effective ceilings, 24h rolling consumption, tier source
 *   PUT  /v1/budget/limits — upsert the caller's row in account_budget_limits
 *
 * The resolution stack (four tiers, first non-null wins):
 *   1. per-account D1 row  (account_budget_limits WHERE user_id = <uid>)
 *   2. platform-default D1 row  (account_budget_limits WHERE user_id = '__platform__')
 *   3. env var  (ACCOUNT_DAILY_CHARGED_MICROS_CEILING / ACCOUNT_DAILY_TOKEN_CEILING)
 *   4. hard constant  (DAILY_CEILING_MICROS / DAILY_TOKEN_CEILING / DEFAULT_LIMITS / MAX_ITERATIONS_CAP)
 *
 * `NULL` / absent fields on PUT → inherit (remove the per-account override).
 */
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import {
	resolveAccountCeilings,
	DAILY_CEILING_MICROS,
	DAILY_TOKEN_CEILING,
	isBudgetEnforced,
} from "../lib/delegation-budget-store.js";
import { DEFAULT_LIMITS } from "../lib/delegation-budget.js";
import { MAX_ITERATIONS_CAP } from "../lib/agent-loop.js";
import { accountUsageSince } from "../lib/usage.js";
import type { Env } from "../types.js";

export const budgetRoutes = new Hono<{ Bindings: Env }>();

/** Maximum values a user may store — mirror the constants in delegation-budget-store.ts. */
const MAX_CHARGED_MICROS = 10_000_000_000; // $10 000 / 24h
const MAX_TOKEN_CEILING = 100_000_000_000; // 100B tokens / 24h
const MAX_PER_TREE_MICROS = 1_000_000_000; // $1 000 per tree
const MAX_PER_TREE_DELEGATIONS = 10_000;
const MAX_PER_TREE_DEPTH = 20;
const MAX_LOOP_ITERATIONS = 1_000;

interface BudgetLimitRow {
	token_ceiling: number | null;
	charged_micros_ceiling: number | null;
	per_tree_cost_micros: number | null;
	delegations: number | null;
	max_depth: number | null;
	loop_max_iterations: number | null;
}

/** Tier label for each resolved ceiling. */
type CeilingTier = "account" | "platform" | "env" | "default";

/**
 * Resolve which tier each field was drawn from.
 * Mirrors the pick() logic in delegation-budget-store.ts, but returns the tier name
 * instead of the value so the UI can label "why this number".
 */
function resolveTier(
	perAccount: number | null,
	platformDefault: number | null,
	max: number,
	envVal?: string | undefined,
	hardConstant?: number,
): { value: number; tier: CeilingTier } {
	if (perAccount !== null && Number.isFinite(perAccount) && perAccount > 0) {
		return { value: Math.min(Math.floor(perAccount), max), tier: "account" };
	}
	if (platformDefault !== null && Number.isFinite(platformDefault) && platformDefault > 0) {
		return { value: Math.min(Math.floor(platformDefault), max), tier: "platform" };
	}
	if (envVal !== undefined) {
		const n = Number(envVal);
		if (Number.isFinite(n) && n > 0) return { value: Math.min(Math.floor(n), max), tier: "env" };
	}
	return { value: hardConstant ?? 0, tier: "default" };
}

/** Read the per-account + platform rows from account_budget_limits. */
async function readLimitRows(
	db: Env["DB"],
	uid: string,
): Promise<{ perAccountRow: BudgetLimitRow | null; platformRow: BudgetLimitRow | null }> {
	let perAccountRow: BudgetLimitRow | null = null;
	let platformRow: BudgetLimitRow | null = null;
	try {
		const rows = await db
			.prepare(
				`SELECT user_id, token_ceiling, charged_micros_ceiling,
				        per_tree_cost_micros, delegations, max_depth, loop_max_iterations
				   FROM account_budget_limits
				  WHERE user_id IN (?1, '__platform__')`,
			)
			.bind(uid)
			.all<{ user_id: string } & BudgetLimitRow>();
		for (const r of rows.results ?? []) {
			if (r.user_id === uid) perAccountRow = r;
			else platformRow = r;
		}
	} catch {
		// Table absent (migration 0115 not yet applied on old installs) or D1 blip — fall through.
	}
	return { perAccountRow, platformRow };
}

/** Build the response body shared by GET and PUT. */
function buildResponse(
	perAccountRow: BudgetLimitRow | null,
	platformRow: BudgetLimitRow | null,
	ceilings: Awaited<ReturnType<typeof resolveAccountCeilings>>,
	window: { chargedMicros: number; tokens: number },
	env: Pick<Env, "ACCOUNT_DAILY_CHARGED_MICROS_CEILING" | "ACCOUNT_DAILY_TOKEN_CEILING">,
	enforced: boolean,
) {
	const chargedTier = resolveTier(
		perAccountRow?.charged_micros_ceiling ?? null,
		platformRow?.charged_micros_ceiling ?? null,
		MAX_CHARGED_MICROS,
		env.ACCOUNT_DAILY_CHARGED_MICROS_CEILING,
		DAILY_CEILING_MICROS,
	);
	const tokenTier = resolveTier(
		perAccountRow?.token_ceiling ?? null,
		platformRow?.token_ceiling ?? null,
		MAX_TOKEN_CEILING,
		env.ACCOUNT_DAILY_TOKEN_CEILING,
		DAILY_TOKEN_CEILING,
	);
	const perTreeCostTier = resolveTier(
		perAccountRow?.per_tree_cost_micros ?? null,
		platformRow?.per_tree_cost_micros ?? null,
		MAX_PER_TREE_MICROS,
		undefined,
		DEFAULT_LIMITS.costMicros,
	);
	const perTreeDelegationsTier = resolveTier(
		perAccountRow?.delegations ?? null,
		platformRow?.delegations ?? null,
		MAX_PER_TREE_DELEGATIONS,
		undefined,
		DEFAULT_LIMITS.delegations,
	);
	const perTreeDepthTier = resolveTier(
		perAccountRow?.max_depth ?? null,
		platformRow?.max_depth ?? null,
		MAX_PER_TREE_DEPTH,
		undefined,
		DEFAULT_LIMITS.maxDepth,
	);
	const loopMaxIterationsTier = resolveTier(
		perAccountRow?.loop_max_iterations ?? null,
		platformRow?.loop_max_iterations ?? null,
		MAX_LOOP_ITERATIONS,
		undefined,
		MAX_ITERATIONS_CAP,
	);

	return {
		/** What the caller has stored per-account (null = inheriting). */
		stored: {
			chargedMicrosCeiling: perAccountRow?.charged_micros_ceiling ?? null,
			tokenCeiling: perAccountRow?.token_ceiling ?? null,
			perTreeCostMicros: perAccountRow?.per_tree_cost_micros ?? null,
			perTreeDelegations: perAccountRow?.delegations ?? null,
			perTreeMaxDepth: perAccountRow?.max_depth ?? null,
			loopMaxIterations: perAccountRow?.loop_max_iterations ?? null,
		},
		/** The effective value after resolution. */
		effective: {
			chargedMicrosCeiling: ceilings.chargedMicrosCeiling,
			chargedMicrosCeilingTier: chargedTier.tier,
			tokenCeiling: ceilings.tokenCeiling,
			tokenCeilingTier: tokenTier.tier,
			perTreeCostMicros: ceilings.perTreeCostMicros,
			perTreeCostMicrosTier: perTreeCostTier.tier,
			perTreeDelegations: ceilings.perTreeDelegations,
			perTreeDelegationsTier: perTreeDelegationsTier.tier,
			perTreeMaxDepth: ceilings.perTreeMaxDepth,
			perTreeMaxDepthTier: perTreeDepthTier.tier,
			loopMaxIterations: ceilings.loopMaxIterations,
			loopMaxIterationsTier: loopMaxIterationsTier.tier,
		},
		/** Rolling 24h consumption. */
		consumption: {
			chargedMicros: window.chargedMicros,
			tokens: window.tokens,
		},
		/** How far below the ceiling the caller is (clamped to 0 if already over). */
		remaining: {
			chargedMicros: Math.max(0, ceilings.chargedMicrosCeiling - window.chargedMicros),
			tokens: Math.max(0, ceilings.tokenCeiling - window.tokens),
		},
		/** The maximum a caller may set, for client-side clamping. */
		maxOverride: {
			chargedMicrosCeiling: MAX_CHARGED_MICROS,
			tokenCeiling: MAX_TOKEN_CEILING,
			perTreeCostMicros: MAX_PER_TREE_MICROS,
			perTreeDelegations: MAX_PER_TREE_DELEGATIONS,
			perTreeMaxDepth: MAX_PER_TREE_DEPTH,
			loopMaxIterations: MAX_LOOP_ITERATIONS,
		},
		/**
		 * Whether these ceilings are currently enforced. When false the limits are stored and
		 * metered but never block a run (observe-only, see BUDGET_ENFORCE).
		 */
		enforced,
	};
}

/**
 * GET /v1/budget/limits
 *
 * Returns effective ceilings (resolved from the 4-tier stack), current 24h rolling
 * consumption (charged dollars + tokens), distance-to-limit, and which tier each
 * ceiling was resolved from.
 */
budgetRoutes.get("/limits", async (c) => {
	const session = await requireUser(c);
	const uid = session.uid;

	const [{ perAccountRow, platformRow }, ceilings, window] = await Promise.all([
		readLimitRows(c.env.DB, uid),
		resolveAccountCeilings(c.env, uid),
		accountUsageSince(c.env, uid, 24),
	]);

	return c.json(buildResponse(perAccountRow, platformRow, ceilings, window, c.env, isBudgetEnforced(c.env)));
});

/**
 * PUT /v1/budget/limits
 *
 * Upserts the caller's row in account_budget_limits.
 * NULL / absent = inherit from the next tier down (removes the per-account override).
 * Values are clamped to MAX_OVERRIDE_* on the way in.
 *
 * Returns the same shape as GET — re-resolved effective values after the write.
 */
budgetRoutes.put("/limits", async (c) => {
	const session = await requireUser(c);
	const uid = session.uid;

	let body: Record<string, unknown>;
	try {
		body = await c.req.json<Record<string, unknown>>();
	} catch {
		throw new HttpError(400, "Request body must be JSON.");
	}

	// Extract and clamp values. null/undefined → NULL (inherit).
	const chargedMicrosCeiling = nullOrClamp(body.chargedMicrosCeiling, MAX_CHARGED_MICROS, "chargedMicrosCeiling");
	const tokenCeiling = nullOrClamp(body.tokenCeiling, MAX_TOKEN_CEILING, "tokenCeiling");
	const perTreeCostMicros = nullOrClamp(body.perTreeCostMicros, MAX_PER_TREE_MICROS, "perTreeCostMicros");
	const perTreeDelegations = nullOrClamp(body.perTreeDelegations, MAX_PER_TREE_DELEGATIONS, "perTreeDelegations");
	const perTreeMaxDepth = nullOrClamp(body.perTreeMaxDepth, MAX_PER_TREE_DEPTH, "perTreeMaxDepth");
	const loopMaxIterations = nullOrClamp(body.loopMaxIterations, MAX_LOOP_ITERATIONS, "loopMaxIterations");

	// All null = delete the row (fully inheriting from platform/env/constant).
	const allNull = [chargedMicrosCeiling, tokenCeiling, perTreeCostMicros, perTreeDelegations, perTreeMaxDepth, loopMaxIterations]
		.every((v) => v === null);

	if (allNull) {
		await c.env.DB.prepare("DELETE FROM account_budget_limits WHERE user_id = ?1")
			.bind(uid)
			.run();
	} else {
		await c.env.DB.prepare(
			`INSERT INTO account_budget_limits
			   (user_id, token_ceiling, charged_micros_ceiling, per_tree_cost_micros, delegations, max_depth, loop_max_iterations)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
			 ON CONFLICT (user_id) DO UPDATE SET
			   token_ceiling          = excluded.token_ceiling,
			   charged_micros_ceiling = excluded.charged_micros_ceiling,
			   per_tree_cost_micros   = excluded.per_tree_cost_micros,
			   delegations            = excluded.delegations,
			   max_depth              = excluded.max_depth,
			   loop_max_iterations    = excluded.loop_max_iterations`,
		)
			.bind(uid, tokenCeiling, chargedMicrosCeiling, perTreeCostMicros, perTreeDelegations, perTreeMaxDepth, loopMaxIterations)
			.run();
	}

	// Re-read to return the actual stored values + newly resolved effective values.
	const [{ perAccountRow, platformRow }, ceilings, window] = await Promise.all([
		readLimitRows(c.env.DB, uid),
		resolveAccountCeilings(c.env, uid),
		accountUsageSince(c.env, uid, 24),
	]);

	return c.json(buildResponse(perAccountRow, platformRow, ceilings, window, c.env, isBudgetEnforced(c.env)));
});

/** Parse a value as null (when absent/null) or a clamped positive integer. Throws 400 on bad input. */
function nullOrClamp(raw: unknown, max: number, field: string): number | null {
	if (raw === null || raw === undefined) return null;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) {
		throw new HttpError(400, `${field} must be a non-negative number.`);
	}
	return Math.min(Math.floor(n), max);
}
