/**
 * Durable error log (D1 `error_log`). Failures at the key hotspots write here so
 * a reason is never thrown away — readable via GET /v1/errors. See migration 0034.
 */
import { currentRequestId } from "./request-context.js";
import { boundedJson, clipMarked } from "./clip-marked.js";
import { type CursorQuery, keysetBefore, keysetPage, sqlTimeOf } from "./history-page.js";
import type { Env } from "../types.js";
import { logEvent } from "./events.js";
import { sqlTime } from "./sql-time.js";
import { spoolTelemetry, type TelemetryWrite } from "./telemetry-spool.js";

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
 * Sources whose STATUSLESS reports are OBSERVATIONS of a designed outcome, not failures (#571).
 *
 * The client telemetry route had exactly one input to derive severity from — the HTTP status — and
 * one premise: no status means nothing answered, which means something broke. That premise held for
 * every caller it was written for and is false for a whole family. The voice stack reports through
 * this path with no status at all, so its noise gate catching Whisper's "Thank you for watching."
 * hallucination off a silent microphone landed at the same severity as `Anthropic (400): Your credit
 * balance is too low`. Measured 2026-08-15: **19 of the 40 newest rows were `client:voice`, every one
 * at `error`, and eight of them (25 occurrences after collapse) were the feature working.**
 * `?level=error` — documented in `routes/errors.ts` as "how you ask for bugs only" — returned mostly
 * discarded microphone frames.
 *
 * ## This is not "trusting the client"
 *
 * The reasoning in `routes/errors.ts` stands: a caller must not be able to name its own level,
 * because the first one to pass the wrong one makes the field meaningless. Nothing here changes that.
 * The client still supplies only a SOURCE — where the report came from, the same untrusted-but-useful
 * fact a `User-Agent` carries — and the SERVER decides what that name means, exactly as it already
 * decides what a status means. A caller that reports under a name it has no business using gets the
 * level this table assigns to that name; it cannot invent one.
 *
 * ## Why the list is names, not a rule
 *
 * A blanket allowlist on `voice` was the cheaper-looking fix and is unsound: `client:voice` is NOT a
 * homogeneous source. It carries designed discards (the noise gate, the end-of-turn gate, the clip
 * gate, the echo-tail ignore) AND genuine failures on the same string (the audio monitor failing to
 * start, a Whisper 400, the transcription watchdog, hands-free bailing out because the recognizer
 * kept dying). Downgrading all of it would silently hide real failures — the mirror of the bug being
 * fixed. So the SDK splits the source instead: the designed-decision call sites report under
 * `voice-decision` and every failure keeps `voice`. See `packages/sdk/src/voice/report-sources.test.ts`,
 * which asserts that split over the whole voice tree so a new call site cannot land unclassified.
 *
 * ## Why `warn` and not a fourth level
 *
 * `warn` already means precisely this — "a failure can be RECORDED without being counted as a bug"
 * ({@link ErrorLevel}) — and a designed discard is the purest case of it. An `info` level would have
 * to be threaded through the read filter (`routes/errors.ts`), `listErrors`, and the MCP
 * `list_errors` level enum, so a row nobody can name is a row nobody can filter for. Nothing is
 * reduced either way: the rows are still written, still readable, still carry their full context —
 * #511, #535 and #538 all reason from this telemetry and none of it goes away. Only the severity it
 * claims changes.
 */
// `client:network` (#1088): a request that failed at the transport while the browser was online, or the
// count of those that failed while it was offline — real and countable, but the network's, not a bug.
export const OBSERVATION_SOURCES: ReadonlySet<string> = new Set(["client:voice-decision", "client:network"]);

/**
 * The level a CLIENT-reported row is filed at, from the two things the server is willing to judge on:
 * the status it carries and the source it came from. Pure, so the policy is testable without a route.
 *
 * Order is the content. **The status wins**, because it is a measurement and a name is a claim: a 4xx
 * is a wall the user hit (diagnostic, not a bug), and anything else the transport reported — a 5xx, a
 * 0 — is a real failure however the caller labelled itself. Only a report with NO status at all falls
 * through to the source, which is exactly the case the status rule was silent about and the one that
 * produced #571.
 *
 * @param source the FULL stored source, `client:`-prefixed — the same string `list_errors(source:…)`
 *               filters on, so what is declared above is what an investigator can query.
 */
export function deriveClientLevel(source: string, status?: number): ErrorLevel {
	if (typeof status === "number") return status >= 400 && status < 500 ? "warn" : "error";
	return OBSERVATION_SOURCES.has(source) ? "warn" : "error";
}

/**
 * How long an identical failure folds into the row already recording it (#424).
 *
 * One hour, anchored on that row's `created_at` rather than on its last hit, so a permanently
 * failing sweep produces at most 24 rows a day and still shows WHEN it was failing. #423 wrote
 * 1809 rows with one distinct message between them and buried everything else in the log; the read
 * side had aggregated identical signatures all along, and this is the write side finally agreeing.
 */
const COLLAPSE_WINDOW_MS = 60 * 60_000;


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
	 * The context came from an UNAUTHENTICATED or caller-controlled source — the browser's
	 * `/v1/errors/client` (#1085). Its instance id is then kept only when the row's own user owns
	 * that instance, never used to find an owner, and its run id is dropped: a report must not be
	 * able to file a row under someone else's instance, nor mint ids that defeat the collapse.
	 */
	untrusted?: boolean;
	/**
	 * The build that produced this row (#539) — a short commit sha for a deployed browser bundle,
	 * `dev` for one built on a developer's machine, `unset` for a client that declares nothing.
	 *
	 * Absent for server-side callers, which are stamped with the API Worker's own deployed build
	 * (`env.API_BUILD`, #735 — on every entrypoint since #1085). NULL reads as "a bundle predating
	 * #539" or a server isolate that had no build var.
	 */
	build?: string | null;
	/**
	 * How many occurrences this report stands for (#1088) — a browser folds repeats of one failure into
	 * one event. 1 when absent. Added to the row's `repeat_count`, so the log counts occurrences, not sends.
	 */
	occurrences?: number;
}

/**
 * The API Worker's own build identifier, set once per isolate lifetime from `env.API_BUILD` (#735).
 *
 * A module-level var rather than threading `env.API_BUILD` through every `logError` call: the build
 * is a CONSTANT for the entire worker lifetime, and widening `logError`'s env type from
 * `Pick<Env, "DB">` to also require `API_BUILD` would force every one of the 46+ call sites to
 * supply a wider env — the "Env plumbing explosion" the narrow type was designed to avoid (#637).
 *
 * Set from `env.API_BUILD` once on the first request (index.ts). Defaults to `undefined` in test
 * code that never calls `setServerBuild`. `resetServerBuildForTests` restores that default.
 */
let _serverBuild: string | undefined;

/** Stamp this isolate's build id onto every subsequent `logError` server write. Called once per
 *  isolate from `index.ts` when `env.API_BUILD` is available. Idempotent — a second call with
 *  the same value is harmless. */
export function setServerBuild(build: string): void {
	_serverBuild = sanitizeBuildId(build);
}

/** Reset the per-isolate build stamp. Tests only — an isolate never wants this. */
export function resetServerBuildForTests(): void {
	_serverBuild = undefined;
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
 * ## The INSTANCE and RUN are part of the identity (#1085)
 *
 * The same failure on instances A, B and C used to fold into one row whose two samples named A and
 * C, leaving B unfindable and the count unattributable. Both are bounded entity ids, not
 * per-occurrence measurements, and both are VERIFIED before they get here (`resolveErrorScope`), so
 * keying on them keeps each instance's and each run's occurrences in a row of their own while a
 * repeat inside one run still folds. Rows from before migration 0239 carry NULL in both.
 *
 * Returns true when an existing row absorbed the occurrence.
 */
async function collapseRepeat(env: Pick<Env, "DB">, k: CollapseKey, context: string | null, occurrences = 1, requestId: string | null = null): Promise<boolean> {
	// The absorbed occurrence's request (#1135) is kept like its context: the latest one, beside the
	// request that opened the row. Not part of the identity — every request has its own id.
	const res = await env.DB.prepare(
		`UPDATE error_log
		    SET repeat_count = repeat_count + ?11, last_seen_at = datetime('now'), last_context = ?7, last_request_id = ?12
		  WHERE id = (SELECT id FROM error_log
		               WHERE source = ?1 AND message = ?2 AND level = ?3
		                 AND status IS ?4 AND user_id IS ?5
		                 AND created_at >= ?6 AND build IS ?8
		                 AND instance_id IS ?9 AND run_id IS ?10
		               ORDER BY created_at DESC LIMIT 1)`,
	)
		.bind(k.source, k.message, k.level, k.status, k.userId, sqlTime(Date.now() - COLLAPSE_WINDOW_MS), context, k.build, k.instanceId, k.runId, occurrences, requestId)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

/** What makes two occurrences the SAME row: exact text, severity, status, owner, build, instance and run. */
interface CollapseKey {
	source: string;
	message: string;
	level: ErrorLevel;
	status: number | null;
	userId: string | null;
	build: string | null;
	instanceId: string | null;
	runId: string | null;
}

/** An id as it may enter a column and a collapse key: id-shaped and bounded, or nothing. */
function idOrNull(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const v = raw.trim();
	return v && v.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(v) ? v : null;
}

/**
 * The owner, instance and run a row is filed under (#1085) — VERIFIED, never taken on the caller's word.
 *
 * The instance is read from the context keys real call sites use (`instanceId`, `instance_id`) and
 * kept only when `agent_instances` says who owns it: a row naming a user keeps the instance only if
 * that user owns it; a trusted server path that named no user (a Durable Object, a sweep) is filed
 * under the instance's owner. A Durable Object's name may be a TEMPLATE agent id rather than an
 * instance — then the agent's owner is the row's user and there is no instance. Any lookup failure
 * keeps what the caller said about the user and drops the instance, rather than guess.
 *
 * The run is the correlation id the trace already reads — `runId` first, then the trace and task
 * spellings — and is dropped for untrusted (client) rows.
 */
export async function resolveErrorScope(
	env: Pick<Env, "DB">,
	e: Pick<ErrorLogInput, "userId" | "context" | "untrusted">,
): Promise<{ userId: string | null; instanceId: string | null; runId: string | null }> {
	const ctx = e.context ?? {};
	const claimedUser = e.userId ?? null;
	const runId = e.untrusted ? null : idOrNull(ctx.runId ?? ctx.run_id ?? ctx.traceId ?? ctx.trace_id ?? ctx.taskId ?? ctx.task_id);
	// A Durable Object names itself by `agentId`, which is an instance id OR a template agent id —
	// accepted only from a trusted path that did not already say whose row this is.
	const named = idOrNull(ctx.instanceId ?? ctx.instance_id) ?? (!claimedUser && !e.untrusted ? idOrNull(ctx.agentId) : null);
	if (!named) return { userId: claimedUser, instanceId: null, runId };
	const owned = await env.DB.prepare("SELECT user_id FROM agent_instances WHERE id = ?1").bind(named).first<{ user_id: string | null }>().catch(() => null);
	if (owned?.user_id) {
		if (claimedUser) return { userId: claimedUser, instanceId: owned.user_id === claimedUser ? named : null, runId };
		return e.untrusted ? { userId: null, instanceId: null, runId } : { userId: owned.user_id, instanceId: named, runId };
	}
	if (claimedUser || e.untrusted) return { userId: claimedUser, instanceId: null, runId };
	const agent = await env.DB.prepare("SELECT owner_id FROM agents WHERE id = ?1").bind(named).first<{ owner_id: string | null }>().catch(() => null);
	return { userId: agent?.owner_id ?? null, instanceId: null, runId };
}

/**
 * Persist a failure. NEVER throws — error logging must not break the request path
 * it is observing. Sizes are bounded so one huge upstream body can't bloat a row.
 *
 * Takes `Pick<Env, "DB">`, not `Env` — a widening, so every existing caller is unaffected. D1 is
 * the whole requirement (this function and `logEvent` below it touch nothing else), and saying so
 * in the type is what lets a component holding only a database handle report through here: the
 * storage engine reaches the durable log this way rather than being handed every binding in the
 * environment (#637). `lib/meter-ids.ts` already narrows the same way for the same reason.
 */
export async function logError(env: Pick<Env, "DB"> & Partial<Pick<Env, "OAUTH_KV" | "API_BUILD">>, e: ErrorLogInput): Promise<TelemetryWrite> {
	let row: Record<string, unknown> | null = null;
	let id = "";
	try {
		const level: ErrorLevel = e.level === "warn" ? "warn" : "error";
		const source = String(e.source).slice(0, 64);
		const message = clipMarked(e.message ?? "", 2000) || "(no message)";
		// Serialized ONCE: the same bytes go to the INSERT's `context` (a new row's first
		// occurrence) or to the UPDATE's `last_context` (an absorbed one's latest). Two
		// stringify calls would be two chances for the two columns to mean different things.
		// Valid JSON whatever its size (#898): a slice failed `json_valid`, and `error_summary`'s
		// instance filter then dropped the row — the larger the context, the surer the loss.
		const context = e.context ? boundedJson(e.context, 4000) : null;
		// For client rows the caller supplies `e.build` (from the browser bundle's stamp, #539).
		// For server rows `e.build` is always absent, so fall back to the isolate-level build id
		// that `index.ts` sets from `env.API_BUILD` on the first request (#735). This is what stamps
		// server-side rows with the deployed git SHA, making "is this row pre-fix or post-fix?"
		// answerable without a cross-reference to `git log`.
		// Every entrypoint that holds the full env stamps the isolate here (#1085): `index.ts` only
		// ever did it on `fetch`, so a cron, Durable Object or Workflow isolate that never served a
		// request wrote `build: null`. A narrowed env without the var still falls back to the stamp.
		if (!_serverBuild && env.API_BUILD) setServerBuild(env.API_BUILD);
		const build = sanitizeBuildId(e.build) ?? _serverBuild ?? null;
		const scope = await resolveErrorScope(env, e);
		const key: CollapseKey = { source, message, level, status: typeof e.status === "number" ? e.status : null, userId: scope.userId, build, instanceId: scope.instanceId, runId: scope.runId };
		// A repeat is absorbed by the row already recording it AND does not mirror into the trace:
		// #423 flooded `agent_events` with 1811 error events for the same reason it flooded this
		// table, so collapsing only one of the two would leave the other unreadable.
		//
		// A FAILING collapse falls through to the insert rather than out to the catch below. The
		// deploy applies migrations before it replaces the Worker, so the columns are there — but
		// the failure mode if that assumption is ever wrong is total silence in the one component
		// whose entire job is to not be silent, and a duplicate row is a trivially better outcome
		// than no row.
		const occurrences = Number.isInteger(e.occurrences) && (e.occurrences as number) > 1 ? Math.min(e.occurrences as number, 10_000) : 1;
		// The request this is written inside (#1135), or null from a Durable Object, Workflow or cron.
		const requestId = currentRequestId();
		if (await collapseRepeat(env, key, context, occurrences, requestId).catch(() => false)) return "persisted";
		// The id and the time are minted ONCE (#1084): if this insert fails, the same row — same id,
		// same moment — is what the spool replays, so a replay can never become a second fact.
		id = crypto.randomUUID();
		row = { created_at: sqlTime(), user_id: key.userId, source, status: key.status, message, context, level, build, instance_id: key.instanceId, run_id: key.runId, repeat_count: occurrences, request_id: requestId };
		await env.DB.prepare(
			"INSERT INTO error_log (id, user_id, source, status, message, context, level, build, last_seen_at, created_at, instance_id, run_id, repeat_count, request_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10, ?11, ?12, ?13)",
		)
			.bind(id, row.user_id, source, row.status, message, context, level, build, row.created_at, key.instanceId, key.runId, occurrences, requestId)
			.run();
		row = null;
		// Mirror into the unified trace so failures appear inline in agent_trace next to
		// the steps that led to them — mapping the well-known context keys onto the
		// trace's instance/run scoping. Best-effort; a bridge failure must not surface.
		// The VERIFIED scope, and the row's own severity (#1085): this used to mirror every warn as an
		// error and read the run only from `traceId`/`taskId`, so a coding or pipeline failure that
		// named its `runId` was absent from `agent_trace?trace_id=<run>`.
		await logEvent(env, {
			source: String(e.source).split(":")[0] || "error",
			event: "error",
			level,
			message: e.message,
			userId: key.userId,
			instanceId: key.instanceId,
			traceId: key.runId,
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
		return "persisted";
	} catch (err) {
		// The logger itself must not throw, and must not call itself (#1084): the row D1 refused goes
		// to the KV spool, which the cron replays; only a row the spool refuses too is lost — and counted.
		console.error("[error-log] failed to persist:", err instanceof Error ? err.message : String(err));
		return row ? spoolTelemetry(env, "error_log", id, row) : "lost";
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
	/** The verified instance this occurrence belongs to (#1085). NULL on rows before migration 0239. */
	instance_id?: string | null;
	/** The run/trace correlation id (#1085). NULL on rows before migration 0239 and on client reports. */
	run_id?: string | null;
	/**
	 * The request that OPENED this row (#1135) — the `X-Request-Id` its response carried, which the
	 * MCP call event and the request's trace rows carry too. NULL outside a request (Durable Object,
	 * Workflow, cron) and on rows before migration 0252.
	 */
	request_id?: string | null;
	/** The request of the most recent occurrence absorbed into this row (#1135), once one has been. */
	last_request_id?: string | null;
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
	"id, created_at, user_id, source, status, message, context, last_context, level, repeat_count, last_seen_at, build, instance_id, run_id, request_id, last_request_id";
export const ERROR_RECENCY = "COALESCE(last_seen_at, created_at)";

/** Read recent errors — for one user, or all (admin). Newest first. */
export async function listErrors(
	env: Env,
	opts: ErrorFilter & { limit?: number; offset?: number },
): Promise<ErrorRow[]> {
	// `limit` may be one past a page (the route asks for 501 to learn whether more exist).
	const limit = Math.max(1, Math.min(opts.limit ?? 100, 501));
	const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
	const { where, binds } = errorFilters(opts);
	const sql = `SELECT ${ERROR_COLUMNS} FROM error_log${
		where.length ? ` WHERE ${where.join(" AND ")}` : ""
	} ORDER BY ${ERROR_RECENCY} DESC, id DESC LIMIT ${limit} OFFSET ${offset}`;
	const res = await env.DB.prepare(sql)
		.bind(...binds)
		.all<ErrorRow>();
	return res.results ?? [];
}

export interface ErrorFilter {
	userId?: string;
	all?: boolean;
	source?: string;
	level?: ErrorLevel;
	instanceId?: string;
	runId?: string;
	/** One request's rows (#1135): the request that opened a row OR the latest one absorbed into it. */
	requestId?: string;
	/** Exact deployed build stamp (the `build` column, a 12-char commit prefix). */
	build?: string;
	/** Epoch ms bounds on `created_at` (first seen), inclusive. */
	since?: number;
	until?: number;
}

function errorFilters(opts: ErrorFilter): { where: string[]; binds: unknown[] } {
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
	// Exact, indexed columns (#1085). A row written before migration 0239 has neither, and is not
	// guessed into either: its instance survives only in its samples (`/errors/summary` reads those).
	if (opts.instanceId) {
		binds.push(opts.instanceId);
		where.push(`instance_id = ?${binds.length}`);
	}
	if (opts.runId) {
		binds.push(opts.runId);
		where.push(`run_id = ?${binds.length}`);
	}
	if (opts.requestId) {
		binds.push(opts.requestId);
		where.push(`(request_id = ?${binds.length} OR last_request_id = ?${binds.length})`);
	}
	if (opts.build) {
		binds.push(opts.build);
		where.push(`build = ?${binds.length}`);
	}
	if (opts.since !== undefined) {
		binds.push(sqlTimeOf(opts.since));
		where.push(`created_at >= ?${binds.length}`);
	}
	if (opts.until !== undefined) {
		binds.push(sqlTimeOf(opts.until));
		where.push(`created_at <= ?${binds.length}`);
	}
	return { where, binds };
}

/**
 * The retained error log walked newest-first by a keyset cursor (#1090). Ordered by `created_at`
 * (FIRST seen), not by recency: a repeat folding into a row moves its `last_seen_at`, and a walk
 * keyed on a moving column skips or repeats exactly the rows that are busiest. See `history-page.ts`.
 */
export async function listErrorsPage(
	env: Env,
	opts: ErrorFilter & { cursor: CursorQuery; limit?: number },
): Promise<{ errors: ErrorRow[]; hasMore: boolean; nextCursor: string | null }> {
	const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
	const { where, binds } = errorFilters(opts);
	keysetBefore(opts.cursor, "created_at", where, binds);
	const sql = `SELECT ${ERROR_COLUMNS} FROM error_log${
		where.length ? ` WHERE ${where.join(" AND ")}` : ""
	} ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`;
	const res = await env.DB.prepare(sql)
		.bind(...binds)
		.all<ErrorRow>();
	const page = keysetPage(res.results ?? [], limit, (row) => row.created_at);
	return { errors: page.rows, hasMore: page.hasMore, nextCursor: page.nextCursor };
}
