import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { readFunnelCounts } from "../lib/store-funnel.js";
import type { Env } from "../types.js";

export const analyticsRoutes = new Hono<{ Bindings: Env }>();

/**
 * The rows of the AI ledger (`ai_usage`, migration 0048) that belong to one agent — binds `?1`
 * to the agent's UUID. Shared with `routes/agents.ts`'s `/:id/ops` so the two surfaces cannot
 * drift into meaning different things by the word "execution" (#451).
 *
 * ── Why not `agent_executions`
 *
 * Both counters here read `agent_executions` until #451, and both were structurally zero. That
 * table has exactly ONE writer in the whole API — `routes/run.ts:98`, the legacy direct-Workers-AI
 * route from `0001_init.sql` — and nothing built since goes through it: not `AgentDO` chat, not the
 * apply workflow, not the coding Pilot, not pipelines, not connector tools, not triggers. Measured
 * in production on 2026-08-08: `agent_executions` held **0 rows in the entire database**, against
 * 3,628 in `ai_usage` and 124 in `pipeline_runs`. A creator was being told, precisely and falsely,
 * that an agent with 27 chats and 13 pipeline runs had never done anything.
 *
 * Backfilling `agent_executions` from the five modern paths was rejected on the ticket: it means
 * five new request-path INSERTs into a duplicate of `ai_usage`'s own columns, which is how two
 * ledgers get to disagree about spend — the failure `ai_usage` (#267) was built to end.
 *
 * ── Why the second arm exists
 *
 * `ai_usage.agent_id` is nullable — "some paths only know the instance" (0048) — so a bare
 * `WHERE agent_id = ?1` under-reports badly. Measured over the same 3,628 rows: only **506 (14%)**
 * carry a non-null `agent_id`; **2,091** carry only an `instance_id`, and all 2,091 resolve against
 * `agent_instances` with zero orphans. Resolving instance → template takes the view from 14% to
 * **72%**, so the fallback is the difference between a partial number and a complete one, not a
 * nicety. It is cheap: `idx_instances_agent` (0002) serves the subquery, and 0109 adds
 * `(agent_id, created_at)` so the first arm is not a table scan.
 *
 * ── What it still misses, deliberately
 *
 * The remaining **1,031** rows carry neither id, and every single one of them is `kind = 'voice'`
 * — voice goes through an account-scoped proxy, so it is account-level by nature, not agent-level.
 * Attribution is therefore complete for every non-voice kind. This under-reports rather than
 * over-reports, which is the right direction: a truthful undercount beats a structural zero.
 *
 * No `kind` allowlist. 0048's comment lists nine kinds; production already contains three more
 * (`embedding`, `pipeline`, `summary`). Filtering to a known list would silently drop every kind
 * added after this line was written — the same structural-zero bug one layer down.
 *
 * ── Retention differs from what it replaced, on purpose
 *
 * Deleting an agent drops its `agent_executions` rows (`agents.ts`, `batch.ts`,
 * `admin-moderation.ts`); `ai_usage` rows survive, because they are the spend record. Both
 * readers are owner-scoped on an agent that must still exist, so nothing reads the survivors.
 */
export const AI_LEDGER_FOR_AGENT = `FROM ai_usage
     WHERE agent_id = ?1
        OR instance_id IN (SELECT id FROM agent_instances WHERE agent_id = ?1)`;

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

	// AI calls: every model call the ledger attributes to this agent. See AI_LEDGER_FOR_AGENT for
	// why this is not `agent_executions` and what the number does and does not cover. The response
	// key keeps its old name because `store/agents/detail.html` and `store/openapi.yaml` read it;
	// the CONSOLE label is what changed to say what it counts ("AI Calls", not "Executions").
	const calls = await c.env.DB.prepare(
		`SELECT COUNT(*) as count ${AI_LEDGER_FOR_AGENT}`,
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

	// Recent AI calls, same source as the count above. `duration_ms` is GONE rather than nulled:
	// the ledger does not record duration, and nothing rendered the column — no reader in
	// `store/console` or `store/agents` ever touched `recentExecutions`. `kind` replaces it, which
	// is the field that actually distinguishes one row from the next (chat vs coding vs pipeline).
	const recent = await c.env.DB.prepare(
		`SELECT id, model, kind, created_at ${AI_LEDGER_FOR_AGENT}
     ORDER BY created_at DESC LIMIT 10`,
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
		totalExecutions: calls?.count || 0,
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
