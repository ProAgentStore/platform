import { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { aggregateUsage, type UsageRow } from "../lib/usage.js";
import { unmeteredUsageSummary } from "../lib/engine-metering.js";
import type { Env } from "../types.js";

/**
 * Usage transparency — token usage + estimated value across ALL the user's agents,
 * broken down by model, modality (chat/apply/coding/…), agent, and PAYER, over time.
 *
 * Every cost figure here is an estimate at published list prices (tokens × list rate; see
 * lib/ai-pricing.ts), including the coding-engine rows: Claude Code computes its own figure the
 * same way and Anthropic's docs say so explicitly (#347). We never see any provider's bill.
 *
 * `payer` (migration 0092) is the axis that says whether a figure is money at all, and it is
 * returned unaggregated with the rest so the page can show consumption and charge as two numbers
 * rather than implying the total is a bill. History begins when the ledger shipped (no backfill).
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
		        u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens,
		        u.cost_micros, u.payer, u.created_at, a.name AS agent_name
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

	// What the figures above LEAVE OUT, as a measured quantity rather than a silence (#348).
	// A CLI driven through the terminal connector writes no ledger row, so without this the page
	// reports a total that is complete-looking and short. `windowDays` is returned because the
	// trace prunes at 14 days: the count can cover less than the dollars beside it, and the page
	// says which rather than implying they match.
	const unmetered = await unmeteredUsageSummary(c.env, session.uid, { rangeDays: days ?? undefined });

	return c.json({ range, ...summary, unmetered });
});
