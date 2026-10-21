// The per-repo objective queue (#788) — the STORE half.
//
// Deliberately knows nothing about drivers, budgets or capabilities: it inserts, lists, claims and
// closes rows, and that is all. `objective-queue-start.ts` is the half that decides what a claimed
// entry becomes, and keeping the two apart is what lets this file be tested without standing up a
// loop driver — and what keeps `workflows/coding-session.ts`'s import of the drain from dragging
// the whole start path into the workflow's module graph.
//
// See `migrations/0149_instance_objective_queue.sql` for why the table is keyed
// `(instance_id, repo_id)` and what each `status` means.

import { type Keyset, keysetCursor, olderThan } from "./keyset-cursor.js";
import { clipMarked } from "./clip-marked.js";
import type { Env } from "../types.js";
import { MAX_CONFIGURABLE_OBJECTIVE_CHARS } from "./loop-limits.js";
import { boardOrderSql, objectiveJobKey } from "./board-order.js";

/** Every status an entry can hold. See the migration for what each one means. */
export const QUEUE_STATUSES = ["pending", "running", "started", "cancelled", "failed"] as const;

export type QueueStatus = (typeof QUEUE_STATUSES)[number];

/** A terminal status — one a drain writes and nothing moves afterwards. */
export type QueueTerminalStatus = Extract<QueueStatus, "started" | "cancelled" | "failed">;

interface ObjectiveQueueRow {
	id: string;
	instance_id: string;
	repo_id: string | null;
	user_id: string;
	objective: string;
	max_iterations: number | null;
	metadata: string | null;
	status: string;
	stop_reason: string | null;
	run_id: string | null;
	created_at: number;
	started_at: number | null;
	finished_at: number | null;
	request_id?: string | null;
	actor_uid?: string | null;
	client_claimed?: string | null;
	position?: number | null;
	/** Why it is waiting (#1264), e.g. `"runner_overloaded"` — null for every entry never deferred for that reason. */
	defer_reason?: string | null;
	/** When a TIMED backoff may try it again, ms epoch (#1264); null = eligible the moment something drains the queue. */
	next_retry_at?: number | null;
}

export interface ObjectiveQueueEntry {
	id: string;
	instanceId: string;
	/** Null means "any repo on this instance" — see the migration. */
	repoId: string | null;
	userId: string;
	objective: string;
	/** Null keeps the driver's own default, resolved against the account ceiling AT START time. */
	maxIterations: number | null;
	/** Caller-owned. Returned as written, including when it is not JSON — the platform never reads it. */
	metadata: string | null;
	status: QueueStatus;
	stopReason: string | null;
	runId: string | null;
	createdAt: number;
	startedAt: number | null;
	finishedAt: number | null;
	/** The start request that queued it (#1017); null for an entry queued before 0212 or without a request key. */
	requestId?: string | null;
	/** Its place on the board (#1097), on a pending listing: null = never placed (queued in arrival order). */
	position?: number | null;
	/** Who queued it, as far as the platform can verify (#1017). `unknown` = before attribution existed. */
	attribution?: { kind: "owner"; uid: string; verified: true; clientClaimed: string | null } | { kind: "unknown"; legacy: true };
	/** Why it is waiting (#1264) — see {@link ObjectiveQueueRow.defer_reason}. */
	deferReason: string | null;
	/** When a timed backoff may try it again, ms epoch (#1264); null = eligible as soon as something drains the queue. */
	nextRetryAt: number | null;
}

const COLUMNS =
	"id, instance_id, repo_id, user_id, objective, max_iterations, metadata, status, stop_reason, run_id, created_at, started_at, finished_at, request_id, actor_uid, client_claimed, defer_reason, next_retry_at";

/**
 * The queue in BOARD order (#1097): each entry is a card (`objective:<id>`), and where the owner placed it
 * in its column decides when it starts. Never placed = after the placed ones, oldest first — append.
 */
const ORDERED_FROM = `instance_objective_queue q LEFT JOIN board_items b ON b.instance_id = q.instance_id AND b.user_id = q.user_id AND b.job_key = 'objective:' || q.id`;
const ORDERED_COLUMNS = `${COLUMNS.split(", ").map((c) => `q.${c}`).join(", ")}, b.position AS position`;
const ORDER = boardOrderSql("b", "q.created_at", "q.id");

function toEntry(row: ObjectiveQueueRow): ObjectiveQueueEntry {
	return {
		id: row.id,
		instanceId: row.instance_id,
		repoId: row.repo_id ?? null,
		userId: row.user_id,
		objective: row.objective,
		maxIterations: row.max_iterations ?? null,
		metadata: row.metadata ?? null,
		status: row.status as QueueStatus,
		stopReason: row.stop_reason ?? null,
		runId: row.run_id ?? null,
		createdAt: row.created_at,
		startedAt: row.started_at ?? null,
		finishedAt: row.finished_at ?? null,
		requestId: row.request_id ?? null,
		...(row.position !== undefined ? { position: row.position } : {}),
		attribution: row.actor_uid ? { kind: "owner", uid: row.actor_uid, verified: true, clientClaimed: row.client_claimed ?? null } : { kind: "unknown", legacy: true },
		deferReason: row.defer_reason ?? null,
		nextRetryAt: row.next_retry_at ?? null,
	};
}

/** The widest cap any instance may set (#854) — `POST /loop` has already refused past the instance's own. */
const OBJECTIVE_MAX = MAX_CONFIGURABLE_OBJECTIVE_CHARS;

export interface EnqueueInput {
	instanceId: string;
	/** Which repo this objective is for. Omit/null for "any" — see the migration. */
	repoId?: string | null;
	userId: string;
	objective: string;
	maxIterations?: number | null;
	metadata?: string | null;
	/** `next` (#1097) puts it at the top of the board's Waiting column, so it starts before every queued entry. */
	position?: "end" | "next";
}

/**
 * Add one objective to the back of the queue — or, with `position: "next"`, to the front (#1097).
 *
 * `maxIterations` is stored RAW rather than sanitized. The account ceiling it is clamped against is
 * resolved per-run (`resolveAccountCeilings`), and an entry may sit here across a ceiling change —
 * baking the clamp in at enqueue time would apply yesterday's limit to tomorrow's run, silently.
 */
export async function enqueueObjective(env: Env, input: EnqueueInput): Promise<ObjectiveQueueEntry> {
	const id = `objq-${crypto.randomUUID()}`;
	const createdAt = Date.now();
	const objective = input.objective.slice(0, OBJECTIVE_MAX);
	await env.DB.prepare(
		`INSERT INTO instance_objective_queue
		   (id, instance_id, repo_id, user_id, objective, max_iterations, metadata, status, created_at, deferral_count)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, 0)`,
	)
		.bind(id, input.instanceId, input.repoId ?? null, input.userId, objective, input.maxIterations ?? null, input.metadata ?? null, createdAt)
		.run();
	if (input.position === "next") {
		// Above every placed card on the instance — so above everything in its column, placed or not.
		await env.DB.prepare(
			`INSERT INTO board_items (instance_id, user_id, job_key, user_status, title, subtitle, url, position)
			 VALUES (?1, ?2, ?3, NULL, '', '', '', (SELECT COALESCE(MIN(position), 1) - 1 FROM board_items WHERE instance_id = ?1 AND user_id = ?2 AND position IS NOT NULL))
			 ON CONFLICT(instance_id, user_id, job_key) DO UPDATE SET position = excluded.position`,
		)
			.bind(input.instanceId, input.userId, objectiveJobKey(id))
			.run();
	}
	return {
		id,
		instanceId: input.instanceId,
		repoId: input.repoId ?? null,
		userId: input.userId,
		objective,
		maxIterations: input.maxIterations ?? null,
		metadata: input.metadata ?? null,
		status: "pending",
		stopReason: null,
		runId: null,
		createdAt,
		startedAt: null,
		finishedAt: null,
		deferReason: null,
		nextRetryAt: null,
	};
}

/**
 * What is still waiting, in the order it will start (#1097: board order, else oldest first).
 *
 * With a `repoId` this is the ELIGIBLE set for that repo — its own entries plus the repo-agnostic
 * ones — which is the same predicate `dequeueNext` claims from, so a caller can see exactly what
 * the next drain will take. Without one it is everything pending on the instance.
 */
export async function listQueue(env: Env, instanceId: string, repoId?: string | null): Promise<ObjectiveQueueEntry[]> {
	const res =
		repoId === undefined
			? await env.DB.prepare(
					`SELECT ${ORDERED_COLUMNS} FROM ${ORDERED_FROM}
					  WHERE q.instance_id = ?1 AND q.status = 'pending'
					  ORDER BY ${ORDER}`,
				)
					.bind(instanceId)
					.all<ObjectiveQueueRow>()
			: await env.DB.prepare(
					// `repo_id = ?2` is NULL (not true) when ?2 is null, so this one predicate serves both
					// the named-repo case and the chat-driver case — the latter correctly seeing only the
					// repo-agnostic entries.
					`SELECT ${ORDERED_COLUMNS} FROM ${ORDERED_FROM}
					  WHERE q.instance_id = ?1 AND q.status = 'pending' AND (q.repo_id IS NULL OR q.repo_id = ?2)
					  ORDER BY ${ORDER}`,
				)
					.bind(instanceId, repoId ?? null)
					.all<ObjectiveQueueRow>();
	return (res.results ?? []).map(toEntry);
}

/** One entry by id, owner-scoped. Null when it is not this user's. */
export async function getQueueEntry(env: Env, id: string, userId: string): Promise<ObjectiveQueueEntry | null> {
	const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM instance_objective_queue WHERE id = ?1 AND user_id = ?2`)
		.bind(id, userId)
		.first<ObjectiveQueueRow>();
	return row ? toEntry(row) : null;
}

/**
 * Withdraw a queued objective.
 *
 * `status = 'pending'` in the predicate is the race guard, not a convenience: an entry a drain has
 * already claimed is a run about to exist, and marking it cancelled here would leave the queue
 * claiming it never ran while `agent_loop_runs` holds the run it became. False means "too late" as
 * much as it means "no such entry"; the caller reads the queue back to tell them apart.
 */
export async function cancelQueueEntry(env: Env, id: string, userId: string): Promise<boolean> {
	const res = await env.DB.prepare(
		`UPDATE instance_objective_queue
		    SET status = 'cancelled', finished_at = ?3
		  WHERE id = ?1 AND user_id = ?2 AND status = 'pending'`,
	)
		.bind(id, userId, Date.now())
		.run();
	const cancelled = (res.meta?.changes ?? 0) > 0;
	if (cancelled) await dropObjectiveCard(env, id);
	return cancelled;
}

/** A queue entry that left the queue is no longer a card: its board place goes with it (#1097). */
async function dropObjectiveCard(env: Env, id: string): Promise<void> {
	await env.DB.prepare("DELETE FROM board_items WHERE job_key = ?1").bind(objectiveJobKey(id)).run();
}

/** How many candidates one dequeue will try before giving up to a concurrent drain. */
const CLAIM_CANDIDATES = 5;

/**
 * Claim the first eligible entry in board order, atomically.
 *
 * D1 has no `SELECT … FOR UPDATE`, so the claim is the conditional UPDATE: `status = 'pending'` in
 * the predicate means exactly one of two concurrent drains can move a given row, and `changes`
 * reports which one did. The SELECT above it only proposes candidates — it is never trusted, which
 * is why losing the race walks to the next row rather than returning null. Both terminal paths of a
 * run can fire close together (the workflow's own drain and a retried step), and two drains starting
 * the SAME objective twice is the failure this shape exists to make impossible.
 */
export async function dequeueNext(env: Env, instanceId: string, repoId: string | null, now: number = Date.now()): Promise<ObjectiveQueueEntry | null> {
	const candidates = await env.DB.prepare(
		// The linearization point of a reorder (#1097): one committed before this SELECT decides this start.
		// `next_retry_at` (#1264) excludes an entry on a TIMED backoff — the only one it must wait out is
		// `runner_overloaded`, which is the only reason that ever sets it; every other pending entry has it
		// NULL and is exactly as eligible as it always was.
		`SELECT ${ORDERED_COLUMNS} FROM ${ORDERED_FROM}
		  WHERE q.instance_id = ?1 AND q.status = 'pending' AND (q.repo_id IS NULL OR q.repo_id = ?2)
		    AND (q.next_retry_at IS NULL OR q.next_retry_at <= ?4)
		  ORDER BY ${ORDER}
		  LIMIT ?3`,
	)
		.bind(instanceId, repoId ?? null, CLAIM_CANDIDATES, now)
		.all<ObjectiveQueueRow>();
	for (const row of candidates.results ?? []) {
		const startedAt = Date.now();
		const claimed = await env.DB.prepare(
			`UPDATE instance_objective_queue
			    SET status = 'running', started_at = ?2
			  WHERE id = ?1 AND status = 'pending'`,
		)
			.bind(row.id, startedAt)
			.run();
		if ((claimed.meta?.changes ?? 0) > 0) return { ...toEntry(row), status: "running", startedAt };
	}
	return null;
}

/**
 * Close a claimed entry out.
 *
 * `runId` is written only on `started`, and it is the entry's forwarding address: from that moment
 * the run record is the account of this objective and the queue row is history.
 */
export async function finishQueueEntry(
	env: Env,
	id: string,
	status: QueueTerminalStatus,
	stopReason?: string | null,
	runId?: string | null,
): Promise<void> {
	await env.DB.prepare(
		`UPDATE instance_objective_queue
		    SET status = ?2, stop_reason = ?3, run_id = ?4, finished_at = ?5
		  WHERE id = ?1`,
	)
		.bind(id, status, stopReason ? stopReason.slice(0, 500) : null, runId ?? null, Date.now())
		.run();
	await dropObjectiveCard(env, id);
}

/**
 * Put a claimed entry back at its ORIGINAL place in the queue.
 *
 * For the one failure that is not the entry's fault: the drain raced another start and was told the
 * repo is busy again. `created_at` is untouched, so it keeps its position — re-enqueueing would send
 * a first-in-line objective to the back of the queue for losing a race it never entered.
 */
/** How much of the waiting reason a pending row carries. `clipMarked`, because it is a sentence. */
const QUEUE_NOTE_CHARS = 500;

/**
 * What a requeue did (#1017). `requeued` is false when no claimed row moved (a retry, or an entry no longer
 * `running`): that is not a deferral, and no `deferred` event is owed for it. `deferralSeq` is this
 * deferral's ordinal, or null for a row queued before 0218 (its earlier deferrals were never counted).
 */
export interface Requeued {
	requeued: boolean;
	deferralSeq: number | null;
}

/**
 * The TIMED backoff for a `runner_overloaded` deferral (#1264): 1, 2, 5, then 10 minutes, by the
 * entry's OWN deferral count (every reason shares the counter, so an entry bounced between `busy`
 * and `runner_overloaded` ramps on its total deferrals, not an overload-only tally — simpler, and
 * the imprecision costs at most one step of the schedule). The SQL in {@link requeueEntry} restates
 * these same four values in a CASE, because the write has to be one atomic statement; keep both in
 * step if this schedule ever changes.
 */
export const OVERLOAD_BACKOFF_MS = [60_000, 120_000, 300_000, 600_000] as const;

export function overloadBackoffMs(deferralCount: number): number {
	const i = Math.max(1, Math.trunc(deferralCount)) - 1;
	return OVERLOAD_BACKOFF_MS[Math.min(i, OVERLOAD_BACKOFF_MS.length - 1)];
}

export async function requeueEntry(env: Env, id: string, note?: string | null, opts: { reason?: string | null } = {}): Promise<Requeued> {
	// `stop_reason` carries WHY it is still waiting (#984). The column is otherwise null on a pending
	// row and is already surfaced as `stopReason`, so the entry can say "the repo holds #978's
	// uncommitted work" instead of sitting pending with nothing recorded — which is indistinguishable
	// from a queue nobody is draining.
	// `deferred_at` (#1017) is the deferral's evidence that survives the entry leaving `pending`: the note
	// above is overwritten by `finishQueueEntry`, and this column is not, so a lost `deferred` event is
	// still a named gap after admission, cancellation or failure.
	// `deferral_count + 1` stays NULL on a pre-0218 row: one more deferral of an uncounted history is not a count.
	// `next_retry_at` (#1264): ONLY `runner_overloaded` sets it — see `OVERLOAD_BACKOFF_MS` above for
	// why these four literals must match it. Every other reason keeps it NULL, unchanged from before
	// this column existed: those entries are woken by an EVENT (a run finishing, a relay reconnecting),
	// never a clock, and must stay eligible the instant that event drains the queue.
	const row = await env.DB.prepare(
		`UPDATE instance_objective_queue
		    SET status = 'pending', started_at = NULL, stop_reason = ?2, deferred_at = ?3, deferral_count = deferral_count + 1,
		        defer_reason = ?4,
		        next_retry_at = CASE WHEN ?4 = 'runner_overloaded' THEN ?3 + (CASE WHEN deferral_count + 1 <= 1 THEN 60000 WHEN deferral_count + 1 = 2 THEN 120000 WHEN deferral_count + 1 = 3 THEN 300000 ELSE 600000 END) ELSE NULL END
		  WHERE id = ?1 AND status = 'running'
		  RETURNING deferral_count`,
	)
		.bind(id, note ? clipMarked(note, QUEUE_NOTE_CHARS) : null, Date.now(), opts.reason ?? null)
		.first<{ deferral_count: number | null }>();
	return row ? { requeued: true, deferralSeq: row.deferral_count } : { requeued: false, deferralSeq: null };
}

/**
 * Every entry on the instance, ANY status, newest first, one page at a time (#1017) — the history the
 * pending-only `listQueue` deliberately is not. Ordered by `created_at` then `id`, so a page boundary
 * is stable even for entries queued in the same millisecond.
 */
export async function listQueueHistory(
	env: Env,
	instanceId: string,
	userId: string,
	page: { offset: number; limit: number; after?: Keyset | null },
): Promise<{ entries: ObjectiveQueueEntry[]; total: number; offset: number; nextOffset: number | null; nextCursor: string | null; more: boolean }> {
	// `after` (#1017): a keyset page, strictly older than the last entry the reader saw — stable under
	// entries queued or removed between reads. Without it, the legacy OFFSET page, which they shift.
	const after = page.after ?? null;
	const offset = after ? 0 : Math.max(0, Math.trunc(page.offset) || 0);
	const limit = Math.max(1, Math.min(100, Math.trunc(page.limit) || 50));
	const keyset = after ? ` AND ${olderThan("created_at", "id", 5)}` : "";
	const res = await env.DB.prepare(`SELECT ${COLUMNS} FROM instance_objective_queue WHERE instance_id = ?1 AND user_id = ?2${keyset} ORDER BY created_at DESC, id DESC LIMIT ?3 OFFSET ?4`)
		.bind(instanceId, userId, limit + 1, offset, ...(after ? [after.at, after.id] : []))
		.all<ObjectiveQueueRow>();
	const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM instance_objective_queue WHERE instance_id = ?1 AND user_id = ?2").bind(instanceId, userId).first<{ n: number }>();
	const rows = (res.results ?? []).map(toEntry);
	const entries = rows.slice(0, limit);
	const more = rows.length > limit;
	const last = entries[entries.length - 1];
	return {
		entries,
		total: Number(count?.n ?? 0),
		offset,
		nextOffset: !after && more ? offset + entries.length : null,
		nextCursor: more && last ? keysetCursor(last.createdAt, last.id) : null,
		more,
	};
}
