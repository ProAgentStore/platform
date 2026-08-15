import { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { aggregateUsage, type UsageRow } from "../lib/usage.js";
import { instanceLabels, usageRowsSql, USAGE_INSTANCE_NAMES_SQL } from "../lib/usage-ids.js";
import { instanceListView } from "../lib/instance-config.js";
import { unmeteredUsageSummary } from "../lib/engine-metering.js";
import type { Env } from "../types.js";

/**
 * Usage transparency — token usage + estimated value across ALL the user's agents,
 * broken down by model, modality (chat/apply/coding/…), agent, INSTANCE, and PAYER, over time.
 *
 * Agent and instance are different questions and the page needs both (#526): the agent is the
 * template a creator published, the instance is the copy this owner subscribed to and named. Seven
 * Repo Coders on seven repositories are one agent and seven instances, and "what did Chess coder 2
 * cost me" is only answerable on the second axis.
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

	// Both the agent and the instance are resolved BY LOOKUP, never by trusting which column an id
	// arrived in — see `usageRowsSql`, which is executed by a test because that is the only way to
	// prove which join wins.
	const stmt = c.env.DB.prepare(usageRowsSql(Boolean(days)));
	const bound = days ? stmt.bind(session.uid, `${dayUtc(days - 1)} 00:00:00`) : stmt.bind(session.uid);
	const rows = (await bound.all<JoinedRow>()).results ?? [];

	const agentNames: Record<string, string> = {};
	for (const r of rows) {
		if (r.agent_id && r.agent_name) agentNames[r.agent_id] = r.agent_name;
	}

	const instRows = (await c.env.DB.prepare(USAGE_INSTANCE_NAMES_SQL)
		.bind(session.uid)
		.all<{ id: string; config: string | null; agent_name: string | null }>()).results ?? [];
	const instanceNames = instanceLabels(
		instRows.map((r) => ({ id: r.id, displayName: instanceListView(r.config).displayName, agentName: r.agent_name })),
	);

	const summary = aggregateUsage(rows, {
		...(days ? { fromDay: dayUtc(days - 1), toDay: dayUtc(0) } : {}),
		agentNames,
		instanceNames,
	});

	// What the figures above LEAVE OUT, as a measured quantity rather than a silence (#348).
	// A CLI driven through the terminal connector writes no ledger row, so without this the page
	// reports a total that is complete-looking and short. `windowDays` is returned because the
	// trace prunes at 14 days: the count can cover less than the dollars beside it, and the page
	// says which rather than implying they match.
	const unmetered = await unmeteredUsageSummary(c.env, session.uid, { rangeDays: days ?? undefined });

	// This literal IS the declared wire shape (#608): `UsageResponse` in lib/usage-shape.ts, which
	// `store/console/src/pages/Usage.tsx` imports instead of declaring its own guess. Two tests read
	// this line rather than a copy of it — `usage-shape.test.ts` asserts the keys equal the type's,
	// and the MCP contract test asserts the `usage_summary` description documents every one — so it
	// is deliberately left as a plain object literal that both can parse.
	return c.json({ range, ...summary, unmetered });
});
