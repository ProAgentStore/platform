/** GET /v1/errors — read back the durable error log (see lib/error-log.ts). */
import { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { listErrors } from "../lib/error-log.js";
import type { Env } from "../types.js";

export const errorRoutes = new Hono<{ Bindings: Env }>();

/**
 * Your recent errors. `?scope=all` returns everyone's (admin only — silently
 * scoped back to just you if you're not an admin). `?source=` and `?limit=` filter.
 */
errorRoutes.get("/", async (c) => {
	const session = await requireUser(c);
	const all = c.req.query("scope") === "all" && session.roles.includes("admin");
	const source = c.req.query("source") || undefined;
	const limit = Number(c.req.query("limit")) || 100;
	const errors = await listErrors(c.env, { userId: session.uid, all, source, limit });
	return c.json({ scope: all ? "all" : "me", count: errors.length, errors });
});
