import { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import type { Env } from "../types.js";

export const dashboardRoutes = new Hono<{ Bindings: Env }>();

/** Client usage dashboard — how much AI a subscriber is consuming. */
dashboardRoutes.get("/usage", async (c) => {
	const session = await requireUser(c);

	// Total instances
	const instances = await c.env.DB.prepare(
		`SELECT COUNT(*) as count FROM agent_instances WHERE user_id = ?1 AND status = 'active'`,
	)
		.bind(session.uid)
		.first<{ count: number }>();

	// Total chat messages sent
	const chats = await c.env.DB.prepare(
		`SELECT COUNT(*) as count FROM usage WHERE user_id = ?1 AND event IN ('chat', 'instance_chat')`,
	)
		.bind(session.uid)
		.first<{ count: number }>();

	// Total executions
	const execs = await c.env.DB.prepare(
		"SELECT COUNT(*) as count FROM agent_executions WHERE user_id = ?1",
	)
		.bind(session.uid)
		.first<{ count: number }>();

	// Usage by day (last 30 days)
	const daily = await c.env.DB.prepare(
		`SELECT date(created_at) as day, COUNT(*) as count
     FROM usage WHERE user_id = ?1 AND created_at >= datetime('now', '-30 days')
     GROUP BY day ORDER BY day`,
	)
		.bind(session.uid)
		.all<{ day: string; count: number }>();

	// Usage by agent
	const byAgent = await c.env.DB.prepare(
		`SELECT u.agent_id, a.name, a.slug, COUNT(*) as count
     FROM usage u JOIN agents a ON a.id = u.agent_id
     WHERE u.user_id = ?1
     GROUP BY u.agent_id ORDER BY count DESC LIMIT 20`,
	)
		.bind(session.uid)
		.all();

	return c.json({
		activeInstances: instances?.count || 0,
		totalChats: chats?.count || 0,
		totalExecutions: execs?.count || 0,
		dailyUsage: daily.results || [],
		usageByAgent: byAgent.results || [],
	});
});

/** Creator dashboard — aggregate stats across all your agents. */
dashboardRoutes.get("/creator", async (c) => {
	const session = await requireUser(c);

	const agents = await c.env.DB.prepare(
		"SELECT COUNT(*) as count FROM agents WHERE owner_id = ?1",
	)
		.bind(session.uid)
		.first<{ count: number }>();

	const subscribers = await c.env.DB.prepare(
		`SELECT COUNT(*) as count FROM agent_instances i
     JOIN agents a ON a.id = i.agent_id
     WHERE a.owner_id = ?1 AND i.status = 'active'`,
	)
		.bind(session.uid)
		.first<{ count: number }>();

	const totalChats = await c.env.DB.prepare(
		`SELECT COUNT(*) as count FROM usage u
     JOIN agents a ON a.id = u.agent_id
     WHERE a.owner_id = ?1`,
	)
		.bind(session.uid)
		.first<{ count: number }>();

	const topAgents = await c.env.DB.prepare(
		`SELECT a.id, a.slug, a.name,
            (SELECT COUNT(*) FROM agent_instances WHERE agent_id = a.id AND status = 'active') as subscribers,
            (SELECT COUNT(*) FROM usage WHERE agent_id = a.id) as usage_count
     FROM agents a WHERE a.owner_id = ?1
     ORDER BY usage_count DESC`,
	)
		.bind(session.uid)
		.all();

	return c.json({
		totalAgents: agents?.count || 0,
		totalSubscribers: subscribers?.count || 0,
		totalUsage: totalChats?.count || 0,
		agents: topAgents.results || [],
	});
});
