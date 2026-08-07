import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { readFunnelCounts } from "../lib/store-funnel.js";
import type { Env } from "../types.js";

export const analyticsRoutes = new Hono<{ Bindings: Env }>();

/** Get analytics for an agent you own. */
analyticsRoutes.get("/:id/analytics", async (c) => {
	const session = await requireUser(c);
	const id = c.req.param("id");

	// Verify ownership (accept ID or slug)
	const agent = await c.env.DB.prepare(
		"SELECT id, owner_id FROM agents WHERE id = ?1 OR slug = ?1",
	)
		.bind(id)
		.first<{ id: string; owner_id: string }>();
	if (!agent) throw new HttpError(404, "Agent not found");
	if (agent.owner_id !== session.uid && !session.roles.includes("admin")) {
		throw new HttpError(403, "Not your agent");
	}

	// Subscriber count
	const subs = await c.env.DB.prepare(
		`SELECT COUNT(*) as count FROM agent_instances WHERE agent_id = ?1 AND status = 'active'`,
	)
		.bind(agent.id)
		.first<{ count: number }>();

	// Total executions
	const execs = await c.env.DB.prepare(
		"SELECT COUNT(*) as count FROM agent_executions WHERE agent_id = ?1",
	)
		.bind(agent.id)
		.first<{ count: number }>();

	// Total chat messages (from usage table)
	const chats = await c.env.DB.prepare(
		`SELECT COUNT(*) as count FROM usage WHERE agent_id = ?1 AND event IN ('chat', 'instance_chat')`,
	)
		.bind(agent.id)
		.first<{ count: number }>();

	// Usage by day (last 30 days)
	const daily = await c.env.DB.prepare(
		`SELECT date(created_at) as day, COUNT(*) as count
     FROM usage WHERE agent_id = ?1 AND created_at >= datetime('now', '-30 days')
     GROUP BY day ORDER BY day`,
	)
		.bind(agent.id)
		.all<{ day: string; count: number }>();

	// Recent executions
	const recent = await c.env.DB.prepare(
		`SELECT id, model, duration_ms, created_at FROM agent_executions
     WHERE agent_id = ?1 ORDER BY created_at DESC LIMIT 10`,
	)
		.bind(agent.id)
		.all();

	// Funnel: views → trials → subscribes.
	//
	// The first two come from `agent_funnel_daily` (migration 0095), not `usage`. They were read
	// off `usage` until #383, where neither could ever be non-zero: nothing wrote `trial_start`,
	// and the `view` insert violated `usage.user_id`'s foreign key on every request. `subscribe`
	// stays where it is — it is an authenticated act by a known user, which is what `usage` is for.
	//
	// History starts at 0095: there is no backfill, because there is nothing to backfill from.
	const funnel = await readFunnelCounts(c.env, agent.id);

	const subscribes = await c.env.DB.prepare(
		"SELECT COUNT(*) as count FROM usage WHERE agent_id = ?1 AND event = 'subscribe'",
	).bind(agent.id).first<{ count: number }>();

	return c.json({
		subscribers: subs?.count || 0,
		totalExecutions: execs?.count || 0,
		totalChats: chats?.count || 0,
		dailyUsage: daily.results || [],
		recentExecutions: recent.results || [],
		funnel: {
			views: funnel.views,
			trials: funnel.trials,
			subscribes: subscribes?.count || 0,
		},
	});
});
