/**
 * Who holds a repo's checkout, and what keeps a coder busy — ONE definition (#1384).
 *
 * The rule used to be spelled out in about a dozen places (`coderIsIdle`, the auto-pickup admission, the repo start lock, the busy-holder
 * text, the park backstop, the ticket queue, ...), each a little different. Two of them disagreed in production: a coder with an answered
 * run parked on an away machine read BUSY to the idle check for ever, while an explicit start on its repo was accepted, and the timer sweep
 * skipped it with a bare `continue` and no log row (#1384). A fix to one copy (7131d1e0 bounded `coderIsIdle`) left the admission's copy
 * refusing, so the picker still could not start. This module owns the rule; every site builds its SQL from it.
 *
 * ── The two questions
 *
 *   OWNS the checkout  (the start lock; "who holds this repo")
 *       a run that is `running`, has not released its checkout, and is not parked on a machine that has been away.
 *   KEEPS THE CODER BUSY  (auto-pickup, triage; "does this coder have anything on")
 *       a run that owns its checkout, OR one that released it, has its answer in and is about to take it back (until its wake's grace is
 *       out) — it was there first, so auto-pickup does not start new work ahead of it.
 *
 * ── Why a run stops counting when its machine is away
 *
 * A run parked on a question resumes only on the machine it parked on (#1242). While that machine is gone nothing can resume it, so its
 * "hold" is a claim on a checkout nobody can touch — and it starved the coder for hours. Once the machine has been unseen for
 * {@link PARKED_MACHINE_AWAY_MS} the run stops counting. Nothing is done to the run: it keeps its answer and its set-aside work, and
 * resumes on its own machine when that comes back. A parked run whose machine is online, or whose machine was never recorded, still
 * counts: a dirty tree on a machine we can reach is not ours to override, and "unknown" is not "away".
 *
 * Cross-machine resume (continuing the run on another machine's checkout when its work is on origin) is deliberately NOT built here: it is
 * a larger, riskier change, and bounding the hold is the more reversible way to stop the starvation.
 */
import type { Env } from "../types.js";

/** How long an answered run a drain woke for its checkout has to take it back before the coder stops waiting for it (#1228). */
export const CHECKOUT_WAKE_GRACE_MS = 5 * 60_000;

/**
 * How long the machine a run parked on may go unseen before the run stops counting as holding anything. Longer than the 10 minutes the
 * backstop uses to decide whether a wake is worth sending (`PARKED_MACHINE_FRESH_MS`): a laptop that sleeps for a meeting must not lose
 * its hold, a machine gone for half an hour is away.
 */
export const PARKED_MACHINE_AWAY_MS = 30 * 60_000;

/** The `last_seen_at` cut-off, in epoch SECONDS (the column is a datetime), for a run parked at `now`. Bind it where `awayBind` points. */
export const awayCutoffSeconds = (now: number): number => Math.floor((now - PARKED_MACHINE_AWAY_MS) / 1000);
/** The `checkout_wake_at` cut-off, in epoch ms. Bind it where `graceBind` points. */
export const graceCutoffMs = (now: number): number => now - CHECKOUT_WAKE_GRACE_MS;

/**
 * SQL, true when run `r` is parked on a question and the machine it parked on has not been seen since the cut-off. False for a run that
 * is not parked, or that recorded no machine (parked before #1242, or the hostname named several): unknown is not away.
 * `awayBind` is the placeholder (`"?5"`) the caller binds {@link awayCutoffSeconds} to.
 */
export function parkedMachineAwaySql(r: string, awayBind: string): string {
	// COALESCE: `waiting_reason` is NULL on a run that is not parked, and `NULL = 'decision'` is NULL, which `NOT` leaves NULL — a WORKING run that
	// still carries a stale `parked_machine_id` from an earlier park would then silently stop counting. Every operand here is a plain boolean.
	return `(COALESCE(${r}.waiting_reason, '') = 'decision' AND ${r}.parked_machine_id IS NOT NULL AND NOT EXISTS (
	   SELECT 1 FROM instance_runtime_nodes hn WHERE hn.user_id = ${r}.user_id AND hn.machine_id = ${r}.parked_machine_id
	      AND hn.last_seen_at >= datetime(${awayBind}, 'unixepoch')))`;
}

/** SQL: run `r` OWNS its checkout — running, not released, and not parked on an away machine. The repo start lock's definition of a holder. */
export function ownsCheckoutSql(r: string, awayBind: string): string {
	return `(${r}.status = 'running' AND ${r}.checkout_released_at IS NULL AND NOT ${parkedMachineAwaySql(r, awayBind)})`;
}

/** SQL: run `r` has an answer (or an unresolved instruction) in that nothing has applied yet. */
export function answerUnappliedSql(r: string): string {
	return `EXISTS (SELECT 1 FROM coder_questions hq WHERE hq.run_id = ${r}.run_id AND hq.applied_at IS NULL AND (hq.answered_at IS NOT NULL OR hq.state = 'unresolved'))`;
}

/**
 * SQL: run `r` KEEPS THE CODER BUSY — it owns its checkout, or it released it, its answer is in and it has not yet been given up on
 * (never woken, or woken less than the grace ago), and in either case its machine is not away.
 */
export function keepsCoderBusySql(r: string, awayBind: string, graceBind: string): string {
	return `(${r}.status = 'running' AND NOT ${parkedMachineAwaySql(r, awayBind)}
	   AND (${r}.checkout_released_at IS NULL
	        OR ((${r}.checkout_wake_at IS NULL OR ${r}.checkout_wake_at > ${graceBind}) AND ${answerUnappliedSql(r)})))`;
}

/** Why a coder is busy, in the words the auto-pickup log and `coding_loop_status` use. */
export type BusyReason =
	| "running_work" // a run is working
	| "checkout_unreleased" // a run is parked on a question and still holds its checkout, on a machine that is up (or unknown)
	| "machine_away" // a run is parked on a machine that has gone quiet, but not for long enough to let go of it yet
	| "answer_unapplied" // a run released its checkout, its answer is in, and it has not resumed yet
	| "queued_work"; // an objective is pending in the queue

export interface CoderBlocker {
	reason: BusyReason;
	/** The run holding the coder, when it is a run. */
	runId: string | null;
	/** The pending queue entry, when it is a queued objective. */
	entryId: string | null;
	/** One sentence naming it, for a log row. No objective text, no secrets. */
	detail: string;
}

interface BlockerRow {
	run_id: string;
	released: number;
	parked: number;
	machine_id: string | null;
	machine_seen: string | null;
	parked_since: number | null;
}

const age = (ms: number): string => {
	const m = Math.max(0, Math.round(ms / 60_000));
	return m < 90 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};

/** What `last_seen_at` (a UTC `YYYY-MM-DD HH:MM:SS`) says, in ms epoch; null if unreadable. */
const seenMs = (s: string | null): number | null => {
	if (!s) return null;
	const t = Date.parse(`${s.replace(" ", "T")}Z`);
	return Number.isFinite(t) ? t : null;
};

/**
 * The first thing that keeps this coder busy, or null when it is idle. The SAME predicates as everything else here, so "busy" and "why" cannot
 * disagree: the run query is {@link keepsCoderBusySql}, the queue query is the pending entries the admission also refuses on.
 */
export async function coderBlocker(env: Pick<Env, "DB">, instanceId: string, now = Date.now()): Promise<CoderBlocker | null> {
	const run = await env.DB.prepare(
		`SELECT r.run_id, (r.checkout_released_at IS NOT NULL) AS released, (r.waiting_reason = 'decision') AS parked, r.parked_machine_id AS machine_id, r.parked_since,
		        (SELECT MAX(hn.last_seen_at) FROM instance_runtime_nodes hn WHERE hn.user_id = r.user_id AND hn.machine_id = r.parked_machine_id) AS machine_seen
		   FROM agent_loop_runs r
		  WHERE r.instance_id = ?1 AND ${keepsCoderBusySql("r", "?2", "?3")}
		  ORDER BY r.started_at ASC, r.run_id LIMIT 1`,
	)
		.bind(instanceId, awayCutoffSeconds(now), graceCutoffMs(now))
		.first<BlockerRow>();
	if (run) {
		if (run.released) return { reason: "answer_unapplied", runId: run.run_id, entryId: null, detail: `run ${run.run_id} released its checkout and has its answer, but has not resumed yet` };
		if (!run.parked) return { reason: "running_work", runId: run.run_id, entryId: null, detail: `run ${run.run_id} is working` };
		const seen = seenMs(run.machine_seen);
		// Quiet for longer than a heartbeat gap but not yet past the hold: say how long it will keep counting.
		if (run.machine_id && (seen === null || now - seen > 10 * 60_000)) {
			const quiet = seen === null ? "has not been seen" : `was last seen ${age(now - seen)} ago`;
			return { reason: "machine_away", runId: run.run_id, entryId: null, detail: `run ${run.run_id} is parked on a question with its checkout held; its machine ${quiet} and stops counting after ${age(PARKED_MACHINE_AWAY_MS)} unseen` };
		}
		return { reason: "checkout_unreleased", runId: run.run_id, entryId: null, detail: `run ${run.run_id} is parked on a question and still holds its checkout${run.parked_since ? ` (since ${new Date(run.parked_since).toISOString()})` : ""}` };
	}
	const queued = await env.DB.prepare("SELECT id FROM instance_objective_queue WHERE instance_id = ?1 AND status = 'pending' ORDER BY created_at ASC, id LIMIT 1").bind(instanceId).first<{ id: string }>();
	return queued ? { reason: "queued_work", runId: null, entryId: queued.id, detail: `queue entry ${queued.id} is waiting to start` } : null;
}
