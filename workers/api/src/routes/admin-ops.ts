import { Hono } from "hono";
import { requireAdmin } from "../lib/auth.js";
import type { CodingSessionStatus } from "../lib/coding-types.js";
import type { Env } from "../types.js";

/**
 * Admin "Ops" queue (operator triage). A single "what's wrong right now" snapshot
 * across ALL users, mounted under /v1/admin (final URL /v1/admin/ops), behind the
 * same admin gate + Cloudflare Access perimeter as the rest of the portal.
 *
 * Deliberately read-only + capped: each list is bounded so a big fleet can't fan out
 * an unbounded response, and every query is parameterized. Datetime thresholds use
 * SQLite `datetime('now', ...)` so they compare against the TEXT `datetime('now')`
 * stamps the schema writes.
 */
export const adminOpsRoutes = new Hono<{ Bindings: Env }>();

/**
 * How many rows each list may return. Published to the client as `cap`, because a capped
 * list rendered as a count is a number that stops moving at exactly the point the fleet
 * gets interesting: 50 stuck sessions and 5,000 stuck sessions are the same "50" (#638).
 */
export const CAP = 50;

/**
 * The `coding_sessions.status` values that mean "this session failed and an operator should
 * look" — the explicit half of the stuck queue, alongside the derived "active but idle" half.
 *
 * ## Why this is a constant with a `satisfies`, and not three words typed into the SQL
 *
 * It WAS three words typed into the SQL — `IN ('failed', 'needs_human', 'blocked')` — and not
 * one of them is a member of `CodingSessionStatus` (`lib/coding-types.ts:23`), so that branch of
 * the filter could never match a row. Meanwhile `'error'`, the one failure status anything
 * writes (`lib/coding-session-open.ts:338` closes a session that can no longer do anything with
 * `endSession(..., "error")`), was the one value the query did not ask for. The panel therefore
 * answered "No stuck sessions. 🎉" for precisely the failure mode it was written to surface.
 *
 * `as const satisfies readonly CodingSessionStatus[]` makes the wrong fix a COMPILE error rather
 * than a silent no-op: putting `'failed'` back fails `tsc`. That is the #611 shape — an
 * unmatchable member of a `WHERE … IN` list behaves exactly like a matchable one that happens to
 * find nothing, so only the type can tell them apart.
 *
 * `'suspended'` is deliberately absent: it means another machine took the session over, the
 * history is preserved and `resumeSessionsForNode` reactivates it on reconnect. Nothing is stuck.
 * `'ended'` is the normal terminal state.
 */
export const STUCK_SESSION_STATUSES = ["error"] as const satisfies readonly CodingSessionStatus[];

interface StuckSession {
	id: string;
	instance_id: string;
	user_id: string;
	owner_login: string | null;
	client_type: string;
	status: string;
	updated_at: string;
}
interface StaleNode {
	instance_id: string;
	runner_node: string;
	user_id: string;
	owner_login: string | null;
	runner_version: string;
	status: string;
	last_seen_at: string | null;
}
interface NoKeyUser {
	id: string;
	github_login: string;
	github_name: string;
	active_instances: number;
}

/**
 * GET /v1/admin/ops — operator triage snapshot:
 *  - stuck/failed coding sessions (`error`, or active but idle >20m)
 *  - runner nodes registered but not seen in >5m (potentially offline)
 *  - users with an active instance but no stored API key
 *  - error_log volume in the last 24h
 *
 * Every list is capped at `CAP`, and `cap` is in the response so the client can say so.
 */
adminOpsRoutes.get("/ops", async (c) => {
	await requireAdmin(c);

	// Stuck / failed coding sessions across all users. "active but stale" = no update
	// in ~20 min (a wedged engine); explicit bad statuses are always surfaced.
	//
	// The status list is BUILT from `STUCK_SESSION_STATUSES` rather than written into the SQL,
	// so the type-level pin on that constant is the pin on this filter (#638).
	const stuckPlaceholders = STUCK_SESSION_STATUSES.map((_, i) => `?${i + 2}`).join(", ");
	const stuckSessions = (await c.env.DB.prepare(
		`SELECT s.id, s.instance_id, s.user_id, s.client_type, s.status, s.updated_at,
		        u.github_login AS owner_login
		 FROM coding_sessions s
		 LEFT JOIN users u ON u.id = s.user_id
		 WHERE s.status IN (${stuckPlaceholders})
		    OR (s.status = 'active' AND s.updated_at < datetime('now', '-20 minutes'))
		 ORDER BY s.updated_at DESC
		 LIMIT ?1`,
	).bind(CAP, ...STUCK_SESSION_STATUSES).all<StuckSession>()).results ?? [];

	// Runner nodes registered but stale (last_seen_at older than ~5 min → likely offline).
	// NULL last_seen_at (never reported) also counts as stale.
	const staleRunners = (await c.env.DB.prepare(
		`SELECT n.instance_id, n.runner_node, n.user_id, n.runner_version, n.status, n.last_seen_at,
		        u.github_login AS owner_login
		 FROM instance_runtime_nodes n
		 LEFT JOIN users u ON u.id = n.user_id
		 WHERE n.last_seen_at IS NULL OR n.last_seen_at < datetime('now', '-5 minutes')
		 ORDER BY n.last_seen_at ASC
		 LIMIT ?1`,
	).bind(CAP).all<StaleNode>()).results ?? [];

	// Users with an active instance but NO API key on file. Such a user can subscribe
	// but every BYOK call will fail — a common "why isn't my agent responding" cause.
	const noKeyUsers = (await c.env.DB.prepare(
		`SELECT u.id, u.github_login, u.github_name, COUNT(i.id) AS active_instances
		 FROM users u
		 JOIN agent_instances i ON i.user_id = u.id AND i.status = 'active'
		 WHERE NOT EXISTS (SELECT 1 FROM user_api_keys k WHERE k.user_id = u.id)
		 GROUP BY u.id
		 ORDER BY active_instances DESC
		 LIMIT ?1`,
	).bind(CAP).all<NoKeyUser>()).results ?? [];

	// Error-log volume in the last 24h (the spike signal).
	// Sum OCCURRENCES (repeat_count), not rows: the collapse that landed with #424 can absorb a
	// 1780-row flood into ~24 rows, so COUNT(*) understates by the collapse factor. Filter on
	// COALESCE(last_seen_at, created_at) — a bucket opened 25h ago that is still absorbing
	// failures this minute has a fresh `last_seen_at` and must be counted; `created_at` alone
	// would exclude it and the tile could read zero during a live outage (#648).
	const errRow = await c.env.DB.prepare(
		`SELECT COALESCE(SUM(COALESCE(repeat_count, 1)), 0) AS n FROM error_log WHERE COALESCE(last_seen_at, created_at) >= datetime('now', '-24 hours')`,
	).first<{ n: number }>();
	const errors24h = Number(errRow?.n ?? 0);

	return c.json({
		stuckSessions,
		staleRunners,
		noKeyUsers,
		errors24h,
		// The list length is a floor, not a count, once it reaches this. Publishing the cap is
		// what lets the client render "50+" instead of a "50" that means "at least 50" (#638).
		cap: CAP,
	});
});
