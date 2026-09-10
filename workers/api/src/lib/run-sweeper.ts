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
import { MAX_PARK_MS, PARK_LIMIT_MS } from "./work-report.js";
import { RUN_WAIT_REASONS } from "./agent-loop-store.js";
import { statusFor, type LoopStopReason } from "./agent-loop.js";
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

/**
 * How long a requested cancel may go unanswered before the sweeper lands it itself (#790).
 *
 * `requestCancel` is a FLAG WRITE and nothing more, and the flag has exactly two readers, both
 * inside the running workflow: the per-snapshot poll in `capture()` and the pause `tick()`. A
 * workflow that has thrown for a journal replay — or died — executes neither, so `stop_work`
 * truthfully reports "requested", `check_work` reports "a cancel has been requested" forever, and
 * nothing ever converts the flag into a terminal row. Measured on run fe53a0c1: three polls over
 * two minutes, no change, and the run was still `running` when a replacement was started on top
 * of it.
 *
 * Five minutes because both in-workflow readers run far more often than that — the capture poll
 * every cycle, the pause tick about once a minute — so a live run has had many chances by then. It
 * is a backstop for a driver that is GONE, never a race with one that is working.
 */
export const CANCEL_ENFORCE_MS = 5 * 60_000;

/** Bound on one pass, so a backlog drains over several minutes instead of one huge statement. */
const SWEEP_LIMIT = 200;

const DETAIL = "No progress for over 3 hours — the run's workflow is gone. Closed by the sweeper; start it again if you still need it.";

const CANCEL_DETAIL =
	"You asked this run to stop and nothing was left running to hear it, so the platform stopped it. " +
	"Anything the engine had already written to the repository is still there.";

const PARK_DETAIL =
	"This run parked waiting to be resumed and never came back, so the platform closed it. " +
	"It did not report either way — check the repository before starting the objective again.";

export interface SweepResult {
	loopRuns: number;
	pipelineRuns: number;
	/** Runs whose requested cancel was landed by the sweeper because nothing else did (#790). */
	cancelledRuns: number;
	/** Runs reaped for sitting parked past what their park reason is worth (#790). */
	wedgedParks: number;
}

/**
 * Sweep both run tables. Best-effort and idempotent: if the driver turns out to be alive after all,
 * its own terminal write lands afterwards and wins, leaving the correct outcome.
 */
export async function sweepStaleRuns(env: Env, now: number = Date.now()): Promise<SweepResult> {
	const cutoff = now - STALE_RUN_MS;
	// The cancel and park passes run BEFORE the 3h staleness pass, and the order is deliberate: both
	// describe a run more precisely than "silent for three hours" does, and whichever pass gets there
	// first writes the `detail` an owner reads. "You asked it to stop" and "it never came back from a
	// replay" are the two true accounts of the incident's run; "no progress for over 3 hours" is a
	// third that is also true and tells them nothing about either.
	const cancelledRuns = await enforceCancelledRuns(env, now);
	const wedgedParks = await sweepWedgedParks(env, now);
	const [loopRuns, pipelineRuns] = await Promise.all([
		sweepLoopRuns(env, cutoff, now),
		sweepPipelineRuns(env, cutoff, now),
	]);
	return { loopRuns, pipelineRuns, cancelledRuns, wedgedParks };
}

/**
 * Land a cancel the workflow never read (#790, symptom 2) — the independent enforcer.
 *
 * TWO conditions, and needing both is the whole design:
 *
 *   the cancel is old      `cancel_requested_at` (0150). Elapsed time is the question, and the
 *                          boolean alone could not answer it.
 *   nothing has been alive  `last_alive_at`. A run in a long engine turn heartbeats from the capture
 *   since                   loop, so its own cooperative stop is still coming — and taking it out
 *                           from underneath would strand the budget reservation the in-flight step
 *                           holds, which is exactly what `requestCancel` is cooperative to avoid.
 *
 * So this fires only for "somebody asked it to stop, and there has been nobody home since to hear
 * it". `cancelled`, not `failed`: a human asked, the run stopped, and `statusFor("cancelled")` is
 * the `cancelled` status — reporting the owner's own stop as a failure would be a worse lie than
 * the stuck row it replaces.
 */
async function enforceCancelledRuns(env: Env, now: number): Promise<number> {
	const cutoff = now - CANCEL_ENFORCE_MS;
	const { results } = await env.DB.prepare(
		`SELECT run_id, instance_id, user_id, session_id FROM agent_loop_runs
		  WHERE status = 'running'
		    AND cancel_requested = 1
		    AND COALESCE(cancel_requested_at, started_at) < ?1
		    AND COALESCE(last_alive_at, last_progress_at, started_at) < ?1
		  LIMIT ?2`,
	)
		.bind(cutoff, SWEEP_LIMIT)
		.all<{ run_id: string; instance_id: string; user_id: string; session_id: string | null }>();
	return closeRuns(env, results ?? [], now, "cancelled", CANCEL_DETAIL, "cancelled");
}

/**
 * Reap a run parked past what its park is worth (#790, symptom 1).
 *
 * The sweeper needs its own pass here because the 3h staleness predicate reads `last_alive_at`, and
 * a parked run keeps that column FRESH on purpose — 0127 gave the pause tick its own column
 * precisely so a legitimately parked run would survive the cutoff. That protection is right, and it
 * also means a run that parks forever while still ticking is invisible to every existing pass.
 *
 * The budget is per reason ({@link PARK_LIMIT_MS}), read from the same table `runHealth` uses, so
 * the sweeper cannot reap a run the platform is still calling `waiting` — the two would otherwise
 * disagree about the same row, which is the class of defect #589 is about. A park with a published
 * `waiting_until` still in the future is excluded for the same reason `parkOverrun` excludes it:
 * the platform stated when that park ends and a table has no business overriding a fact.
 *
 * `interrupted`, not `failed`: the objective never reported either way, which is exactly what that
 * reason means (#546), and `statusFor` puts it in `needs_human` — the honest column for a run whose
 * work may be half-done on disk.
 */
async function sweepWedgedParks(env: Env, now: number): Promise<number> {
	// One statement per reason rather than a CASE, so the budget bound into the query is the same
	// value `runHealth` reads for that reason and a new park reason cannot inherit somebody else's.
	const out: Array<{ run_id: string; instance_id: string; user_id: string; session_id: string | null }> = [];
	for (const reason of RUN_WAIT_REASONS) {
		const cutoff = now - (PARK_LIMIT_MS[reason] ?? MAX_PARK_MS);
		const { results } = await env.DB.prepare(
			`SELECT run_id, instance_id, user_id, session_id FROM agent_loop_runs
			  WHERE status = 'running'
			    AND waiting_reason = ?1
			    AND COALESCE(parked_since, last_alive_at, last_progress_at, started_at) < ?2
			    AND (waiting_until IS NULL OR waiting_until < ?3)
			  LIMIT ?4`,
		)
			.bind(reason, cutoff, now, SWEEP_LIMIT)
			.all<{ run_id: string; instance_id: string; user_id: string; session_id: string | null }>();
		out.push(...(results ?? []));
	}
	return closeRuns(env, out, now, "interrupted", PARK_DETAIL, "failed");
}

/**
 * Close a batch of run rows and the board cards they left open.
 *
 * Extracted because there are now three passes doing it and the CARD half is the part that gets
 * forgotten — `csess_22d08431` sat in "Running" for 16 hours because the run row was closed and its
 * card was not (#553 AC 3). One helper means a new pass gets the card close by construction.
 *
 * `status = 'running'` stays in the WHERE clause: if the workflow turns out to be alive after all,
 * its own terminal write lands afterwards and wins, which is this file's standing rule.
 */
async function closeRuns(
	env: Env,
	rows: Array<{ run_id: string; instance_id: string; user_id: string; session_id: string | null }>,
	now: number,
	stopReason: string,
	detail: string,
	// The CARD's vocabulary, which is narrower than the run row's on purpose: `needs_human` is not a
	// terminal card state (`closeCodingSessionCards` excludes it), because a card that needs somebody
	// is still open. So a wedged park records `interrupted`/`needs_human` on the RUN — the precise
	// verdict — and closes its card `failed`, which is the terminal state that does not claim success.
	cardStatus: "failed" | "cancelled" | "completed",
): Promise<number> {
	const ids = rows.map((r) => r.run_id);
	if (!ids.length) return 0;
	const res = await env.DB.prepare(
		`UPDATE agent_loop_runs
		    SET status = ?1, stop_reason = ?2, detail = ?3, finished_at = ?4
		  WHERE status = 'running' AND run_id IN (${ids.map((_, i) => `?${i + 5}`).join(",")})`,
	)
		.bind(statusFor(stopReason as LoopStopReason), stopReason, detail, now, ...ids)
		.run();
	for (const r of rows.filter((r) => r.session_id)) {
		await closeCodingSessionCards(env, r.instance_id, r.user_id, [r.session_id as string], cardStatus).catch(() => undefined);
	}
	return res.meta?.changes ?? 0;
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
	// `failed`, not `escalated`: nothing about a dead workflow says a human can resolve it by
	// answering a question. `statusFor("failed")` is the `failed` status, which is honest.
	//
	// Through `closeRuns` since #790, which also closes the BOARD CARD this run left open (#553
	// AC 3) — the half that gets forgotten. `csess_22d08431` sat in "Running" for 16 hours because
	// the run row was closed and its card was not, so the board, which is the surface somebody
	// actually looks at, showed an in-flight job for a workflow that no longer existed. The link is
	// `agent_loop_runs.session_id` (0116, #465), written once by `codingDriver` at run-create time
	// and null for chat and pipeline runs, which is exactly the rows that have no coding card.
	return closeRuns(env, results ?? [], now, "failed", DETAIL, "failed");
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
