/**
 * Account budget limits — the per-account daily circuit breakers (issue #474/#475).
 *
 * Two routes:
 *   GET  /v1/budget/limits — effective ceilings, 24h rolling consumption, tier source
 *   PUT  /v1/budget/limits — upsert the caller's row in account_budget_limits
 *
 * The resolution stack (four tiers, first non-null wins):
 *   1. per-account D1 row  (account_budget_limits WHERE user_id = <uid>)
 *   2. platform-default D1 row  (account_budget_limits WHERE user_id = '__platform__')
 *   3. env var  (ACCOUNT_DAILY_CHARGED_MICROS_CEILING / ACCOUNT_DAILY_TOKEN_CEILING)
 *   4. hard constant  (DAILY_CEILING_MICROS / DAILY_TOKEN_CEILING)
 *
 * `NULL` / absent fields on PUT → inherit (remove the per-account override).
 */
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import {
	resolveAccountCeilings,
	DAILY_CEILING_MICROS,
	DAILY_TOKEN_CEILING,
} from "../lib/delegation-budget-store.js";
import { accountUsageSince } from "../lib/usage.js";
import type { Env } from "../types.js";

export const budgetRoutes = new Hono<{ Bindings: Env }>();

/** Maximum values a user may store — mirror the constants in delegation-budget-store.ts. */
const MAX_CHARGED_MICROS = 10_000_000_000; // $10 000 / 24h
const MAX_TOKEN_CEILING = 100_000_000_000; // 100B tokens / 24h

interface BudgetLimitRow {
	token_ceiling: number | null;
	charged_micros_ceiling: number | null;
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
	envVal: string | undefined,
	hardConstant: number,
): { value: number; tier: CeilingTier } {
	if (perAccount !== null && Number.isFinite(perAccount) && perAccount > 0) {
		return { value: Math.min(Math.floor(perAccount), MAX_CHARGED_MICROS), tier: "account" };
	}
	if (platformDefault !== null && Number.isFinite(platformDefault) && platformDefault > 0) {
		return { value: Math.min(Math.floor(platformDefault), MAX_CHARGED_MICROS), tier: "platform" };
	}
	if (envVal !== undefined) {
		const n = Number(envVal);
		if (Number.isFinite(n) && n > 0) return { value: Math.min(Math.floor(n), MAX_CHARGED_MICROS), tier: "env" };
	}
	return { value: hardConstant, tier: "default" };
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

	// Read the per-account and platform rows in one query (same as resolveAccountCeilings).
	let perAccountRow: BudgetLimitRow | null = null;
	let platformRow: BudgetLimitRow | null = null;
	try {
		const rows = await c.env.DB.prepare(
			`SELECT user_id, token_ceiling, charged_micros_ceiling
			   FROM account_budget_limits
			  WHERE user_id IN (?1, '__platform__')`,
		)
			.bind(uid)
			.all<{ user_id: string; token_ceiling: number | null; charged_micros_ceiling: number | null }>();
		for (const r of rows.results ?? []) {
			if (r.user_id === uid) perAccountRow = r;
			else platformRow = r;
		}
	} catch {
		// Table absent or D1 blip — fall through to env/constant tier.
	}

	// Resolve effective ceilings from delegation-budget-store.
	const [ceilings, window] = await Promise.all([
		resolveAccountCeilings(c.env, uid),
		accountUsageSince(c.env, uid, 24),
	]);

	// Also resolve per-ceiling tiers using token ceilings correctly (not capped at MAX_CHARGED_MICROS).
	const chargedTierInfo = resolveTier(
		perAccountRow?.charged_micros_ceiling ?? null,
		platformRow?.charged_micros_ceiling ?? null,
		c.env.ACCOUNT_DAILY_CHARGED_MICROS_CEILING,
		DAILY_CEILING_MICROS,
	);
	const tokenTierInfo = resolveTier(
		perAccountRow?.token_ceiling ?? null,
		platformRow?.token_ceiling ?? null,
		c.env.ACCOUNT_DAILY_TOKEN_CEILING,
		DAILY_TOKEN_CEILING,
	);

	// Use the resolved values from resolveAccountCeilings (correctly clamped).
	const chargedMicrosCeiling = ceilings.chargedMicrosCeiling;
	const tokenCeiling = ceilings.tokenCeiling;

	return c.json({
		/** What the caller has stored per-account (null = inheriting). */
		stored: {
			chargedMicrosCeiling: perAccountRow?.charged_micros_ceiling ?? null,
			tokenCeiling: perAccountRow?.token_ceiling ?? null,
		},
		/** The effective value after resolution. */
		effective: {
			chargedMicrosCeiling,
			chargedMicrosCeilingTier: chargedTierInfo.tier,
			tokenCeiling,
			tokenCeilingTier: tokenTierInfo.tier,
		},
		/** Rolling 24h consumption. */
		consumption: {
			chargedMicros: window.chargedMicros,
			tokens: window.tokens,
		},
		/** How far below the ceiling the caller is (may be negative if ceiling is already tripped). */
		remaining: {
			chargedMicros: Math.max(0, chargedMicrosCeiling - window.chargedMicros),
			tokens: Math.max(0, tokenCeiling - window.tokens),
		},
		/** The maximum a caller may set, for client-side clamping. */
		maxOverride: {
			chargedMicrosCeiling: MAX_CHARGED_MICROS,
			tokenCeiling: MAX_TOKEN_CEILING,
		},
	});
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
	const rawCharged = body.chargedMicrosCeiling;
	const rawTokens = body.tokenCeiling;

	const chargedMicrosCeiling =
		rawCharged === null || rawCharged === undefined
			? null
			: clampPositiveInt(rawCharged, MAX_CHARGED_MICROS, "chargedMicrosCeiling");

	const tokenCeiling =
		rawTokens === null || rawTokens === undefined
			? null
			: clampPositiveInt(rawTokens, MAX_TOKEN_CEILING, "tokenCeiling");

	// If both are null, we delete the row (fully inheriting).
	// Otherwise upsert with the new values.
	if (chargedMicrosCeiling === null && tokenCeiling === null) {
		await c.env.DB.prepare(
			"DELETE FROM account_budget_limits WHERE user_id = ?1",
		)
			.bind(uid)
			.run();
	} else {
		await c.env.DB.prepare(
			`INSERT INTO account_budget_limits (user_id, token_ceiling, charged_micros_ceiling)
			 VALUES (?1, ?2, ?3)
			 ON CONFLICT (user_id) DO UPDATE SET
			   token_ceiling = excluded.token_ceiling,
			   charged_micros_ceiling = excluded.charged_micros_ceiling`,
		)
			.bind(uid, tokenCeiling, chargedMicrosCeiling)
			.run();
	}

	// Re-read to return the actual stored values + newly resolved effective values.
	let perAccountRow: BudgetLimitRow | null = null;
	let platformRow: BudgetLimitRow | null = null;
	try {
		const rows = await c.env.DB.prepare(
			`SELECT user_id, token_ceiling, charged_micros_ceiling
			   FROM account_budget_limits
			  WHERE user_id IN (?1, '__platform__')`,
		)
			.bind(uid)
			.all<{ user_id: string; token_ceiling: number | null; charged_micros_ceiling: number | null }>();
		for (const r of rows.results ?? []) {
			if (r.user_id === uid) perAccountRow = r;
			else platformRow = r;
		}
	} catch {
		// Fall through.
	}

	const [ceilings, window] = await Promise.all([
		resolveAccountCeilings(c.env, uid),
		accountUsageSince(c.env, uid, 24),
	]);

	const chargedTierInfo = resolveTier(
		perAccountRow?.charged_micros_ceiling ?? null,
		platformRow?.charged_micros_ceiling ?? null,
		c.env.ACCOUNT_DAILY_CHARGED_MICROS_CEILING,
		DAILY_CEILING_MICROS,
	);
	const tokenTierInfo = resolveTier(
		perAccountRow?.token_ceiling ?? null,
		platformRow?.token_ceiling ?? null,
		c.env.ACCOUNT_DAILY_TOKEN_CEILING,
		DAILY_TOKEN_CEILING,
	);

	const resolvedCharged = ceilings.chargedMicrosCeiling;
	const resolvedTokens = ceilings.tokenCeiling;

	return c.json({
		stored: {
			chargedMicrosCeiling: perAccountRow?.charged_micros_ceiling ?? null,
			tokenCeiling: perAccountRow?.token_ceiling ?? null,
		},
		effective: {
			chargedMicrosCeiling: resolvedCharged,
			chargedMicrosCeilingTier: chargedTierInfo.tier,
			tokenCeiling: resolvedTokens,
			tokenCeilingTier: tokenTierInfo.tier,
		},
		consumption: {
			chargedMicros: window.chargedMicros,
			tokens: window.tokens,
		},
		remaining: {
			chargedMicros: Math.max(0, resolvedCharged - window.chargedMicros),
			tokens: Math.max(0, resolvedTokens - window.tokens),
		},
		maxOverride: {
			chargedMicrosCeiling: MAX_CHARGED_MICROS,
			tokenCeiling: MAX_TOKEN_CEILING,
		},
	});
});

/** Parse a value as a positive integer, clamped to max. Throws 400 on bad input. */
function clampPositiveInt(raw: unknown, max: number, field: string): number {
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) {
		throw new HttpError(400, `${field} must be a non-negative number.`);
	}
	return Math.min(Math.floor(n), max);
}
