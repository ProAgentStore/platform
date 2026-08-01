import { Hono } from "hono";
import { HttpError, isAdmin, requireAdmin, requireUser } from "../lib/auth.js";
import { getOverviewStats, getUserDetail, listAdminAudit, listAgents, listInstances, listUsers } from "../lib/admin.js";
import { listErrors } from "../lib/error-log.js";
import { aggregateAdminUsage, type AdminUsageRow } from "../lib/usage.js";
import type { Env } from "../types.js";

/** UTC "YYYY-MM-DD" for `daysAgo` days before today (0 = today). */
function dayUtc(daysAgo: number): string {
	return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

interface AdminJoinedRow extends AdminUsageRow {
	agent_name: string | null;
	user_login: string | null;
}

/**
 * Pull cross-user ledger rows for the window and roll them up. Shared by
 * /usage and /spending. `days` undefined = all-time.
 */
async function loadAdminUsage(env: Env, days: number | undefined) {
	const where = days ? "WHERE u.created_at >= ?1" : "";
	const stmt = env.DB.prepare(
		`SELECT u.user_id, COALESCE(u.agent_id, i.agent_id) AS agent_id, u.instance_id,
		        u.provider, u.model, u.kind, u.input_tokens, u.output_tokens, u.cost_micros, u.created_at,
		        a.name AS agent_name, us.github_login AS user_login
		 FROM ai_usage u
		 LEFT JOIN agent_instances i ON i.id = u.instance_id
		 LEFT JOIN agents a ON a.id = COALESCE(u.agent_id, i.agent_id)
		 LEFT JOIN users us ON us.id = u.user_id
		 ${where}
		 ORDER BY u.created_at ASC`,
	);
	const bound = days ? stmt.bind(`${dayUtc(days - 1)} 00:00:00`) : stmt;
	const rows = (await bound.all<AdminJoinedRow>()).results ?? [];
	const agentNames: Record<string, string> = {};
	const userNames: Record<string, string> = {};
	for (const r of rows) {
		if (r.agent_id && r.agent_name) agentNames[r.agent_id] = r.agent_name;
		if (r.user_id && r.user_login) userNames[r.user_id] = r.user_login;
	}
	return aggregateAdminUsage(
		rows,
		days ? { fromDay: dayUtc(days - 1), toDay: dayUtc(0), agentNames, userNames } : { agentNames, userNames },
	);
}

const RANGE_DAYS: Record<string, number | undefined> = { "7d": 7, "30d": 30, "90d": 90, all: undefined };

/**
 * Admin/operator portal API (epic: PAGS Admin Portal). Every route here is behind
 * the admin gate. The network perimeter (Cloudflare Access) is applied as
 * middleware on /v1/admin/* in index.ts (defense-in-depth); these handlers enforce
 * the admin ROLE. This file is the foundation (issue #28): the is-admin probe and
 * the audit-log reader. Feature endpoints (users, agents, usage, moderation) mount
 * here in later issues.
 */
export const adminRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /v1/admin/me — lightweight probe the admin UI calls on load to decide whether
 * to mount the portal. Behind requireUser (NOT requireAdmin) so a non-admin gets
 * `{ admin: false }` instead of a 403 the UI would have to special-case.
 */
adminRoutes.get("/me", async (c) => {
	const session = await requireUser(c);
	return c.json({ admin: await isAdmin(c, session) });
});

/**
 * GET /v1/admin/audit — read back the admin-action audit log (newest first).
 * Filters: ?actor= ?action= ?target= ?limit=
 */
adminRoutes.get("/audit", async (c) => {
	await requireAdmin(c);
	const rows = await listAdminAudit(c.env, {
		actor: c.req.query("actor") || undefined,
		action: c.req.query("action") || undefined,
		targetId: c.req.query("target") || undefined,
		limit: Number(c.req.query("limit")) || undefined,
	});
	return c.json({ count: rows.length, audit: rows });
});

/** GET /v1/admin/overview — one-shot dashboard counts (users/agents/instances/errors/spend). */
adminRoutes.get("/overview", async (c) => {
	await requireAdmin(c);
	return c.json(await getOverviewStats(c.env));
});

/** GET /v1/admin/agents?search=&limit=&offset= — all agents (incl. drafts) + owner + instance count. */
adminRoutes.get("/agents", async (c) => {
	await requireAdmin(c);
	return c.json(await listAgents(c.env, {
		search: c.req.query("search") || undefined,
		limit: Number(c.req.query("limit")) || undefined,
		offset: Number(c.req.query("offset")) || undefined,
	}));
});

/** GET /v1/admin/instances?limit=&offset= — all subscriptions across tenants. */
adminRoutes.get("/instances", async (c) => {
	await requireAdmin(c);
	return c.json(await listInstances(c.env, {
		limit: Number(c.req.query("limit")) || undefined,
		offset: Number(c.req.query("offset")) || undefined,
	}));
});

/** GET /v1/admin/errors?source=&limit= — cross-user error log (newest first). */
adminRoutes.get("/errors", async (c) => {
	await requireAdmin(c);
	const errors = await listErrors(c.env, {
		all: true,
		source: c.req.query("source") || undefined,
		limit: Number(c.req.query("limit")) || 100,
	});
	return c.json({ count: errors.length, errors });
});

/**
 * GET /v1/admin/users?search=&limit=&offset= — all users with rollup counts
 * (agents owned, active instances, key providers) + 30-day spend. No secrets.
 */
adminRoutes.get("/users", async (c) => {
	await requireAdmin(c);
	const result = await listUsers(c.env, {
		search: c.req.query("search") || undefined,
		limit: Number(c.req.query("limit")) || undefined,
		offset: Number(c.req.query("offset")) || undefined,
	});
	return c.json(result);
});

/** GET /v1/admin/users/:id — one user's profile, agents, instances, key providers, recent errors. */
adminRoutes.get("/users/:id", async (c) => {
	await requireAdmin(c);
	const detail = await getUserDetail(c.env, c.req.param("id"));
	if (!detail) throw new HttpError(404, "User not found");
	return c.json(detail);
});

/**
 * GET /v1/admin/usage?range=7d|30d|90d|all — cross-user usage + cost rolled up by
 * provider, model, kind, agent, user, and day, with a platform-paid vs BYOK split.
 * Cost is the same BYOK estimate as the per-user page (tokens × list price). See
 * /spending for the caveat on platform-paid metering.
 */
adminRoutes.get("/usage", async (c) => {
	await requireAdmin(c);
	const range = c.req.query("range") || "30d";
	const days = range in RANGE_DAYS ? RANGE_DAYS[range] : 30;
	const summary = await loadAdminUsage(c.env, days);
	return c.json({ range, ...summary });
});

/**
 * GET /v1/admin/spending?range=30d — the money view: BYOK spend (real, estimated
 * from tokens) + top spenders/models + trend, plus the platform-paid picture.
 *
 * Platform-paid AI (embeddings / summaries / translation on the platform's Workers
 * AI when PLATFORM_AI_ENABLED) IS now metered into the ledger as provider="platform"
 * (issue #44) — but cost is a ROUGH estimate: Cloudflare bills Workers AI per neuron
 * and we estimate from token counts (issue #45 wires the authoritative CF billing
 * actuals). So `platformPaid.metered` is true but `platformPaid.estimated` is also
 * true. Coverage is chat-time embeds/summaries + translation; background ingest
 * embeds aren't metered yet. `platformAiEnabled` reports whether the platform is
 * currently allowed to pay for internal AI.
 */
adminRoutes.get("/spending", async (c) => {
	await requireAdmin(c);
	const range = c.req.query("range") || "30d";
	const days = range in RANGE_DAYS ? RANGE_DAYS[range] : 30;
	const s = await loadAdminUsage(c.env, days);
	return c.json({
		range,
		totals: s.totals,
		daily: s.daily,
		byok: s.split.byok,
		topSpenders: s.byUser.slice(0, 10),
		topModels: s.byModel.slice(0, 10),
		platformAiEnabled: c.env.PLATFORM_AI_ENABLED === "true",
		platformPaid: {
			...s.split.platformPaid,
			metered: true,
			estimated: true,
			note: "Platform-paid Workers AI (chat embeddings/summaries + translation) is metered as provider=platform; cost is a rough token-based estimate (authoritative neuron spend = CF billing actuals, issue #45). Background ingest embeds not yet metered.",
		},
	});
});
