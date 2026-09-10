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

import type { Env } from "../types.js";

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
}

const COLUMNS =
	"id, instance_id, repo_id, user_id, objective, max_iterations, metadata, status, stop_reason, run_id, created_at, started_at, finished_at";

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
	};
}

/** The same bound `objective` cap `createLoopRun` and `POST /loop` already enforce. */
const OBJECTIVE_MAX = 2000;

export interface EnqueueInput {
	instanceId: string;
	/** Which repo this objective is for. Omit/null for "any" — see the migration. */
	repoId?: string | null;
	userId: string;
	objective: string;
	maxIterations?: number | null;
	metadata?: string | null;
}

/**
 * Add one objective to the back of the queue.
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
		   (id, instance_id, repo_id, user_id, objective, max_iterations, metadata, status, created_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8)`,
	)
		.bind(id, input.instanceId, input.repoId ?? null, input.userId, objective, input.maxIterations ?? null, input.metadata ?? null, createdAt)
		.run();
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
	};
}

/**
 * What is still waiting, oldest first.
 *
 * With a `repoId` this is the ELIGIBLE set for that repo — its own entries plus the repo-agnostic
 * ones — which is the same predicate `dequeueNext` claims from, so a caller can see exactly what
 * the next drain will take. Without one it is everything pending on the instance.
 */
export async function listQueue(env: Env, instanceId: string, repoId?: string | null): Promise<ObjectiveQueueEntry[]> {
	const res =
		repoId === undefined
			? await env.DB.prepare(
					`SELECT ${COLUMNS} FROM instance_objective_queue
					  WHERE instance_id = ?1 AND status = 'pending'
					  ORDER BY created_at ASC, id ASC`,
				)
					.bind(instanceId)
					.all<ObjectiveQueueRow>()
			: await env.DB.prepare(
					// `repo_id = ?2` is NULL (not true) when ?2 is null, so this one predicate serves both
					// the named-repo case and the chat-driver case — the latter correctly seeing only the
					// repo-agnostic entries.
					`SELECT ${COLUMNS} FROM instance_objective_queue
					  WHERE instance_id = ?1 AND status = 'pending' AND (repo_id IS NULL OR repo_id = ?2)
					  ORDER BY created_at ASC, id ASC`,
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
	return (res.meta?.changes ?? 0) > 0;
}

/** How many candidates one dequeue will try before giving up to a concurrent drain. */
const CLAIM_CANDIDATES = 5;

/**
 * Claim the oldest eligible entry, atomically.
 *
 * D1 has no `SELECT … FOR UPDATE`, so the claim is the conditional UPDATE: `status = 'pending'` in
 * the predicate means exactly one of two concurrent drains can move a given row, and `changes`
 * reports which one did. The SELECT above it only proposes candidates — it is never trusted, which
 * is why losing the race walks to the next row rather than returning null. Both terminal paths of a
 * run can fire close together (the workflow's own drain and a retried step), and two drains starting
 * the SAME objective twice is the failure this shape exists to make impossible.
 */
export async function dequeueNext(env: Env, instanceId: string, repoId: string | null): Promise<ObjectiveQueueEntry | null> {
	const candidates = await env.DB.prepare(
		`SELECT ${COLUMNS} FROM instance_objective_queue
		  WHERE instance_id = ?1 AND status = 'pending' AND (repo_id IS NULL OR repo_id = ?2)
		  ORDER BY created_at ASC, id ASC
		  LIMIT ?3`,
	)
		.bind(instanceId, repoId ?? null, CLAIM_CANDIDATES)
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
}

/**
 * Put a claimed entry back at its ORIGINAL place in the queue.
 *
 * For the one failure that is not the entry's fault: the drain raced another start and was told the
 * repo is busy again. `created_at` is untouched, so it keeps its position — re-enqueueing would send
 * a first-in-line objective to the back of the queue for losing a race it never entered.
 */
export async function requeueEntry(env: Env, id: string): Promise<void> {
	await env.DB.prepare(
		`UPDATE instance_objective_queue
		    SET status = 'pending', started_at = NULL
		  WHERE id = ?1 AND status = 'running'`,
	)
		.bind(id)
		.run();
}
