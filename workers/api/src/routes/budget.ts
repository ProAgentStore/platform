/**
 * Account budget limits — per-account daily circuit breakers + per-tree run knobs (#474/#475/#477).
 *
 * Two routes:
 *   GET  /v1/budget/limits — effective ceilings, 24h rolling consumption, tier source
 *   PUT  /v1/budget/limits — patch the caller's row in account_budget_limits
 *
 * The resolution stack (four tiers, first non-null wins):
 *   1. per-account D1 row  (account_budget_limits WHERE user_id = <uid>)
 *   2. platform-default D1 row  (account_budget_limits WHERE user_id = '__platform__')
 *   3. env var  (ACCOUNT_DAILY_CHARGED_MICROS_CEILING / ACCOUNT_DAILY_TOKEN_CEILING)
 *   4. hard constant  (DAILY_CEILING_MICROS / DAILY_TOKEN_CEILING / DEFAULT_LIMITS / MAX_ITERATIONS_CAP)
 *
 * PUT is a PATCH: a field present as `null` clears the per-account override (inherit); a field
 * absent from the body is left exactly as stored (#501).
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

/**
 * Every settable column of `account_budget_limits`, with the JSON field that writes it and the
 * maximum a caller may store.
 *
 * One table, because there are three places that must agree about this set — the PUT handler, the
 * console form, and MCP `set_budget_limits` — and when they disagreed the narrowest one won by
 * clearing what it did not know about (#501). `budget.test.ts` holds this list to the migrations
 * and to the MCP tool's own copy, so a seventh column cannot land in only one of them.
 */
export const BUDGET_LIMIT_FIELDS = [
	{ column: "charged_micros_ceiling", field: "chargedMicrosCeiling", max: MAX_CHARGED_MICROS },
	{ column: "token_ceiling", field: "tokenCeiling", max: MAX_TOKEN_CEILING },
	{ column: "per_tree_cost_micros", field: "perTreeCostMicros", max: MAX_PER_TREE_MICROS },
	{ column: "delegations", field: "perTreeDelegations", max: MAX_PER_TREE_DELEGATIONS },
	{ column: "max_depth", field: "perTreeMaxDepth", max: MAX_PER_TREE_DEPTH },
	{ column: "loop_max_iterations", field: "loopMaxIterations", max: MAX_LOOP_ITERATIONS },
] as const satisfies readonly { column: keyof BudgetLimitRow; field: string; max: number }[];

type BudgetLimitColumn = (typeof BUDGET_LIMIT_FIELDS)[number]["column"];

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
 * Patches the caller's row in account_budget_limits.
 *
 * Patch semantics, matching the convention `PUT /v1/instances/:id/behaviour` already established
 * in this codebase (`applyBehaviourPatch`): a field ABSENT from the body is left as stored; a field
 * present as `null` clears the per-account override so it inherits from the next tier. All six
 * resolving to null = the row is deleted (full inherit).
 *
 * This used to be a full replace, where absent also meant "clear". It read as coherent because the
 * console renders and submits all six controls — but a narrower client wiped what it did not know
 * about: MCP `set_budget_limits` sent two of six fields and silently reverted per-tree limits and
 * the Loop iteration cap the owner had configured (#501). "Absent = leave alone" is the only
 * semantics under which a partial writer is safe, and it costs the console nothing because a
 * full-document PUT is a patch that happens to name every field.
 *
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
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new HttpError(400, "Request body must be a JSON object.");
	}

	// The pre-write row is what an absent field falls back to. Read it before the upsert.
	const before = (await readLimitRows(c.env.DB, uid)).perAccountRow;

	/** Absent → keep what is stored. Present (including an explicit null) → set or clear. */
	const next = Object.fromEntries(
		BUDGET_LIMIT_FIELDS.map(({ column, field, max }) => [
			column,
			field in body ? nullOrClamp(body[field], max, field) : (before?.[column] ?? null),
		]),
	) as Record<BudgetLimitColumn, number | null>;

	// All null = delete the row (fully inheriting from platform/env/constant).
	const allNull = Object.values(next).every((v) => v === null);

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
			.bind(
				uid,
				next.token_ceiling,
				next.charged_micros_ceiling,
				next.per_tree_cost_micros,
				next.delegations,
				next.max_depth,
				next.loop_max_iterations,
			)
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

/** Parse an explicitly-supplied value as null (clear) or a clamped positive integer. Throws 400 on bad input. */
function nullOrClamp(raw: unknown, max: number, field: string): number | null {
	if (raw === null || raw === undefined) return null;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) {
		throw new HttpError(400, `${field} must be a non-negative number.`);
	}
	return Math.min(Math.floor(n), max);
}
