/**
 * Durable error log (D1 `error_log`). Failures at the key hotspots write here so
 * a reason is never thrown away — readable via GET /v1/errors. See migration 0034.
 */
import type { Env } from "../types.js";
import { logEvent } from "./events.js";

/**
 * How severe a logged failure is.
 *
 * `warn` exists so a failure can be RECORDED without being counted as a bug (#424). Two classes
 * were previously dropped entirely for want of it: transient infrastructure (a Durable Object
 * reset by a deploy — self-healing, and the 503 is the correct answer) and the diagnostic 4xx
 * (402/403/409/429 — expected, but the only evidence that a user is repeatedly hitting a wall).
 * Dropping them made "how often does a deploy break a live request?" unanswerable.
 */
export type ErrorLevel = "error" | "warn";

/**
 * How long an identical failure folds into the row already recording it (#424).
 *
 * One hour, anchored on that row's `created_at` rather than on its last hit, so a permanently
 * failing sweep produces at most 24 rows a day and still shows WHEN it was failing. #423 wrote
 * 1809 rows with one distinct message between them and buried everything else in the log; the read
 * side had aggregated identical signatures all along, and this is the write side finally agreeing.
 */
const COLLAPSE_WINDOW_MS = 60 * 60_000;

/** `datetime('now')`'s own format, so a JS-computed bound compares correctly against the column. */
const sqlTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

export interface ErrorLogInput {
	/** Where it failed: 'keys-proxy' | 'auth' | 'job-apply' | 'coding' | 'chat' | … */
	source: string;
	/** The failure reason (upstream body, exception message, etc.). */
	message: string;
	/** The affected user, when known. */
	userId?: string | null;
	/** HTTP-ish status when applicable. */
	status?: number;
	/** Defaults to `error`. See {@link ErrorLevel}. */
	level?: ErrorLevel;
	/** Structured extras: host, path, provider, instanceId, taskId, … */
	context?: Record<string, unknown>;
	/**
	 * The build that produced this row (#539) — a short commit sha for a deployed browser bundle,
	 * `dev` for one built on a developer's machine, `unset` for a client that declares nothing.
	 *
	 * Absent for server-side callers: the API Worker does not stamp its own build (it has no build
	 * var), so NULL here reads as "written by the server, or by a bundle predating #539".
	 */
	build?: string | null;
}

/**
 * The build id as it is allowed into the log — or undefined (#539).
 *
 * This value reaches a WHERE clause and a UI, and it arrives from an unauthenticated POST body, so
 * it is narrowed to the shape a build id actually has. Not for injection (the SQL is
 * parameterized), but because an attacker who can write 2000 arbitrary characters into the collapse
 * key can defeat the collapse — which is the flood #423 filled this table with, on demand.
 */
export function sanitizeBuildId(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const clean = raw.trim().replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
	return clean || undefined;
}

/**
 * Fold this failure into an identical one already logged inside the collapse window.
 *
 * Identity is EXACT — same source, level, status, user and byte-identical message. Not the
 * normalized signature `/errors/summary` groups by: that would merge "instance abc failed" with
 * "instance def failed" at write time and throw away which instance, irreversibly. Exact text
 * carries no extra information by definition, which is what makes collapsing it lossless. (#423's
 * flood was 1809 rows of one distinct message, so exact matching is enough for the case that
 * motivated this.)
 *
 * ## The absorbed occurrence's CONTEXT survives (#538)
 *
 * `context` is the FIRST occurrence's and stays that way; `last_context` is overwritten with the
 * one being absorbed. Before this the UPDATE set only the counter and the timestamp, so a row
 * reading `repeat_count: 11` carried ONE sample and eleven measurements had been taken, sent,
 * accepted and then thrown away — the log was the only witness and it was quietly editing its own
 * testimony. Keeping both ends is what makes "was it like this every time?" answerable, and it is
 * the question a repeat count raises by existing.
 *
 * The context is deliberately NOT part of the identity above. For the sources that actually
 * repeat, the context is a per-occurrence measurement (`peakLevel`, `frames`, …), so keying on it
 * would mean never collapsing anything — reinstating #423's flood in the name of fixing it.
 *
 * ## The BUILD is part of the identity (#539)
 *
 * Two builds can never share a row. A post-fix occurrence folding into a pre-fix bucket is the one
 * case where "is this still happening?" has a different answer from "is there a row?", and it is
 * the case that cost a full re-investigation on 2026-08-12. Keeping the build in `context` instead
 * would have been eaten by the very collapse this clause fixes — #538 keeps the latest sample, but
 * a reader looking at a row's identity would still see one bucket spanning a deploy.
 *
 * Safe for volume in a way the context is not: a build id is constant for a tab, so it adds at
 * most one bucket per signature per deployed build.
 *
 * Returns true when an existing row absorbed the occurrence.
 */
async function collapseRepeat(
	env: Env,
	e: ErrorLogInput,
	level: ErrorLevel,
	message: string,
	source: string,
	context: string | null,
	build: string | null,
): Promise<boolean> {
	const res = await env.DB.prepare(
		`UPDATE error_log
		    SET repeat_count = repeat_count + 1, last_seen_at = datetime('now'), last_context = ?7
		  WHERE id = (SELECT id FROM error_log
		               WHERE source = ?1 AND message = ?2 AND level = ?3
		                 AND status IS ?4 AND user_id IS ?5
		                 AND created_at >= ?6 AND build IS ?8
		               ORDER BY created_at DESC LIMIT 1)`,
	)
		.bind(
			source,
			message,
			level,
			typeof e.status === "number" ? e.status : null,
			e.userId ?? null,
			sqlTime(Date.now() - COLLAPSE_WINDOW_MS),
			context,
			build,
		)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

/**
 * Persist a failure. NEVER throws — error logging must not break the request path
 * it is observing. Sizes are bounded so one huge upstream body can't bloat a row.
 */
export async function logError(env: Env, e: ErrorLogInput): Promise<void> {
	try {
		const level: ErrorLevel = e.level === "warn" ? "warn" : "error";
		const source = String(e.source).slice(0, 64);
		const message = String(e.message ?? "").slice(0, 2000) || "(no message)";
		// Serialized ONCE: the same bytes go to the INSERT's `context` (a new row's first
		// occurrence) or to the UPDATE's `last_context` (an absorbed one's latest). Two
		// stringify calls would be two chances for the two columns to mean different things.
		const context = e.context ? JSON.stringify(e.context).slice(0, 4000) : null;
		const build = sanitizeBuildId(e.build) ?? null;
		// A repeat is absorbed by the row already recording it AND does not mirror into the trace:
		// #423 flooded `agent_events` with 1811 error events for the same reason it flooded this
		// table, so collapsing only one of the two would leave the other unreadable.
		//
		// A FAILING collapse falls through to the insert rather than out to the catch below. The
		// deploy applies migrations before it replaces the Worker, so the columns are there — but
		// the failure mode if that assumption is ever wrong is total silence in the one component
		// whose entire job is to not be silent, and a duplicate row is a trivially better outcome
		// than no row.
		if (await collapseRepeat(env, e, level, message, source, context, build).catch(() => false)) return;
		await env.DB.prepare(
			"INSERT INTO error_log (id, user_id, source, status, message, context, level, build, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'))",
		)
			.bind(
				crypto.randomUUID(),
				e.userId ?? null,
				source,
				typeof e.status === "number" ? e.status : null,
				message,
				context,
				level,
				build,
			)
			.run();
		// Mirror into the unified trace so failures appear inline in agent_trace next to
		// the steps that led to them — mapping the well-known context keys onto the
		// trace's instance/run scoping. Best-effort; a bridge failure must not surface.
		const ctx = e.context ?? {};
		await logEvent(env, {
			source: String(e.source).split(":")[0] || "error",
			event: "error",
			level: "error",
			message: e.message,
			userId: e.userId ?? null,
			instanceId: (ctx.instanceId as string) ?? (ctx.instance_id as string) ?? null,
			// `traceId` FIRST (#529). The bridge only ever read `taskId`, which is the apply/browser
			// workflows' correlation key and nobody else's: a coding run correlates by its loop-run
			// id, a pipeline by its run id. Those callers had a trace id to give and no way to give
			// it, so their failures mirrored into `agent_trace` with a NULL `trace_id` — present in
			// the timeline, absent from `?trace_id=<run>`, which is the query an investigator makes.
			traceId: (ctx.traceId as string) ?? (ctx.trace_id as string) ?? (ctx.taskId as string) ?? (ctx.task_id as string) ?? null,
			context: e.context,
		}).catch(() => undefined);
		// Opportunistic retention: there is no cron, so ~2% of writes prune rows older
		// than 30 days. Keeps the log from growing unbounded even if a client hammers
		// /v1/errors/client. Best-effort — never blocks.
		//
		// Aged on the LAST occurrence, not the first: a collapsed row is a bucket that stays open
		// for an hour, and one still being hit must not be deleted because the bucket opened a
		// month ago. (In practice a bucket is at most an hour older than its last hit, so this only
		// matters if the window is ever widened — which is exactly when it would be forgotten.)
		if (Math.random() < 0.02) {
			await env.DB.prepare(`DELETE FROM error_log WHERE ${ERROR_RECENCY} < datetime('now', '-30 days')`)
				.run()
				.catch(() => undefined);
		}
	} catch (err) {
		// Last resort — the logger itself must not throw.
		console.error("[error-log] failed to persist:", err instanceof Error ? err.message : String(err));
	}
}

export interface ErrorRow {
	id: string;
	created_at: string;
	user_id: string | null;
	source: string;
	status: number | null;
	message: string;
	/**
	 * The FIRST occurrence's context — the one that opened this bucket, not the latest (#538).
	 * When `repeat_count > 1`, read {@link ErrorRow.last_context} for the most recent sample.
	 */
	context: string | null;
	/**
	 * The MOST RECENT occurrence's context, once a second one has been absorbed (#538).
	 *
	 * Null means the row stands for a single occurrence — or that it was collapsed before
	 * migration 0124. Never "the same as `context`, omitted": an occurrence that repeats
	 * identically still writes its own bytes here, so equal columns is a measured statement that
	 * nothing drifted rather than an absence someone has to interpret.
	 */
	last_context?: string | null;
	/** `error` (a bug) or `warn` (recorded, not counted). See {@link ErrorLevel}. */
	level?: ErrorLevel | null;
	/** Occurrences this row stands for — 1 unless repeats were collapsed into it. */
	repeat_count?: number | null;
	/** Most recent occurrence. Null only on a row written before migration 0103. */
	last_seen_at?: string | null;
	/**
	 * The build that wrote this row (#539) — a short sha, `dev`, or `unset`.
	 *
	 * Part of the collapse identity, so this is the build of EVERY occurrence the row stands for,
	 * not just the first. Null on a server-side row (the Worker does not stamp its own build) or
	 * on one written by a browser bundle predating #539.
	 */
	build?: string | null;
}

/**
 * The columns every error read selects, and the recency expression they order by.
 *
 * Ordering is on the LAST occurrence, not the first: a collapsed row keeps the `created_at` of the
 * bucket it opened, so ordering by that would sink an outage that is still happening below things
 * that finished hours ago. `COALESCE` covers a row written before migration 0103 backfilled it —
 * without it a NULL sorts LAST under `DESC` in SQLite, which is invisibility rather than staleness.
 */
export const ERROR_COLUMNS =
	"id, created_at, user_id, source, status, message, context, last_context, level, repeat_count, last_seen_at, build";
export const ERROR_RECENCY = "COALESCE(last_seen_at, created_at)";

/** Read recent errors — for one user, or all (admin). Newest first. */
export async function listErrors(
	env: Env,
	opts: { userId?: string; all?: boolean; limit?: number; source?: string; level?: ErrorLevel },
): Promise<ErrorRow[]> {
	const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
	const where: string[] = [];
	const binds: unknown[] = [];
	if (!opts.all) {
		binds.push(opts.userId ?? "");
		where.push(`user_id = ?${binds.length}`);
	}
	if (opts.source) {
		binds.push(opts.source);
		where.push(`source = ?${binds.length}`);
	}
	if (opts.level) {
		binds.push(opts.level);
		where.push(`level = ?${binds.length}`);
	}
	const sql = `SELECT ${ERROR_COLUMNS} FROM error_log${
		where.length ? ` WHERE ${where.join(" AND ")}` : ""
	} ORDER BY ${ERROR_RECENCY} DESC LIMIT ${limit}`;
	const res = await env.DB.prepare(sql)
		.bind(...binds)
		.all<ErrorRow>();
	return res.results ?? [];
}
