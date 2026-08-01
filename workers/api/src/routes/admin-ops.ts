import { Hono } from "hono";
import { requireAdmin } from "../lib/auth.js";
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

const CAP = 50;

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
 *  - stuck/failed coding sessions (failed/needs_human/blocked, or active but idle >20m)
 *  - runner nodes registered but not seen in >5m (potentially offline)
 *  - users with an active instance but no stored API key
 *  - error_log volume in the last 24h
 */
adminOpsRoutes.get("/ops", async (c) => {
	await requireAdmin(c);

	// Stuck / failed coding sessions across all users. "active but stale" = no update
	// in ~20 min (a wedged engine); explicit bad statuses are always surfaced.
	const stuckSessions = (await c.env.DB.prepare(
		`SELECT s.id, s.instance_id, s.user_id, s.client_type, s.status, s.updated_at,
		        u.github_login AS owner_login
		 FROM coding_sessions s
		 LEFT JOIN users u ON u.id = s.user_id
		 WHERE s.status IN ('failed', 'needs_human', 'blocked')
		    OR (s.status = 'active' AND s.updated_at < datetime('now', '-20 minutes'))
		 ORDER BY s.updated_at DESC
		 LIMIT ?1`,
	).bind(CAP).all<StuckSession>()).results ?? [];

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
	const errRow = await c.env.DB.prepare(
		`SELECT COUNT(*) AS n FROM error_log WHERE created_at >= datetime('now', '-24 hours')`,
	).first<{ n: number }>();
	const errors24h = Number(errRow?.n ?? 0);

	return c.json({
		stuckSessions,
		staleRunners,
		noKeyUsers,
		errors24h,
	});
});
