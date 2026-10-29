/**
 * The coding loop's own bookkeeping (#1359): the step budget, the bounds, the per-run counters, and the shape of a side
 * effect a pure helper asks the loop to perform.
 *
 * A leaf (it imports nothing), so `coding-loop.ts`, `coding-screens.ts` and `coding-turn-outcome.ts` can all name these
 * without importing each other.
 */

/**
 * The step budget `runCodingLoop` falls back to when its caller passes no `maxSteps` (30, unchanged).
 *
 * Not `PILOT_DEFAULT_MAX_STEPS` (`loop-limits.ts`, 40): that is the coding WORKFLOW's per-round cap when a run names none, which
 * the workflow clamps and then passes to the loop as `maxSteps`. This one only matters to a caller that runs the loop directly.
 */
export const LOOP_FALLBACK_MAX_STEPS = 30;

/**
 * How many refusals the merge-authority screen may issue before the run finishes.
 *
 * The screen is a heuristic over natural language (see coding-authority.ts), so it needs a bound:
 * a brain that keeps rephrasing the same forbidden instruction must not burn all 40 BYOK-Claude
 * decisions doing it. Three is enough for the brain to genuinely change course after reading the
 * refusal in its own step log, and small enough that a false positive costs a stopped run with a
 * clear reason rather than a long silent one.
 */
export const MAX_REFUSALS = 3;

/**
 * How many empty instructions in a row end the run (#504).
 *
 * CONSECUTIVE, and reset by any instruction that is actually sent, because the production run this
 * comes from recovered on its own: eleven of nineteen steps were empty, but the brain went back to
 * a short instruction each time it was told nothing had been sent. Three in a row is the point at
 * which it is not recovering, and stopping there costs a named failure instead of the 4.6 minutes
 * of engine turns and BYOK decisions that run spent driving "" into a live coding CLI.
 */
export const MAX_EMPTY_INSTRUCTIONS = 3;

/** Everything one `runCodingLoop` call counts, in one place instead of eight loose `let`s. */
export interface LoopCounters {
	/** Instructions the owner's scope constraints refused (#1019). */
	scopeRefusals: number;
	/** A completion claim was already sent back to the Pilot once (#1019). */
	finishPushedBack: boolean;
	/** Instructions the merge-authority screen refused (#314). */
	refusals: number;
	/** An incomplete question was already sent back to the Pilot once. */
	askSentBack: boolean;
	/** Consecutive empty instructions (#504). */
	emptyInstructions: number;
	/** Normalised key of every instruction actually driven into the engine, in order (#522). */
	sentKeys: string[];
	/**
	 * Parallel to `sentKeys` (#807): the files a sent instruction READ, one entry per sent instruction so an
	 * index is an instruction ordinal, not a read ordinal.
	 */
	sentReads: string[][];
	/** The instruction this run was warned about repeating, if any — read by the `finish` branch. */
	repeatedInstruction: string | null;
}

export function newLoopCounters(): LoopCounters {
	return { scopeRefusals: 0, finishPushedBack: false, refusals: 0, askSentBack: false, emptyInstructions: 0, sentKeys: [], sentReads: [], repeatedInstruction: null };
}

/**
 * One side effect a pure helper asks the loop to perform, in this order: push `log` onto the Pilot's step log, push
 * `transcript` onto the run transcript, then raise `event` to the run's listener. Each part is optional because the
 * three surfaces do not always say the same thing (a refusal logs its note but raises the bare refusal).
 */
export interface LoopEffect {
	log?: string;
	transcript?: string;
	event?: { name: string; detail: string; data?: unknown };
}
