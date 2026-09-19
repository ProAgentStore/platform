/** GET /v1/errors — read back the durable error log (see lib/error-log.ts). */
import { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { ERROR_COLUMNS, ERROR_RECENCY, deriveClientLevel, listErrors, logError, sanitizeBuildId } from "../lib/error-log.js";
import { summarizeErrors, type RawError } from "../lib/admin-errors.js";
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
	const source = `client:${rawSource}`.slice(0, 64);
	const status = typeof body.status === "number" ? body.status : undefined;
	await logError(c.env, {
		source,
		userId: session?.uid ?? null,
		status,
		// Severity is derived here rather than trusted from the browser: a reported 4xx is a wall
		// the user hit (diagnostic, not a bug), while a network failure or a thrown component
		// carries no status and is a real error. Letting the client name its own level would make
		// the field meaningless the first time a caller passed the wrong one.
		//
		// That reasoning is intact and is now stated once, in `deriveClientLevel`, together with the
		// third case it was silent about (#571): telemetry that carries no status and is not a
		// failure at all. A statusless report from a source the SERVER has declared observational —
		// a voice gate discarding a turn it was built to discard — is a `warn`, so `?level=error`
		// answers "bugs only" again. The client still cannot name its own level; it names only where
		// it is reporting from, and the server owns what that name means.
		level: deriveClientLevel(source, status),
		// The bundle that reported it (#539). Trusted the way a User-Agent is: it identifies the
		// build for a diagnosis, it authorizes nothing, and it is narrowed to a build id's shape
		// before it reaches the collapse key. Absent = a bundle that predates this field.
		build: sanitizeBuildId(body.build),
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

/**
 * The same failures, GROUPED BY SIGNATURE — what is recurring, rather than what happened last
 * (#823).
 *
 * ## Why the flat feed could not answer this
 *
 * The write side collapses an identical repeat into a counter, but its bucket is capped at one
 * hour (`COLLAPSE_WINDOW_MS`, and `collapseRepeat` matches on `created_at >= now - 1h`). That is
 * the right bound for a write-side dedupe — a bucket that never closes could not be aged out, and
 * its `context` sample would be arbitrarily stale — but it means a warning that has been firing
 * for three days is ~72 rows, not one. #823 was filed after exactly that: a commit-close-watch
 * warning repeating for days across two repos, described as "buried as one row per hour".
 *
 * So the cross-hour question is a READ-side one, and it already had an answer —
 * `summarizeErrors` — which only admins could reach (`routes/admin.ts`). This is that grouping,
 * scoped to the caller's own rows. Reused rather than reimplemented deliberately: a second
 * normalizer would be a second set of rules for which failures are "the same", and the two would
 * drift the first time either was tuned.
 *
 * ## `limit` is 2000 rows, not 100
 *
 * It bounds the ROWS READ, and a signature's `count` sums the occurrences inside them. The flat
 * feed's 100 is a page size; here it is the width of the window being grouped, and at ~24 rows a
 * day per recurring signature a 100-row window would show four days of one warning and call it
 * the whole picture. 2000 matches what the admin view reads, and it is bounded per account
 * because every row here is the caller's own.
 *
 * `days` bounds it in TIME as well, because rows-read and days-covered are different questions and
 * a caller asking "what has been wrong this week" should not get an answer whose horizon depends
 * on how noisy the account was.
 */
errorRoutes.get("/summary", async (c) => {
	const session = await requireUser(c);
	const days = Math.max(1, Math.min(Number(c.req.query("days")) || 7, 30));
	const limit = Math.max(1, Math.min(Number(c.req.query("limit")) || 2000, 5000));
	const source = c.req.query("source") || undefined;
	const level = c.req.query("level") === "warn" ? "warn" : c.req.query("level") === "error" ? "error" : undefined;
	const instanceId = c.req.query("instance_id") || undefined;

	// Always user-scoped — there is no `scope=all` here. The flat feed offers one to admins; a
	// grouped cross-account view already exists on the admin route, and quietly widening this one
	// would mean an owner's page changing meaning based on who is signed in.
	const where = ["user_id = ?1", `${ERROR_RECENCY} >= ?2`];
	const binds: unknown[] = [session.uid, new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ")];
	if (source) {
		binds.push(source);
		where.push(`source = ?${binds.length}`);
	}
	if (level) {
		binds.push(level);
		where.push(`level = ?${binds.length}`);
	}
	if (instanceId) {
		// The instance rides in the free-form `context` JSON, not in a column — ~25 call sites put
		// it there and nothing ever indexed it. `json_extract` over a user-scoped window of at most
		// a few thousand rows is the right cost for this; a generated column would be the answer if
		// this ever had to run unscoped.
		//
		// BOTH retained samples are checked. A collapsed bucket keeps the first occurrence's
		// context and the latest one's (#538), and `instanceId` is not part of the collapse
		// identity — so a row whose FIRST sample names another instance can still be a row this
		// instance is in, and matching only `context` would hide it.
		//
		// Each extract is wrapped in a CASE on `json_valid`, and that is not belt-and-braces.
		// `json_extract` ERRORS on malformed text rather than returning null, and SQLite does not
		// guarantee it will evaluate a `json_valid(...) AND json_extract(...)` conjunction in the
		// written order — so a sibling guard in the same WHERE does not protect it. Measured: one
		// row whose context read `not json at all` failed the ENTIRE query, on precisely the page
		// whose job is to show you malformed rows. CASE fixes the evaluation order by definition.
		binds.push(instanceId);
		const n = binds.length;
		where.push(
			`?${n} IN (` +
				`CASE WHEN json_valid(context) THEN json_extract(context, '$.instanceId') END, ` +
				`CASE WHEN json_valid(context) THEN json_extract(context, '$.instance_id') END, ` +
				`CASE WHEN json_valid(last_context) THEN json_extract(last_context, '$.instanceId') END, ` +
				`CASE WHEN json_valid(last_context) THEN json_extract(last_context, '$.instance_id') END)`,
		);
	}
	const sql = `SELECT ${ERROR_COLUMNS} FROM error_log WHERE ${where.join(" AND ")} ORDER BY ${ERROR_RECENCY} DESC LIMIT ${limit}`;
	const rows = (await c.env.DB.prepare(sql).bind(...binds).all<RawError>()).results ?? [];
	const signatures = summarizeErrors(rows);
	return c.json({
		days,
		// OCCURRENCES, not rows — a row standing for 60 collapsed repeats counts 60. Reporting the
		// row count would understate a runaway by exactly the factor the collapse achieved.
		total: signatures.reduce((n, s) => n + s.count, 0),
		rows: rows.length,
		// True when the window was filled: the answer is a floor, not a total, and a page that
		// did not say so would present a truncated week as a complete one.
		truncated: rows.length >= limit,
		signatures,
	});
});
