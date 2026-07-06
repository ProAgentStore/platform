/** GET /v1/errors — read back the durable error log (see lib/error-log.ts). */
import { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { listErrors, logError } from "../lib/error-log.js";
import type { Env } from "../types.js";

export const errorRoutes = new Hono<{ Bindings: Env }>();

/**
 * Report a CLIENT-side failure into the durable log — the browser can't otherwise
 * be seen server-side. Source is prefixed `client:` so it's distinguishable from
 * server hotspots. Rate-limited by the global limiter; the reporter dedupes too.
 */
errorRoutes.post("/client", async (c) => {
	const session = await requireUser(c);
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const message = typeof body.message === "string" ? body.message : "";
	if (!message.trim()) return c.json({ ok: false, error: "message required" }, 400);
	const rawSource = typeof body.source === "string" ? body.source : "app";
	await logError(c.env, {
		source: `client:${rawSource}`.slice(0, 64),
		userId: session.uid,
		status: typeof body.status === "number" ? body.status : undefined,
		message,
		context: body.context && typeof body.context === "object" ? (body.context as Record<string, unknown>) : undefined,
	});
	return c.json({ ok: true });
});

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
