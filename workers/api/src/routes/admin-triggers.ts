import { Hono } from "hono";
import { requireAdmin } from "../lib/auth.js";
import type { Env } from "../types.js";

/**
 * Admin/operator visibility for instance triggers (webhook + cron) across ALL
 * tenants. Read-only. Mount at /v1/admin so the final URL is /v1/admin/triggers;
 * the admin ROLE is enforced per-handler (requireAdmin) and the network perimeter
 * (Cloudflare Access) is applied as middleware on /v1/admin/* in index.ts.
 *
 * SECURITY: the webhook `secret_token` is a high-entropy capability path token
 * (anyone holding it can POST to the public webhook). It is NEVER returned here —
 * we expose only a boolean `hasSecret` so the operator can see a webhook trigger
 * is wired without leaking the token. Schedule/action/config are non-secret.
 */
export const adminTriggersRoutes = new Hono<{ Bindings: Env }>();

interface AdminTriggerRow {
	id: string;
	instance_id: string;
	agent_id: string;
	name: string;
	type: string;
	action: string;
	enabled: number;
	has_secret: number;
	schedule: string | null;
	last_run_at: string | null;
	next_run_at: string | null;
	failure_count: number;
	created_at: string;
	owner_login: string | null;
	agent_name: string | null;
}

/**
 * GET /v1/admin/triggers — every instance trigger across every tenant, newest
 * first, capped at 200. Joins the owner's github_login and the agent name.
 * No secret token is returned (only whether one exists).
 */
adminTriggersRoutes.get("/triggers", async (c) => {
	await requireAdmin(c);
	const { results } = await c.env.DB.prepare(
		`SELECT t.id, t.instance_id, t.agent_id, t.name, t.type, t.action, t.enabled,
		        CASE WHEN t.secret_token IS NOT NULL AND t.secret_token != '' THEN 1 ELSE 0 END AS has_secret,
		        t.schedule, t.last_run_at, t.next_run_at, t.failure_count, t.created_at,
		        u.github_login AS owner_login, a.name AS agent_name
		 FROM agent_triggers t
		 LEFT JOIN users u ON u.id = t.user_id
		 LEFT JOIN agents a ON a.id = t.agent_id
		 ORDER BY t.created_at DESC
		 LIMIT 200`,
	).all<AdminTriggerRow>();
	const triggers = (results ?? []).map((t) => ({
		id: t.id,
		instanceId: t.instance_id,
		agentId: t.agent_id,
		agentName: t.agent_name,
		ownerLogin: t.owner_login,
		name: t.name,
		type: t.type,
		action: t.action,
		enabled: t.enabled === 1,
		hasSecret: t.has_secret === 1,
		schedule: t.schedule,
		lastRunAt: t.last_run_at,
		nextRunAt: t.next_run_at,
		failureCount: t.failure_count,
		createdAt: t.created_at,
	}));
	return c.json({ count: triggers.length, triggers });
});
