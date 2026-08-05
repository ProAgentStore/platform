/**
 * Pipeline run records (issue #98, epic #94). One row per declarative-pipeline run,
 * with a real lifecycle: OPEN at kick (status 'running'), UPDATE counts as the runner
 * walks, CLOSE at finish/crash. This makes counts (seen/added/skipped/errors) FIRST-CLASS
 * — captured by the runner, not reconstructed from the trace — which is the #98 mandate.
 *
 * Distinct from the append-only trace (lib/events.ts): a trace event can't be UPDATED to
 * carry a moving count nor closed with a terminal status, so runs get their own table
 * (migration 0052). The two share `runId` (the run's traceId), so the trace is the
 * step-by-step detail behind a run row.
 *
 * Like error-log / events, writes are best-effort and NEVER throw — observability must not
 * break the path it observes. Read back via GET /v1/instances/:id/pipeline-runs + the MCP
 * `list_pipeline_runs` tool (owner-scoped).
 */
import { closePipelineRunCard, upsertPipelineRunCard } from "./pipeline-board.js";
import type { Env } from "../types.js";

export type RunStatus = "running" | "completed" | "failed" | "interrupted";

export interface RunCounts {
	seen: number;
	added: number;
	skipped: number;
	errors: number;
}

export interface PipelineRunRow {
	run_id: string;
	user_id: string;
	instance_id: string;
	pipeline: string;
	trigger: string;
	status: RunStatus;
	params: Record<string, unknown> | null;
	started_at: number;
	finished_at: number | null;
	seen: number;
	added: number;
	skipped: number;
	errors: number;
	detail: string | null;
}

/** Open a run record at kick. Best-effort; never throws. */
export async function openRun(
	env: Env,
	r: { runId: string; userId: string; instanceId: string; pipeline: string; trigger: string; params?: Record<string, unknown> },
): Promise<void> {
	try {
		await env.DB.prepare(
			"INSERT OR IGNORE INTO pipeline_runs (run_id, user_id, instance_id, pipeline, trigger, status, params, started_at) VALUES (?1, ?2, ?3, ?4, ?5, 'running', ?6, ?7)",
		)
			.bind(
				r.runId,
				r.userId,
				r.instanceId,
				String(r.pipeline).slice(0, 200),
				String(r.trigger).slice(0, 32),
				r.params ? JSON.stringify(r.params).slice(0, 4000) : null,
				Date.now(),
			)
			.run();
		// The run also goes on the work board, so a pipeline agent is visible to the unified board
		// and to a supervisor while it runs (#207A) — not only in its own runs table.
		await upsertPipelineRunCard(env, {
			instanceId: r.instanceId,
			userId: r.userId,
			runId: r.runId,
			pipeline: String(r.pipeline).slice(0, 200),
			trigger: String(r.trigger).slice(0, 32),
			status: "running",
		});
		// Opportunistic retention: no cron, so ~1% of writes prune rows older than 30 days.
		if (Math.random() < 0.01) {
			await env.DB.prepare("DELETE FROM pipeline_runs WHERE created_at < datetime('now', '-30 days')").run().catch(() => undefined);
		}
	} catch (err) {
		console.error("[pipeline-runs] openRun failed:", err instanceof Error ? err.message : String(err));
	}
}

/** Close a run record with a terminal status + final counts + optional detail. Best-effort. */
export async function closeRun(
	env: Env,
	runId: string,
	status: Exclude<RunStatus, "running">,
	counts: RunCounts,
	detail?: string,
): Promise<void> {
	try {
		await env.DB.prepare(
			"UPDATE pipeline_runs SET status = ?2, finished_at = ?3, seen = ?4, added = ?5, skipped = ?6, errors = ?7, detail = ?8 WHERE run_id = ?1",
		)
			.bind(
				runId,
				status,
				Date.now(),
				counts.seen | 0,
				counts.added | 0,
				counts.skipped | 0,
				counts.errors | 0,
				detail != null ? String(detail).slice(0, 2000) : null,
			)
			.run();
		// AFTER the row is updated, so the card reads back the terminal state, and here rather than
		// at the four `closeRun` call sites in `workflows/pipeline-run.ts` — one choke point is how
		// #206 avoided stranding cards on the paths nobody remembered to wire.
		const counted = `${counts.seen | 0} seen · ${counts.added | 0} added${counts.errors ? ` · ${counts.errors | 0} error(s)` : ""}`;
		await closePipelineRunCard(env, runId, status, detail ? `${detail} — ${counted}` : counted);
	} catch (err) {
		console.error("[pipeline-runs] closeRun failed:", err instanceof Error ? err.message : String(err));
	}
}

/**
 * List an owner's pipeline runs on one instance, most-recent first. Always scoped to
 * (userId, instanceId). Optional `pipeline` narrows to one pipeline's history.
 */
export async function listRuns(
	env: Env,
	opts: { userId: string; instanceId: string; pipeline?: string; limit?: number },
): Promise<PipelineRunRow[]> {
	const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
	const where = ["user_id = ?1", "instance_id = ?2"];
	const binds: unknown[] = [opts.userId, opts.instanceId];
	if (opts.pipeline) {
		binds.push(opts.pipeline);
		where.push(`pipeline = ?${binds.length}`);
	}
	const sql = `SELECT run_id, user_id, instance_id, pipeline, trigger, status, params, started_at, finished_at, seen, added, skipped, errors, detail FROM pipeline_runs WHERE ${where.join(" AND ")} ORDER BY started_at DESC LIMIT ${limit}`;
	const res = await env.DB.prepare(sql).bind(...binds).all<Omit<PipelineRunRow, "params"> & { params: string | null }>();
	return (res.results ?? []).map((row) => ({
		...row,
		status: row.status as RunStatus,
		params: row.params ? (JSON.parse(row.params) as Record<string, unknown>) : null,
	}));
}
