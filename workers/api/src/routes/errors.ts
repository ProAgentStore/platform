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
 *
 * ## Sign-in is NOT required (#424)
 *
 * It used to be, on both sides: the route called `requireUser` and the SDK reporter returned early
 * when it held no token, on the premise that "the log is per-user; nothing to attribute it to".
 * That premise was wrong — migration 0034 declares `user_id TEXT, -- nullable: some failures have
 * no user context`, and the server has always written null-user rows. The cost was that EVERY
 * sign-in, OAuth-callback and other pre-auth failure was invisible: precisely the class you cannot
 * debug from the user's side, because the user has no session to read their own errors with.
 *
 * An anonymous report writes `user_id = null` and cannot claim otherwise. It is bounded by
 * `rateLimitStrict` in `index.ts`, which buckets an unauthenticated caller by
 * `CF-Connecting-IP` at 10/min, by the 2000-character message cap in `logError`, by the
 * write-side repeat collapse, and by the 30-day retention sweep.
 */
errorRoutes.post("/client", async (c) => {
	// Optional session: a valid token attributes the row, an absent or expired one still logs.
	const session = await requireUser(c).catch(() => null);
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const message = typeof body.message === "string" ? body.message : "";
	if (!message.trim()) return c.json({ ok: false, error: "message required" }, 400);
	const rawSource = typeof body.source === "string" ? body.source : "app";
	const status = typeof body.status === "number" ? body.status : undefined;
	await logError(c.env, {
		source: `client:${rawSource}`.slice(0, 64),
		userId: session?.uid ?? null,
		status,
		// Severity is derived here rather than trusted from the browser: a reported 4xx is a wall
		// the user hit (diagnostic, not a bug), while a network failure or a thrown component
		// carries no status and is a real error. Letting the client name its own level would make
		// the field meaningless the first time a caller passed the wrong one.
		level: status !== undefined && status >= 400 && status < 500 ? "warn" : "error",
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
	// `?level=error` is how you ask for bugs only. Unfiltered is deliberately EVERYTHING: a warn
	// that is invisible by default is a warn nobody reads, which is the state #424 was filed about.
	const level = c.req.query("level") === "warn" ? "warn" : c.req.query("level") === "error" ? "error" : undefined;
	const errors = await listErrors(c.env, { userId: session.uid, all, source, limit, level });
	return c.json({ scope: all ? "all" : "me", count: errors.length, errors });
});
