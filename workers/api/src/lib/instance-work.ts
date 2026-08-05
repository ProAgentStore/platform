// Cross-instance reads of the platform's own work records (#205).
//
// Every existing read of `instance_runtime_tasks` and `agent_loop_runs` is scoped to ONE instance
// (`mirroredRuntimeTasks`, `buildInstanceBoard`, `listLoopRuns`). A supervisor needs the same data
// for its whole team in one call, so these are the cross-instance counterparts.
//
// DELIBERATELY IMPORTS ONLY `../types.js`. These are the tables a supervisor is allowed to know
// about — generic, written by every agent family. The moment this file imports a domain module
// (coding-store, apply-loop, repo-ingest) the supervision path has learned about a domain, which
// is the coupling migration 0063 removed and a first attempt at this feature re-introduced
// (reverted in 3f14bd3). Notably that also rules out reusing `board.ts`'s payload helpers: board.ts
// imports `routes/instances-runtime.js`, and pulling a routes module in here would drag the whole
// Hono router into the supervision path. The title/detail extraction below is a deliberate small
// duplicate of `board.ts:224` for that reason.
import type { Env } from "../types.js";

/** One card off an agent's board. `kind`/`status` are the writer's own words, not a platform enum. */
export interface WorkItem {
	instanceId: string;
	id: string;
	/** `instance_runtime_tasks.type`, verbatim: "delegation" | "job.apply_agent" | "ticket" | … */
	kind: string;
	/** Free text, written by whichever domain created the card. Bucket it via the agent's own
	 *  declared `boardColumns` — never against a list held here. */
	status: string;
	title: string;
	detail: string;
	updatedAt: string;
}

/** One durable run. Unlike `WorkItem.status`, `status` here IS a closed platform enum (0062). */
export interface RunItem {
	instanceId: string;
	runId: string;
	objective: string;
	status: string;
	stopReason: string | null;
	detail: string | null;
	iteration: number;
	maxIterations: number;
	startedAt: number;
	finishedAt: number | null;
	lastProgressAt: number | null;
}

/** Per-instance row cap. Clamped so a caller can't turn one tool call into an unbounded read. */
const clampPer = (n: number | undefined, dflt: number) => Math.max(1, Math.min(25, Math.floor(n ?? dflt)));

/**
 * Build a `UNION ALL` of one indexed branch per instance.
 *
 * NOT a flat `WHERE instance_id IN (…) ORDER BY … LIMIT n`: that returns the globally most recent
 * n rows, so one busy subordinate crowds out the other eleven and the supervisor sees a team of
 * one. Per-instance branches each get their own LIMIT.
 *
 * Each branch is an equality seek on the instance index with the sort satisfied by the index, so
 * this is 12 seeks in one round trip rather than 12 round trips. `ROW_NUMBER() OVER (PARTITION BY
 * …)` would be tidier but has zero precedent in this repo and is unverified on D1.
 */
function unionAll(branch: (idParam: number) => string, count: number): string {
	const parts: string[] = [];
	for (let i = 0; i < count; i++) parts.push(`SELECT * FROM (${branch(i + 2)})`);
	return parts.join("\nUNION ALL\n");
}

interface TaskRow {
	instance_id: string;
	id: string;
	type: string;
	status: string;
	payload: string | null;
	updated_at: string;
}

/** A one-line description: the task's own, else the failure/outcome detail. Mirrors board.ts:224. */
function taskDetail(payload: Record<string, unknown>): string {
	if (typeof payload.description === "string" && payload.description) return payload.description;
	const out = payload.output;
	if (out && typeof out === "object" && !Array.isArray(out)) {
		const d = (out as Record<string, unknown>).detail;
		if (typeof d === "string" && d) return d;
	}
	if (typeof payload.result === "string") return payload.result;
	if (typeof payload.error === "string") return payload.error;
	return "";
}

/**
 * The most recent board cards for several instances, newest first per instance.
 *
 * `hidden = 0` is not optional: migration 0019 added it so a human can clear a finished card, and
 * omitting it resurrects everything they have ever dismissed.
 */
export async function recentWorkForInstances(
	env: Env,
	userId: string,
	instanceIds: readonly string[],
	perInstance?: number,
): Promise<WorkItem[]> {
	// An empty `UNION ALL` is a syntax error, and a supervisor with no links is perfectly ordinary.
	if (!instanceIds.length) return [];
	const limit = clampPer(perInstance, 8);
	const sql = unionAll(
		(p) =>
			`SELECT instance_id, id, type, status, payload, updated_at
			   FROM instance_runtime_tasks
			  WHERE instance_id = ?${p} AND user_id = ?1 AND hidden = 0
			  ORDER BY updated_at DESC LIMIT ${limit}`,
		instanceIds.length,
	);
	const res = await env.DB.prepare(sql)
		.bind(userId, ...instanceIds)
		.all<TaskRow>();
	return (res.results ?? []).map((r) => {
		let payload: Record<string, unknown> = {};
		try {
			const p = r.payload ? JSON.parse(r.payload) : {};
			if (p && typeof p === "object" && !Array.isArray(p)) payload = p as Record<string, unknown>;
		} catch {
			/* a corrupt payload still yields a card with its type + status */
		}
		const title = typeof payload.title === "string" && payload.title ? payload.title : r.type;
		return {
			instanceId: r.instance_id,
			id: r.id,
			kind: r.type,
			status: r.status,
			title: title.slice(0, 200),
			detail: taskDetail(payload).slice(0, 300),
			updatedAt: r.updated_at,
		};
	});
}

interface RunRow {
	instance_id: string;
	run_id: string;
	objective: string;
	status: string;
	stop_reason: string | null;
	detail: string | null;
	iteration: number;
	max_iterations: number;
	started_at: number;
	finished_at: number | null;
	last_progress_at: number | null;
}

/** The most recent durable runs for several instances, newest first per instance. */
export async function recentRunsForInstances(
	env: Env,
	userId: string,
	instanceIds: readonly string[],
	perInstance?: number,
): Promise<RunItem[]> {
	if (!instanceIds.length) return [];
	const limit = clampPer(perInstance, 5);
	const sql = unionAll(
		(p) =>
			`SELECT instance_id, run_id, objective, status, stop_reason, detail, iteration,
			        max_iterations, started_at, finished_at, last_progress_at
			   FROM agent_loop_runs
			  WHERE instance_id = ?${p} AND user_id = ?1
			  ORDER BY started_at DESC LIMIT ${limit}`,
		instanceIds.length,
	);
	const res = await env.DB.prepare(sql)
		.bind(userId, ...instanceIds)
		.all<RunRow>();
	return (res.results ?? []).map((r) => ({
		instanceId: r.instance_id,
		runId: r.run_id,
		objective: String(r.objective ?? "").slice(0, 300),
		status: r.status,
		stopReason: r.stop_reason,
		detail: r.detail ? r.detail.slice(0, 300) : null,
		iteration: r.iteration ?? 0,
		maxIterations: r.max_iterations ?? 0,
		startedAt: r.started_at,
		finishedAt: r.finished_at,
		lastProgressAt: r.last_progress_at ?? null,
	}));
}
