import { Hono } from "hono";
import { isAdmin, requireAdmin, requireUser } from "../lib/auth.js";
import { listAdminAudit } from "../lib/admin.js";
import type { Env } from "../types.js";

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
