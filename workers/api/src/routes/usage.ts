import { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { aggregateUsage, type UsageRow } from "../lib/usage.js";
import type { Env } from "../types.js";

/**
 * Usage transparency — token usage + estimated cost across ALL the user's agents,
 * broken down by model, modality (chat/apply/coding/…), and agent, over time.
 * Cost is a BYOK ESTIMATE (tokens × published list price; see lib/ai-pricing.ts) —
 * we never see the real provider bill. History begins when the ledger shipped (no
 * backfill). Data source: the `ai_usage` ledger written at the AI choke point.
 */
export const usageRoutes = new Hono<{ Bindings: Env }>();

interface JoinedRow extends UsageRow {
	agent_name: string | null;
}

const RANGE_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };

/** UTC "YYYY-MM-DD" for `daysAgo` days before today (0 = today). */
function dayUtc(daysAgo: number): string {
	const t = Date.now() - daysAgo * 86_400_000;
	return new Date(t).toISOString().slice(0, 10);
}

usageRoutes.get("/", async (c) => {
	const session = await requireUser(c);
	const range = c.req.query("range") || "30d";
	const days = RANGE_DAYS[range]; // undefined for "all"

	// Resolve each row's effective agent (chat rows carry only instance_id → look up
	// the instance's template) and the agent's display name, in one query.
	const where = days ? "AND u.created_at >= ?2" : "";
	const stmt = c.env.DB.prepare(
		`SELECT COALESCE(u.agent_id, i.agent_id) AS agent_id, u.instance_id, u.provider, u.model, u.kind,
		        u.input_tokens, u.output_tokens, u.cost_micros, u.created_at, a.name AS agent_name
		 FROM ai_usage u
		 LEFT JOIN agent_instances i ON i.id = u.instance_id
		 LEFT JOIN agents a ON a.id = COALESCE(u.agent_id, i.agent_id)
		 WHERE u.user_id = ?1 ${where}
		 ORDER BY u.created_at ASC`,
	);
	const bound = days ? stmt.bind(session.uid, `${dayUtc(days - 1)} 00:00:00`) : stmt.bind(session.uid);
	const rows = (await bound.all<JoinedRow>()).results ?? [];

	const agentNames: Record<string, string> = {};
	for (const r of rows) {
		if (r.agent_id && r.agent_name) agentNames[r.agent_id] = r.agent_name;
	}

	const summary = aggregateUsage(
		rows,
		days ? { fromDay: dayUtc(days - 1), toDay: dayUtc(0), agentNames } : { agentNames },
	);

	return c.json({ range, ...summary });
});
