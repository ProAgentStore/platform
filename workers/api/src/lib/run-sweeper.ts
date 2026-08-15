// Close out runs whose driver died (#207C).
//
// `agent_loop_runs` and `pipeline_runs` are opened by a Cloudflare Workflow and closed by that same
// Workflow. Both have code defenses — `agent-loop.ts` force-closes in a catch, `coding-session.ts`
// closes on the no-runner path — but neither survives an isolate death, an exhausted retry budget,
// or a deploy landing mid-run. What is left is a row that says `running` forever, with an
// `iteration` frozen at whatever it last reached.
//
// That is not merely untidy. `subordinate_status` reported it as work in flight, so a supervisor
// kept waiting on an agent that stopped hours ago — the same reasoning already written into
// `coding-session.ts`: "a `running` row nobody will ever close is worse than a failed one, because
// the supervisor keeps waiting". This removes the row; #589 removed the misreport that made it
// dangerous while it lived, by making `subordinate_status` report `runHealth`'s verdict instead of
// the raw column. The two are complementary and neither replaces the other: the sweeper needs 3
// hours of silence before it will call a run dead, and the verdict is honest from minute 15.
//
// It also weakens the case for ever unifying the run tables: more write paths into one table means
// more ways to strand a row, and a stranded row is permanent data.
import { closeCodingSessionCards } from "./coding-board.js";
import { logUnhandled } from "./on-error.js";
import type { Env } from "../types.js";

/**
 * How long a run may be silent before it is presumed dead.
 *
 * Deliberately generous. The longest LEGITIMATE silence is a Pilot parked in a human handoff:
 * `HANDOFF_WAIT_POLLS` bounds one wait at 15 minutes, and a run can take several across its rounds.
 * A single Engine turn on a large refactor can also run long with no `action` event to report. 3h
 * gives an order of magnitude of headroom, because the two errors are not symmetric: sweeping a
 * LIVE run tells a supervisor its subordinate failed while it is still working, whereas sweeping
 * late merely delays a correction the supervisor can already infer from `quietForMinutes`.
 */
export const STALE_RUN_MS = 3 * 60 * 60_000;

/** Bound on one pass, so a backlog drains over several minutes instead of one huge statement. */
const SWEEP_LIMIT = 200;

const DETAIL = "No progress for over 3 hours — the run's workflow is gone. Closed by the sweeper; start it again if you still need it.";

export interface SweepResult {
	loopRuns: number;
	pipelineRuns: number;
}

/**
 * Sweep both run tables. Best-effort and idempotent: if the driver turns out to be alive after all,
 * its own terminal write lands afterwards and wins, leaving the correct outcome.
 */
export async function sweepStaleRuns(env: Env, now: number = Date.now()): Promise<SweepResult> {
	const cutoff = now - STALE_RUN_MS;
	const [loopRuns, pipelineRuns] = await Promise.all([
		sweepLoopRuns(env, cutoff, now),
		sweepPipelineRuns(env, cutoff, now),
	]);
	return { loopRuns, pipelineRuns };
}

async function sweepLoopRuns(env: Env, cutoff: number, now: number): Promise<number> {
	// LIVENESS, not progress (#580). This predicate read `last_progress_at`, which is why
	// `coding-session.ts`'s pause tick had to write that column on a timer — the heartbeat existed
	// to defeat this WHERE clause, and defeating it also destroyed the platform's only stall signal.
	// 0127 gives the heartbeat its own column, so the two requirements stop fighting: a parked run
	// keeps `last_alive_at` fresh and survives here exactly as it did before, while
	// `last_progress_at` is free to go stale and mean something.
	//
	// The COALESCE chain is the compatibility story and the null story at once: `last_alive_at` is
	// null on every row written before 0127 and on a run that died before its first tick, so it
	// falls back to the column this used to read and then to `started_at` — the same fallback
	// order `runHealth` uses, which is what keeps the sweeper and the platform's stall verdict
	// reading the same signal.
	//
	// This comment used to claim the agreement was with `summarizeSubordinates`'s "quiet", and that
	// was false (#589). That function computes `quietForMinutes` from `lastProgressAt ?? startedAt`
	// — PROGRESS, deliberately, and now labelled as a fact rather than a verdict — while this reads
	// the heartbeat first. The two measure different things ON PURPOSE (`work-report.ts:136-141`:
	// a long healthy engine turn looks stale on progress and fresh on liveness), so an assertion
	// that they agree was not merely wrong, it argued for making one of them worse. The agreement
	// that does hold, and the one worth stating, is with `runHealth`.
	const { results } = await env.DB.prepare(
		`SELECT run_id, instance_id, user_id, session_id FROM agent_loop_runs
		  WHERE status = 'running' AND COALESCE(last_alive_at, last_progress_at, started_at) < ?1
		  LIMIT ?2`,
	)
		.bind(cutoff, SWEEP_LIMIT)
		.all<{ run_id: string; instance_id: string; user_id: string; session_id: string | null }>();
	const rows = results ?? [];
	const ids = rows.map((r) => r.run_id);
	if (!ids.length) return 0;
	// `failed`, not `escalated`: nothing about a dead workflow says a human can resolve it by
	// answering a question. `statusFor("failed")` is the `failed` status, which is honest.
	const res = await env.DB.prepare(
		`UPDATE agent_loop_runs
		    SET status = 'failed', stop_reason = 'failed', detail = ?1, finished_at = ?2
		  WHERE status = 'running' AND run_id IN (${ids.map((_, i) => `?${i + 3}`).join(",")})`,
	)
		.bind(DETAIL, now, ...ids)
		.run();
	// …and the BOARD CARD the same run left open (#553 AC 3).
	//
	// This closed the run row and left its card alone, so `csess_22d08431` sat in "Running" 16
	// hours after its run had died — the board, which is the surface somebody actually looks at,
	// showing an in-flight job for a workflow that no longer existed. The link is
	// `agent_loop_runs.session_id` (0116, #465), written once by `codingDriver` at run-create time
	// and null for chat and pipeline runs, which is exactly the rows that have no coding card.
	//
	// `failed` because that is what was just recorded for the run, and through the OPEN-ONLY close:
	// if the workflow turns out to be alive after all, its own terminal write lands afterwards and
	// wins — the same rule this file's header already states for the run rows themselves.
	const coding = rows.filter((r) => r.session_id);
	for (const r of coding) {
		await closeCodingSessionCards(env, r.instance_id, r.user_id, [r.session_id as string], "failed").catch(() => undefined);
	}
	return res.meta?.changes ?? 0;
}

async function sweepPipelineRuns(env: Env, cutoff: number, now: number): Promise<number> {
	// `started_at` only — pipeline_runs has no progress column. Its counts move via `updateCounts`
	// but carry no timestamp, so the whole run is measured from its start. Acceptable at a 3h
	// threshold: a pipeline run that legitimately takes longer than that does not exist today.
	const { results } = await env.DB.prepare(
		"SELECT run_id FROM pipeline_runs WHERE status = 'running' AND started_at < ?1 LIMIT ?2",
	)
		.bind(cutoff, SWEEP_LIMIT)
		.all<{ run_id: string }>();
	const ids = (results ?? []).map((r) => r.run_id);
	if (!ids.length) return 0;
	// `interrupted` already means exactly this in the pipeline vocabulary — no new status needed.
	const res = await env.DB.prepare(
		`UPDATE pipeline_runs
		    SET status = 'interrupted', finished_at = ?1, detail = ?2
		  WHERE status = 'running' AND run_id IN (${ids.map((_, i) => `?${i + 3}`).join(",")})`,
	)
		.bind(now, DETAIL, ...ids)
		.run();
	return res.meta?.changes ?? 0;
}

/** Cron entry point — never throws, logs to the durable error log like the other sweeps. */
export async function runStaleRunSweep(env: Env): Promise<void> {
	try {
		await sweepStaleRuns(env);
	} catch (err) {
		await logUnhandled(env, err, { path: "scheduled:run-sweeper", method: "CRON" }).catch(() => undefined);
	}
}
