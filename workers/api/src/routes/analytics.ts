import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import type { Env } from "../types.js";

export const analyticsRoutes = new Hono<{ Bindings: Env }>();

/** Get analytics for an agent you own. */
analyticsRoutes.get("/:id/analytics", async (c) => {
	const session = await requireUser(c);
	const id = c.req.param("id");

	// Verify ownership
	const agent = await c.env.DB.prepare(
		"SELECT id, owner_id FROM agents WHERE id = ?1",
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
		.bind(id)
		.first<{ count: number }>();

	// Total executions
	const execs = await c.env.DB.prepare(
		"SELECT COUNT(*) as count FROM agent_executions WHERE agent_id = ?1",
	)
		.bind(id)
		.first<{ count: number }>();

	// Total chat messages (from usage table)
	const chats = await c.env.DB.prepare(
		`SELECT COUNT(*) as count FROM usage WHERE agent_id = ?1 AND event IN ('chat', 'instance_chat')`,
	)
		.bind(id)
		.first<{ count: number }>();

	// Usage by day (last 30 days)
	const daily = await c.env.DB.prepare(
		`SELECT date(created_at) as day, COUNT(*) as count
     FROM usage WHERE agent_id = ?1 AND created_at >= datetime('now', '-30 days')
     GROUP BY day ORDER BY day`,
	)
		.bind(id)
		.all<{ day: string; count: number }>();

	// Recent executions
	const recent = await c.env.DB.prepare(
		`SELECT id, model, duration_ms, created_at FROM agent_executions
     WHERE agent_id = ?1 ORDER BY created_at DESC LIMIT 10`,
	)
		.bind(id)
		.all();

	return c.json({
		subscribers: subs?.count || 0,
		totalExecutions: execs?.count || 0,
		totalChats: chats?.count || 0,
		dailyUsage: daily.results || [],
		recentExecutions: recent.results || [],
	});
});
