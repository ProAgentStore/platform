// Resolving a usage row's agent and instance to something a human can read (#526).
//
// Split out of `usage.ts` because it is a different job from aggregation, and because it is the
// job with the sharp edge: the ledger's two id columns are each written with the WRONG kind of id
// by a live path, in opposite directions, and every query that reads them looks correct. Keeping
// the SQL here — as an exported string rather than inline in the route — is what lets a test
// EXECUTE it against real SQLite (`usage-resolution.test.ts`) instead of matching its text.
//
// Nothing here touches D1 directly; it is strings and pure functions, so the rules are testable.

/** The bucket a row with no id on this axis aggregates under (D1 NULL has no key). */
export const UNASSIGNED_KEY = "unassigned";

/**
 * The Usage page's row scan, resolving each row's agent AND instance BY LOOKUP (#526).
 *
 * Exported from here rather than written inline in the route so it can be EXECUTED by a test
 * against real SQLite. It has to be: the whole correction is in which join wins, two live writers
 * put an id in the wrong column in opposite directions, and every version of this query looks
 * correct when read.
 *
 *  - `agent-do.ts` builds the storage meter from `state.agentId`, which for an instance DO IS the
 *    instance id — so platform-paid embedding/summary rows carry an INSTANCE id in `agent_id` and
 *    NULL in `instance_id`. The previous `COALESCE(u.agent_id, i.agent_id)` preferred that value,
 *    both joins missed, and 26 rows rendered as their own raw UUID.
 *  - `agent-think.ts` passes `instanceId: state.agentId`, which is the AGENT id when a creator
 *    chats with their own template — so those rows carry an AGENT id in `instance_id` and fell into
 *    "Unassigned".
 *
 * Resolution is by JOIN against each candidate table, NEVER by the shape of the string:
 * `2dff5c62-…` is a genuine UUID *agent* id that labels correctly today, and a "looks like a UUID
 * ⇒ treat it as an instance" rule would break it. The instance joins are scoped to the row's own
 * user, so an id that was misattributed by a writer can never surface another tenant's name.
 *
 * An id that resolves nowhere is KEPT (`u.agent_id` last in the COALESCE) instead of collapsing
 * into "unassigned": the agent or instance was deleted and its spend record deliberately outlived
 * it, which is a different fact from "this row carried no id". {@link bucketLabel} renders it.
 */
export function usageRowsSql(withRange: boolean): string {
	// Grouped BEFORE the joins (#1662): the ledger is scanned once, collapsed to one row per
	// (raw agent id, raw instance id, model, kind, payer, day, engine session), and the five lookups
	// then run per group instead of per ledger row (~53,000 rows/call measured). Every figure the
	// aggregator sums is additive, so `aggregateUsage` over these rows (weighted by `calls`) yields
	// the same totals as over the raw rows; two groups that resolve to the same agent/instance simply
	// merge there. `created_at` is the day, which is all `aggregateUsage` reads from it; `row_id` is
	// reduced to `engine:{session}:` (the only part `engineSessionFromRowId` reads).
	return `SELECT COALESCE(ua.id, ia.agent_id, ub.agent_id, uc.id, g.agent_id) AS agent_id,
	        COALESCE(ia.id, ub.id) AS instance_id,
	        g.row_id,
	        g.provider, g.model, g.kind,
	        g.input_tokens, g.output_tokens, g.cache_read_tokens, g.cache_write_tokens,
	        g.cost_micros, g.payer, g.created_at, g.calls, an.name AS agent_name
	 FROM (
	   SELECT u.user_id, u.agent_id, u.instance_id, u.provider, u.model, u.kind, u.payer,
	          substr(u.created_at, 1, 10) AS created_at,
	          CASE WHEN u.id LIKE 'engine:%:%'
	               THEN 'engine:' || substr(substr(u.id, 8), 1, instr(substr(u.id, 8), ':') - 1) || ':' END AS row_id,
	          SUM(u.input_tokens) AS input_tokens, SUM(u.output_tokens) AS output_tokens,
	          SUM(u.cache_read_tokens) AS cache_read_tokens, SUM(u.cache_write_tokens) AS cache_write_tokens,
	          SUM(u.cost_micros) AS cost_micros, COUNT(*) AS calls
	   FROM ai_usage u
	   WHERE u.user_id = ?1 ${withRange ? "AND u.created_at >= ?2" : ""}
	   GROUP BY u.agent_id, u.instance_id, u.provider, u.model, u.kind, u.payer, substr(u.created_at, 1, 10), row_id
	 ) g
	 LEFT JOIN agents          ua ON ua.id = g.agent_id
	 LEFT JOIN agent_instances ia ON ia.id = g.instance_id AND ia.user_id = g.user_id
	 LEFT JOIN agent_instances ub ON ub.id = g.agent_id    AND ub.user_id = g.user_id
	 LEFT JOIN agents          uc ON uc.id = g.instance_id
	 LEFT JOIN agents          an ON an.id = COALESCE(ua.id, ia.agent_id, ub.agent_id, uc.id)
	 ORDER BY g.created_at ASC`;
}

/**
 * The payer-coverage split ({@link payerCoverage} in usage-coverage.ts) computed in SQL over the
 * same WHERE as {@link usageRowsSql} (#1662), since the grouped rows no longer carry the
 * per-call timestamps it needs. One row: `first_at`, then calls/cost for the three slices.
 */
export function usageCoverageSql(withRange: boolean): string {
	const where = `user_id = ?1 ${withRange ? "AND created_at >= ?2" : ""}`;
	const has = "payer IN ('byok-api', 'platform', 'subscription')";
	return `SELECT f.first_at AS first_at,
	        COALESCE(SUM(CASE WHEN ${has} THEN 1 END), 0) AS a_calls,
	        COALESCE(SUM(CASE WHEN ${has} THEN cost_micros END), 0) AS value_a,
	        COALESCE(SUM(CASE WHEN NOT COALESCE(${has}, 0) AND f.first_at IS NOT NULL AND created_at < f.first_at THEN 1 END), 0) AS b_calls,
	        COALESCE(SUM(CASE WHEN NOT COALESCE(${has}, 0) AND f.first_at IS NOT NULL AND created_at < f.first_at THEN cost_micros END), 0) AS value_b,
	        COALESCE(SUM(CASE WHEN NOT COALESCE(${has}, 0) AND NOT (f.first_at IS NOT NULL AND created_at < f.first_at) THEN 1 END), 0) AS s_calls,
	        COALESCE(SUM(CASE WHEN NOT COALESCE(${has}, 0) AND NOT (f.first_at IS NOT NULL AND created_at < f.first_at) THEN cost_micros END), 0) AS value_s
	 FROM ai_usage,
	      (SELECT MIN(CASE WHEN ${has} THEN created_at END) AS first_at FROM ai_usage WHERE ${where}) f
	 WHERE ${where}`;
}

/**
 * The JOINs and WHERE that scope `ai_usage` to ONE instance, resolving each row's instance exactly
 * the way {@link usageRowsSql} does (#662). The caller writes `FROM ai_usage u` itself — see below.
 *
 * Four instance-scoped readers were left on the raw column after #526 fixed the Usage page —
 * `instanceSpendMicros` (the delegation-budget settle), the two stats cards `usageTokens` and
 * `usageValue`, and the admin instance detail. Every platform-paid embedding and summary row
 * carried an instance id in `agent_id` and NULL in `instance_id` (see lib/meter-ids.ts), so all
 * four saw none of them: the budget settle UNDER-charged the pool, which usage.ts names as the
 * unsafe direction, and the per-instance stats cards disagreed with the Usage page about the same
 * instance in the same window with nothing on screen saying why.
 *
 * Written here, once, rather than open-coded a fifth time — the four drifted because there were
 * four of them. The `?N` positions are passed in because the callers bind in different orders.
 *
 * Two properties worth stating, since both are load-bearing:
 *  - the instance joins are scoped to the ROW'S OWN user, so an id a writer misattributed can
 *    never pull in another tenant's spend;
 *  - `COALESCE(ia.id, ub.id)` prefers a resolvable `instance_id` over `agent_id`, so a row that
 *    already names an instance correctly is unaffected. Only rows whose `instance_id` resolves to
 *    nothing — the ones these readers could not see at all — fall through to `agent_id`.
 *
 * ── Why the FROM stays at the call site
 *
 * `lib/usage-aggregates.ts` (#346) judges every `SUM(cost_micros)` on the SQL AS WRITTEN inside one
 * string literal, and it locates a statement's select list by finding the `FROM` after it. Folding
 * `FROM ai_usage` into this helper took three money aggregates — the two here and admin instance
 * detail's pair — out of that scanner's sight entirely: they kept summing dollars and stopped being
 * asked to say whether the number is a charge or notional value. Leaving the six characters at the
 * call site is what keeps them under the ratchet, and `usage-aggregates.test.ts` counts them.
 *
 * The `ai_usage` alias is `u`, matching `usageRowsSql`. Columns unique to `ai_usage`
 * (`cost_micros`, `payer`, the token columns) are left unqualified so they read the same as
 * before; `id`, `user_id`, `agent_id`, `instance_id` and `created_at` exist on both tables and
 * MUST be written `u.<col>`.
 */
export function usageInstanceScopeSql(userParam: string, instanceParam: string): string {
	return `LEFT JOIN agent_instances ia ON ia.id = u.instance_id AND ia.user_id = u.user_id
	 LEFT JOIN agent_instances ub ON ub.id = u.agent_id    AND ub.user_id = u.user_id
	 WHERE u.user_id = ${userParam} AND COALESCE(ia.id, ub.id) = ${instanceParam}`;
}

/** The instances a Usage response may need to name. Small, and read apart from the row scan:
 *  a display name lives inside the `config` blob, and dragging that onto thousands of ledger rows
 *  to read one field would dominate the response — while `json_extract` RAISES on malformed JSON,
 *  turning one bad config into a 500 for the whole page. `instanceListView` parses defensively. */
export const USAGE_INSTANCE_NAMES_SQL = `SELECT i.id, i.config, a.name AS agent_name
	   FROM agent_instances i LEFT JOIN agents a ON a.id = i.agent_id
	  WHERE i.user_id = ?1`;

/**
 * Label a bucket keyed by an id, and say so when the id resolves to nothing.
 *
 * The third case is the one worth having a function for. An id that names no row is a PERMANENT
 * state, not a missing lookup: `ai_usage` rows outlive the agent or instance they belong to on
 * purpose (they are the spend record — `routes/analytics.ts`), so deleting an agent leaves its
 * spend behind with nothing left to name it. Rendering the raw UUID there — which is what the page
 * did for 26 rows — reads as a bug in the page rather than as a fact about the account, and
 * folding it into "Unassigned" would be worse still: that key already means something else
 * (the row carried no id at all).
 *
 * The short id is kept because two deleted things must not merge into one row on screen.
 */
export function bucketLabel(key: string, names: Record<string, string> | undefined, unassigned: string): string {
	if (key === UNASSIGNED_KEY) return unassigned;
	return names?.[key] || `Deleted · ${key.slice(0, 8)}`;
}

/**
 * Display names for a user's instances, disambiguated.
 *
 * An instance shows the subscriber's own `config.displayName` when they set one, and the template's
 * name otherwise — which is exactly how the console names it, and exactly why the Usage page cannot
 * use the raw fallback: an owner with seven un-renamed Repo Coders would get seven rows all called
 * "Repo Coder", reproducing the collapse this axis exists to undo, only now with the rows split.
 * So a label that would appear more than once carries a short id, and one that is already unique
 * does not — a rename is the fix, and the page should not punish someone who has already done it.
 */
export function instanceLabels(
	instances: readonly { id: string; displayName?: string | null; agentName?: string | null }[],
): Record<string, string> {
	const base = new Map<string, string>();
	const seen = new Map<string, number>();
	for (const i of instances) {
		const label = (i.displayName || i.agentName || "").trim() || `Instance ${i.id.slice(0, 8)}`;
		base.set(i.id, label);
		seen.set(label, (seen.get(label) ?? 0) + 1);
	}
	const out: Record<string, string> = {};
	for (const [id, label] of base) out[id] = (seen.get(label) ?? 0) > 1 ? `${label} · ${id.slice(0, 8)}` : label;
	return out;
}
