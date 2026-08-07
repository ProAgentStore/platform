// The Pilot run's parameters, as a LEAF (#341).
//
// Split out of `coding-session.ts` so `coding-watch.ts` can name the payload it is handed without
// importing the workflow that hands it over — `import-graph.test.ts` forbids a static cycle even
// when it is type-only and therefore erased. The workflow re-exports this name, so nothing that
// already imported `CodingSessionParams` from `./coding-session.js` has to change.

import type { CodingGoal } from "../lib/coding-loop.js";

export interface CodingSessionParams {
	instanceId: string;
	userId: string;
	/** The coding_sessions row this workflow drives. */
	sessionId: string;
	/** Repo identity + clone source, so the runner can (re)clone if it lost the session. */
	repoId: string;
	/** Runner node that owns this coding session. Null/empty falls back to the legacy default runner. */
	runnerNode?: string | null;
	cloneUrl?: string;
	branch?: string;
	/** GitHub App installation token for cloning a private repo. */
	token?: string;
	goal: CodingGoal;
	/**
	 * "watch": don't drive the CLI — the user just sent it an instruction manually
	 * (➤ Agent). Wait for the pane to go idle, then summarize what happened and
	 * notify the user. Durable, so it reaches them even with the console closed.
	 */
	mode?: "watch";
	/** This watcher's id — only the one currently stamped on the session notifies. */
	watchId?: string;
	/**
	 * When set, this run is a delegated GOAL (e.g. the Overseer handing work to this Pilot on
	 * the user's behalf, #155). The Pilot updates this board task's status at its terminal
	 * state (done/error) so the delegation is observable on the board, not just in the thread.
	 */
	boardTaskId?: string;
	/**
	 * Delegation budget to draw against (#184). Present ONLY when a supervisor delegated this
	 * run — a human driving their own Coder from the Coding tab passes none and is unmetered,
	 * exactly as before. Adding a cap to that path would change behaviour nobody asked for.
	 */
	budgetId?: string | null;
	/** Depth in the supervision tree; the budget refuses past its cap. */
	depth?: number;
	/**
	 * agent_loop_runs row to close when this finishes (#159). A delegated coding run must be
	 * answerable through `check_delegation` like every other delegation — otherwise the
	 * supervisor is handed a run id it cannot look up.
	 */
	loopRunId?: string | null;
	/**
	 * Steps the Pilot may drive in one round, when the caller named a number (#374).
	 *
	 * Absent keeps the historical 40. This exists because the caller's "Max iterations" was
	 * recorded on the `agent_loop_runs` row and enforced nowhere, so a run could truthfully report
	 * "iteration 40 of 10". Per ROUND rather than per run: a round restarts only after a HUMAN has
	 * answered a stuck/needs-input handoff, so this bounds the unattended stretch — which is the
	 * stretch the number is being typed about.
	 */
	maxSteps?: number;
	/**
	 * The single-flight claim this run holds on the session (#208). Released when the run ends —
	 * including the early no-runner return, which is exactly where a claim would otherwise be
	 * stranded and lock the session out of every future run.
	 */
	driverId?: string | null;
	/**
	 * Did THIS run open the session it drives? (#271)
	 *
	 * Absent/false means a human (or an earlier run) opened it, and the Pilot leaves it live when
	 * it finishes. It used to end the session unconditionally, which made delegation single-use:
	 * `loop-drivers.ts` required a live session, the Pilot consumed it, and the next goal 409'd
	 * with a message blaming the runner. It also quietly deleted a session the user had opened by
	 * hand and expected to still be there.
	 *
	 * Defaulting to false is the safe direction: the worst case is an idle session left live,
	 * which the user can end from the Coding tab. The reverse — closing someone else's session —
	 * is not recoverable.
	 */
	sessionOpenedByRun?: boolean;
}
