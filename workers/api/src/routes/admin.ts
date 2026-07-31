import { Hono } from "hono";
import { isAdmin, requireAdmin, requireUser } from "../lib/auth.js";
import { listAdminAudit } from "../lib/admin.js";
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
 * IMPORTANT: platform-paid AI (embeddings / summaries / translation run on the
 * platform's Workers AI when PLATFORM_AI_ENABLED) is NOT fully metered into the
 * ledger yet — only rows tagged provider="platform" are counted. Until the
 * write-path metering + Cloudflare billing-actuals integration land (see the
 * follow-up issues), `platformPaid.metered` is false and the authoritative number
 * for platform Workers-AI spend is the Cloudflare dashboard. `platformAiEnabled`
 * reports whether the platform is currently allowed to pay for internal AI.
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
			metered: false,
			note: "Platform-paid Workers AI (embeddings/summaries/translation) is not yet fully metered into the ledger; see the CF dashboard for authoritative neuron spend.",
		},
	});
});
