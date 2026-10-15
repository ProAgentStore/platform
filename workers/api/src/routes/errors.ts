/** GET /v1/errors — read back the durable error log (see lib/error-log.ts). */
import { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { ERROR_COLUMNS, ERROR_RECENCY, deriveClientLevel, listErrors, listErrorsPage, logError, sanitizeBuildId, type ErrorFilter } from "../lib/error-log.js";
import { historyCoverage, parseHistoryCursor, parseTimeBound } from "../lib/history-page.js";
import { summarizeErrors, type RawError } from "../lib/admin-errors.js";
import { telemetryHealth } from "../lib/telemetry-spool.js";
import { clipMarked } from "../lib/clip-marked.js";
import { redactText } from "../lib/redact.js";
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
 *
 * ## The answer says whether it was KEPT (#1084)
 *
 * It answered `{ ok: true }` whatever `logError` did, so a report the database refused was
 * acknowledged as recorded. Now: 200 `durable: true` when the row is in the log; 202
 * `durable: false, queued: true` when the database refused it and it is spooled for the cron to
 * replay (accepted, not yet stored); 503 `durable: false` when it could not be kept anywhere — lost,
 * and counted in MCP `telemetry_health`.
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
	const written = await logError(c.env, {
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
		// The body is the caller's word (#1085): its instance counts only if this session owns it.
		untrusted: true,
	});
	if (written === "persisted") return c.json({ ok: true, durable: true });
	if (written === "queued") return c.json({ ok: true, durable: false, queued: true }, 202);
	return c.json({ ok: false, durable: false, error: "the report could not be stored" }, 503);
});

/** The crash kinds a runner or CLI may report (`packages/browser-runner/src/crash-reports.ts`). */
const RUNNER_CRASH_KINDS = new Set(["uncaught_exception", "unhandled_rejection", "startup_failure", "request_failure", "runner_exit", "connect_exit", "store_corrupt"]);
const REPORT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** Reports accepted per call — the CLI sends in batches of this size. */
export const RUNNER_CRASH_BATCH = 50;

/**
 * POST /v1/errors/runner-crashes — crash reports from the owner's own runner and CLI (#1087).
 *
 * The CLI delivers what the runtime and itself kept on disk, after an offline stretch or a restart
 * as well as live, so delivery is AT LEAST ONCE. Idempotent by report id: `runner_crash_reports`
 * (migration 0240) holds one receipt per (user, id), and only a report that is NEW here becomes an
 * `error_log` row (`source: "runner-crash"`) — read through MCP `list_errors`. A repeat answers
 * `accepted` again, so the CLI can forget it.
 *
 * Filed under the SIGNED-IN user — never an id from the body. An instance the report names is kept
 * only if that user owns it (`resolveErrorScope`). Message, stack, cause and output tail are masked
 * and clipped again here: the runner sanitized them, and this does not take its word for it.
 *
 * A report that could not be stored anywhere loses its receipt, so the CLI keeps it and re-sends.
 */
errorRoutes.post("/runner-crashes", async (c) => {
	const session = await requireUser(c);
	const body = (await c.req.json().catch(() => ({}))) as { reports?: unknown };
	if (!Array.isArray(body.reports)) return c.json({ error: "reports must be an array" }, 400);
	if (body.reports.length > RUNNER_CRASH_BATCH) return c.json({ error: `at most ${RUNNER_CRASH_BATCH} reports per call` }, 400);
	const accepted: string[] = [];
	const rejected: Array<{ id: string | null; reason: string }> = [];
	const text = (v: unknown, max: number) => (typeof v === "string" && v ? clipMarked(redactText(v), max) : undefined);
	for (const raw of body.reports as Array<Record<string, unknown>>) {
		const id = typeof raw?.id === "string" && REPORT_ID.test(raw.id) ? raw.id : null;
		const kind = typeof raw?.kind === "string" && RUNNER_CRASH_KINDS.has(raw.kind) ? raw.kind : null;
		if (!id || !kind || typeof raw.message !== "string") {
			rejected.push({ id, reason: "a report needs an id, a known kind and a message" });
			continue;
		}
		const receipt = await c.env.DB.prepare("INSERT OR IGNORE INTO runner_crash_reports (user_id, report_id) VALUES (?1, ?2)").bind(session.uid, id).run();
		if ((receipt.meta?.changes ?? 0) === 0) {
			accepted.push(id); // delivered before — the row already exists
			continue;
		}
		const idOf = (v: unknown) => (typeof v === "string" && REPORT_ID.test(v) ? v : undefined);
		const written = await logError(c.env, {
			source: "runner-crash",
			level: kind === "store_corrupt" ? "warn" : "error",
			userId: session.uid,
			message: text(`${kind}: ${raw.message}`, 1000) ?? kind,
			build: typeof raw.build === "string" ? raw.build : undefined,
			context: {
				crashId: id,
				kind,
				reporter: raw.source === "cli" ? "cli" : "runtime",
				at: typeof raw.at === "string" ? raw.at.substring(0, 40) : undefined,
				exitCode: typeof raw.exitCode === "number" ? raw.exitCode : undefined,
				signal: typeof raw.signal === "string" ? raw.signal.substring(0, 16) : undefined,
				route: text(raw.route, 200),
				instanceId: idOf(raw.instanceId),
				sessionId: idOf(raw.sessionId),
				taskId: idOf(raw.taskId),
				cause: text(raw.cause, 500),
				stack: text(raw.stack, 2000),
				tail: Array.isArray(raw.tail) ? raw.tail.slice(-10).map((l) => text(l, 200)) : undefined,
			},
		});
		if (written === "lost") {
			await c.env.DB.prepare("DELETE FROM runner_crash_reports WHERE user_id = ?1 AND report_id = ?2").bind(session.uid, id).run().catch(() => undefined);
			rejected.push({ id, reason: "could not be stored — send it again later" });
			continue;
		}
		accepted.push(id);
	}
	// Receipts age out with the rows they stand for (30 days, `error_log`'s retention). Opportunistic,
	// as that table's own prune is: no cron work for a table only this route writes.
	if (Math.random() < 0.02) {
		await c.env.DB.prepare("DELETE FROM runner_crash_reports WHERE received_at < datetime('now', '-30 days')").run().catch(() => undefined);
	}
	return c.json({ accepted, rejected });
});

/**
 * GET /v1/errors/telemetry-health — whether telemetry is reaching its stores (#1084): per sink
 * (`error_log`, `agent_events`, `admin_audit_log`, `mcp_audit`) what is spooled and waiting, what
 * replay gave up on, what was lost outright, and when the cron last drained. Platform-wide, so ADMIN
 * only (the same role `?scope=all` requires). Outside `/v1/admin/*` so the MCP Worker can reach it
 * from behind the Access perimeter; the role check is the gate. 503 when the spool cannot be read —
 * an unreadable spool is never reported as a healthy one.
 */
errorRoutes.get("/telemetry-health", async (c) => {
	const session = await requireUser(c);
	if (!session.roles.includes("admin")) return c.json({ error: "Admin only." }, 403);
	try {
		return c.json(await telemetryHealth(c.env));
	} catch (e) {
		return c.json({ error: `telemetry health could not be read: ${e instanceof Error ? e.message : String(e)}` }, 503);
	}
});

/**
 * Your recent errors. `?scope=all` returns everyone's (admin only — silently
 * scoped back to just you if you're not an admin). `?source=` and `?limit=` filter.
 */
errorRoutes.get("/", async (c) => {
	const session = await requireUser(c);
	const all = c.req.query("scope") === "all" && session.roles.includes("admin");
	const source = c.req.query("source") || undefined;
	const limit = Math.max(1, Math.min(Number(c.req.query("limit")) || 100, 500));
	const offset = Math.max(0, Math.trunc(Number(c.req.query("offset")) || 0));
	// `?level=error` is how you ask for bugs only. Unfiltered is deliberately EVERYTHING: a warn
	// that is invisible by default is a warn nobody reads, which is the state #424 was filed about.
	const level = c.req.query("level") === "warn" ? "warn" : c.req.query("level") === "error" ? "error" : undefined;
	// One past the page, to say whether there is more (#898): a full page used to read as the whole log.
	// Exact per-instance / per-run reads (#1085), on the verified columns — never widened past `scope`.
	const instanceId = c.req.query("instance_id") || undefined;
	const runId = c.req.query("run_id") || undefined;
	// #1090: build and time bounds, and the keyset walk over the whole retained log.
	const build = c.req.query("build") || undefined;
	const since = parseTimeBound(c.req.query("since"));
	const until = parseTimeBound(c.req.query("until"));
	if (since === null || until === null) return c.json({ error: "since/until must be an ISO time or epoch milliseconds" }, 400);
	const filter: ErrorFilter = { userId: session.uid, all, source, level, instanceId, runId, build, since, until };
	const rawCursor = c.req.query("cursor");
	if (rawCursor !== undefined) {
		const cursor = parseHistoryCursor(rawCursor, "string");
		if (cursor.kind === "invalid") return c.json({ error: "cursor is not one this endpoint issued — pass \"newest\" or a previous nextCursor" }, 400);
		try {
			const page = await listErrorsPage(c.env, { ...filter, cursor, limit });
			return c.json({
				scope: all ? "all" : "me",
				order: "first_seen_newest_first",
				count: page.errors.length,
				errors: page.errors,
				hasMore: page.hasMore,
				nextCursor: page.nextCursor,
				coverage: await historyCoverage(c.env, "error_log", session.roles.includes("admin")),
			});
		} catch (e) {
			return c.json({ error: `error log read failed: ${e instanceof Error ? e.message : String(e)}`, errors: null }, 503);
		}
	}
	const rows = await listErrors(c.env, { ...filter, limit: limit + 1, offset });
	const errors = rows.slice(0, limit);
	const hasMore = rows.length > limit;
	return c.json({ scope: all ? "all" : "me", count: errors.length, errors, offset, hasMore, nextOffset: hasMore ? offset + limit : null });
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
	// #1090: an admin may group across every account, the same opt-in `scope=all` the flat feed takes.
	const all = c.req.query("scope") === "all" && session.roles.includes("admin");
	const build = c.req.query("build") || undefined;
	const days = Math.max(1, Math.min(Number(c.req.query("days")) || 7, 30));
	const limit = Math.max(1, Math.min(Number(c.req.query("limit")) || 2000, 5000));
	const source = c.req.query("source") || undefined;
	const level = c.req.query("level") === "warn" ? "warn" : c.req.query("level") === "error" ? "error" : undefined;
	const instanceId = c.req.query("instance_id") || undefined;
	const runId = c.req.query("run_id") || undefined;

	// User-scoped unless an ADMIN explicitly asks for `scope=all` (#1090) — never widened just
	// because of who is signed in, so an owner's page keeps one meaning.
	const where = [`${ERROR_RECENCY} >= ?1`];
	const binds: unknown[] = [new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ")];
	if (!all) {
		binds.push(session.uid);
		where.push(`user_id = ?${binds.length}`);
	}
	if (build) {
		binds.push(build);
		where.push(`build = ?${binds.length}`);
	}
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
		// Since migration 0239 the VERIFIED `instance_id` column answers this exactly (#1085); the
		// samples below remain for rows written before it, and for those the answer stays a lower bound.
		binds.push(instanceId);
		const n = binds.length;
		where.push(
			`(instance_id = ?${n} OR ?${n} IN (` +
				`CASE WHEN json_valid(context) THEN json_extract(context, '$.instanceId') END, ` +
				`CASE WHEN json_valid(context) THEN json_extract(context, '$.instance_id') END, ` +
				`CASE WHEN json_valid(last_context) THEN json_extract(last_context, '$.instanceId') END, ` +
				`CASE WHEN json_valid(last_context) THEN json_extract(last_context, '$.instance_id') END))`,
		);
	}
	if (runId) {
		binds.push(runId);
		where.push(`run_id = ?${binds.length}`);
	}
	const sql = `SELECT ${ERROR_COLUMNS} FROM error_log WHERE ${where.join(" AND ")} ORDER BY ${ERROR_RECENCY} DESC LIMIT ${limit}`;
	const rows = (await c.env.DB.prepare(sql).bind(...binds).all<RawError>()).results ?? [];
	const signatures = summarizeErrors(rows);
	const recencyOf = (r: RawError) => r.last_seen_at ?? r.created_at;
	return c.json({
		scope: all ? "all" : "me",
		days,
		// The span the rows read actually cover. When `truncated`, `oldestRead` is later than the start
		// of `days`: everything between the two was NOT grouped (#1090).
		window: { from: new Date(Date.now() - days * 86_400_000).toISOString(), oldestRead: rows.length ? recencyOf(rows[rows.length - 1]) : null, rowLimit: limit },
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
