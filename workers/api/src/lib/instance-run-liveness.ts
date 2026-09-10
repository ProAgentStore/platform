// Is this instance BUSY? — the half `GET /v1/instances/:id/state` could not answer (#791).
//
// ── The defect
//
// `get_instance_state` returned `status: "idle"` and `inflight: []` while a coding run was
// mid-investigation and burning iterations. Neither field was wrong: `AgentState.status` is a
// three-value chat union (`idle | thinking | error`) written around a chat turn in `agent-do.ts`,
// and `inflight` is `chat-inflight.ts`'s durable per-TURN marker. A coding run drives the
// `CODING_SESSION` Workflow and never touches either.
//
// So the object had no field that could express "a run is live", and the two fields it did have
// read as a confident no. That is #588's lesson in a new place — a model reads an absent key, or an
// empty list, as "fine" — and the reported impact is the expensive version of it: a caller deciding
// whether it is safe to start new work gets told nothing is happening, then meets the single-flight
// 409 it was told not to expect.
//
// ── Why the verdict is IMPORTED and not computed here
//
// `runHealth` (lib/work-report.ts) is the platform's own verdict on a run, and its docstring states
// the rule this module obeys: "Anything holding these four fields gets the platform's verdict;
// nothing has an excuse to compute a second one." #589 is the incident behind that sentence —
// `subordinate_status` derived activity from the raw `status` column and reported `working` for a
// run parked 4h35m, while `check_instance_loop` said `waiting` about the same row at the same
// instant. Deriving a third answer here would recreate exactly that, on the surface #791 is about.
//
// So this module SHAPES a payload. The only judgement in it is `runHealth`'s.
//
// PURE — no D1, no Env, no fetch. The route brings the rows; this decides the shape.

import { runHealth, type RunHealth } from "./work-report.js";
import type { LoopRunView } from "./agent-loop-store.js";

/** One live run, as the state payload reports it. */
export interface RunLivenessRow {
	runId: string;
	/** The platform's verdict — `working` | `waiting` | `stalled` | `ended`. Quote it; do not re-derive. */
	health: RunHealth;
	status: string;
	waitingReason: string | null;
	lastAliveAt: number | null;
	lastProgressAt: number | null;
	startedAt: number;
	parkedSince: number | null;
	waitingUntil: number | null;
}

export interface RunLiveness {
	/**
	 * How many runs are open on this instance — or NULL when the count could not be read.
	 *
	 * Null is not the same claim as zero and must never be collapsed into it. Zero says "nothing is
	 * running", which is the exact false all-clear #791 was filed about; null says "nobody looked",
	 * which is the honest answer when the lookup failed. Same distinction `coding-run-state.ts`
	 * draws between an engine reporting `idle` and a probe going unanswered.
	 */
	active: number | null;
	runs: RunLivenessRow[];
	/** Present and true ONLY when the runs could not be read. Absent on every successful answer. */
	unavailable?: true;
}

/**
 * The `runs` field, from the instance's open `agent_loop_runs` rows.
 *
 * `active` counts what was PASSED IN — rows already filtered to `status = 'running'` by the query —
 * rather than counting `health === "working"`. The two differ, and the difference matters: a run
 * that is `waiting` or `stalled` is still holding its session claim and still owns its budget pool,
 * so "is it safe to start new work here" is answered by the row existing, not by the verdict on it.
 * The verdict rides alongside so a caller can tell a working run from a parked one without asking a
 * second tool.
 */
export function runLiveness(runs: readonly LoopRunView[], now: number): RunLiveness {
	return {
		active: runs.length,
		runs: runs.map((r) => ({
			runId: r.runId,
			health: runHealth(r, now),
			status: r.status,
			waitingReason: r.waitingReason ?? null,
			lastAliveAt: r.lastAliveAt ?? null,
			lastProgressAt: r.lastProgressAt ?? null,
			startedAt: r.startedAt,
			parkedSince: r.parkedSince ?? null,
			waitingUntil: r.waitingUntil ?? null,
		})),
	};
}

/**
 * What to report when the runs could not be read at all.
 *
 * A separate constructor rather than a flag on {@link runLiveness}, so the "we did not measure"
 * shape cannot be produced by accident from an empty result set — the two look identical in a
 * payload unless something makes them different on purpose.
 */
export function runLivenessUnavailable(): RunLiveness {
	return { active: null, runs: [], unavailable: true };
}
