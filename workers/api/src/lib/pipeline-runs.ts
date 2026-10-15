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
import { logError } from "./error-log.js";

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

/**
 * Open a run record at kick. Best-effort; never throws. Returns whether the RECORD landed — a
 * failure is written to the durable error log (#1086), not just the worker console, so a run with
 * no row (or no board card) is explained rather than merely missing.
 */
export async function openRun(
	env: Env,
	r: { runId: string; userId: string; instanceId: string; pipeline: string; trigger: string; params?: Record<string, unknown> },
): Promise<boolean> {
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
	} catch (err) {
		await recordBookkeepingFailure(env, "open", r.runId, r.userId, r.instanceId, err);
		return false;
	}
	// The run also goes on the work board, so a pipeline agent is visible to the unified board
	// and to a supervisor while it runs (#207A) — not only in its own runs table. The row has
	// landed by now, so a card failure is its own, smaller fact.
	try {
		await upsertPipelineRunCard(env, {
			instanceId: r.instanceId,
			userId: r.userId,
			runId: r.runId,
			pipeline: String(r.pipeline).slice(0, 200),
			trigger: String(r.trigger).slice(0, 32),
			status: "running",
		});
	} catch (err) {
		await recordBookkeepingFailure(env, "card", r.runId, r.userId, r.instanceId, err);
	}
	// Opportunistic retention: no cron, so ~1% of writes prune rows older than 30 days.
	if (Math.random() < 0.01) {
		await env.DB.prepare("DELETE FROM pipeline_runs WHERE created_at < datetime('now', '-30 days')").run().catch(() => undefined);
	}
	return true;
}

/**
 * A run record that could not be written is a durable diagnostic (#1086). Before this both halves
 * only reached `console.error`, and `closeRun` never threw — so the crash handler's
 * `closeRun(…).catch(log)` could never fire, and a failed close left a run `running` forever with
 * nothing anywhere saying why.
 */
async function recordBookkeepingFailure(env: Env, op: "open" | "close" | "card", runId: string, userId: string | null, instanceId: string | null, err: unknown): Promise<void> {
	const message = err instanceof Error ? err.message : String(err);
	console.error(`[pipeline-runs] ${op} failed:`, message);
	const what = {
		open: `could not open the record for run ${runId}: ${message}`,
		close: `could not close run ${runId} — its record may still read 'running': ${message}`,
		card: `run ${runId} is recorded, but its board card could not be updated: ${message}`,
	}[op];
	await logError(env, {
		source: "pipeline-run-record",
		status: 500,
		message: what,
		userId,
		context: { instanceId, runId },
	}).catch(() => undefined);
}

/**
 * Close a run record with a terminal status + final counts + optional detail. Never throws; returns
 * whether it closed, and a failure is in the durable error log under the run (#1086).
 */
export async function closeRun(
	env: Env,
	runId: string,
	status: Exclude<RunStatus, "running">,
	counts: RunCounts,
	detail?: string,
): Promise<boolean> {
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
	} catch (err) {
		const owner = await runOwner(env, runId);
		await recordBookkeepingFailure(env, "close", runId, owner?.user_id ?? null, owner?.instance_id ?? null, err);
		return false;
	}
	// AFTER the row is updated, so the card reads back the terminal state, and here rather than
	// at the four `closeRun` call sites in `workflows/pipeline-run.ts` — one choke point is how
	// #206 avoided stranding cards on the paths nobody remembered to wire.
	const counted = `${counts.seen | 0} seen · ${counts.added | 0} added${counts.errors ? ` · ${counts.errors | 0} error(s)` : ""}`;
	try {
		await closePipelineRunCard(env, runId, status, detail ? `${detail} — ${counted}` : counted);
	} catch (err) {
		const owner = await runOwner(env, runId);
		await recordBookkeepingFailure(env, "card", runId, owner?.user_id ?? null, owner?.instance_id ?? null, err);
	}
	return true;
}

/** The run's owner and instance, for a diagnostic. Never throws — it runs on a path already failing. */
async function runOwner(env: Env, runId: string): Promise<{ user_id: string; instance_id: string } | null> {
	try {
		return await env.DB.prepare("SELECT user_id, instance_id FROM pipeline_runs WHERE run_id = ?1").bind(runId).first<{ user_id: string; instance_id: string }>();
	} catch {
		return null;
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
