/**
 * How the Pilot waits for the Engine to go idle, and what that wait COSTS (#523).
 *
 * Pure, so the cost can be stated as arithmetic instead of discovered two hours into a run.
 *
 * ── The defect
 *
 * Three runs died at 120, 122 and 122 minutes with
 * `Too many API requests by single Worker invocation`, and were reported to their owner as
 * `outcome: failed` next to a Wrangler docs link. One of them had closed ten issues and pushed to
 * `main` fifteen times. #546 already fixed the SENTENCE — `platform_ceiling` is classified and
 * reported as an interruption rather than as the objective failing. This is the cause underneath
 * it.
 *
 * Cloudflare documents the ceiling as **per Workflow instance**, not per invocation:
 * "Maximum number of subrequests per Workflow instance — 10,000/request (default), configurable up
 * to 10 million" (workflows/reference/limits). That single fact decides the whole design. It means
 * a `step.sleep` does NOT reset the counter, so breaking the poll loop into chunks separated by
 * sleeps — the remedy the issue proposed — would have bought nothing at all. What is spent is
 * spent for the life of the run, and the only levers are spending less of it and raising it.
 *
 * ── The arithmetic, which is the finding
 *
 * `capture()` in `workflows/coding-session.ts` costs FOUR subrequests, counted from the source
 * rather than estimated:
 *
 *   1  `callRunner` → one `RELAY` Durable Object `stub.fetch` (`runner-client.ts:267`)
 *   1  `SELECT status FROM coding_sessions`
 *   1  `isCancelRequested` → `SELECT cancel_requested FROM agent_loop_runs`
 *   1  `touchSessionActivity` → an `UPDATE` whose 60-second throttle is a WHERE clause, so the
 *      subrequest is spent on every poll whether or not the row moves
 *
 * (`recordEngineUsage`, `recordEngineActs` and `recordAuthorityViolations` each return before
 * touching D1 on an empty report, which is the steady state between engine turns.)
 *
 * At a flat 2-second poll that is 2 subrequests per second of engine work, so 10,000 buys 83
 * minutes of waiting — inside the 122-minute runs that died, and outside the 99-minute run that
 * survived. The three deaths were 37, 37 and 26 Pilot steps: it never tracked step count, it
 * tracked how long the Engine was busy, which is exactly what this file's numbers are about.
 *
 * ── What changed
 *
 * The poll BACKS OFF ({@link idlePollDelayMs}) and the activity touch is throttled at the caller
 * ({@link shouldTouchActivity}) rather than in SQL. Together they take a 4.7-minute engine turn
 * from 142 polls × 4 subrequests to 51 × 3 — see `coding-idle-poll.test.ts`, which asserts the
 * whole 122-minute run over its measured shape and the ceiling it has to fit under.
 *
 * The issue rejected "poll less often" on two grounds, and BOTH are false of this poll:
 *
 *   "2s is what makes the terminal feel live"  — it is not. The live terminal is the CONSOLE's own
 *      3-second `GET …/sessions/:sid/capture`, on its own rate-limit bucket. This poll runs inside
 *      a durable Workflow with no browser attached and is invisible to the user; all it decides is
 *      when the Engine stopped working.
 *   "touchSessionActivity is throttled against it" — it is throttled against 60 seconds
 *      (`ACTIVITY_TOUCH_MS`), so any interval below a minute satisfies it identically.
 *
 * What backing off does cost is up to {@link IDLE_POLL_SLOW_MS} of extra latency at the end of a
 * long turn. That is 10 seconds on a turn that has already run past two minutes, and it is the
 * trade being made deliberately: 3.5% slower on a 2-hour run, against a run that used to not
 * finish at all.
 */
import { ACTIVITY_TOUCH_MS } from "./coding-store.js";

/**
 * Wait after sending an instruction before the first capture.
 *
 * A just-sent instruction may not have flipped the pane to "thinking" yet, so an immediate capture
 * would read a stale idle and the Pilot would decide its next move against the previous turn.
 * Unchanged from the original loop.
 */
export const IDLE_SETTLE_MS = 1_500;

/**
 * The longest one turn may stay busy before the wait gives up, in SLEEPING time.
 *
 * Deliberately identical to the bound it replaces — the old loop was `poll < 240` at a flat 2
 * seconds, i.e. 480 seconds of sleep — because that number is sized against `idleRetry`'s
 * 10-minute `step.do` timeout in the workflow, and nothing about the backoff changes that ceiling.
 * Expressed as elapsed time rather than a poll count now that the polls are not all the same
 * length; a poll count would silently stretch the window to 40 minutes.
 */
export const IDLE_WAIT_MAX_MS = 480_000;

/** First 30 seconds: unchanged. Most turns finish here, and they keep today's responsiveness. */
export const IDLE_POLL_FAST_MS = 2_000;
export const IDLE_POLL_FAST_UNTIL_MS = 30_000;
/** 30s–2min: the turn is real work, and a 5-second answer is still faster than a human reads. */
export const IDLE_POLL_MEDIUM_MS = 5_000;
export const IDLE_POLL_MEDIUM_UNTIL_MS = 120_000;
/** Past 2 minutes: 2-second precision on a turn measured in minutes buys nothing and costs the run. */
export const IDLE_POLL_SLOW_MS = 10_000;

/** How long to sleep before the next capture, given how long this turn has already been busy. */
export function idlePollDelayMs(waitedMs: number): number {
	if (waitedMs < IDLE_POLL_FAST_UNTIL_MS) return IDLE_POLL_FAST_MS;
	if (waitedMs < IDLE_POLL_MEDIUM_UNTIL_MS) return IDLE_POLL_MEDIUM_MS;
	return IDLE_POLL_SLOW_MS;
}

/**
 * Is this poll allowed to write the activity heartbeat? (#523)
 *
 * `touchSessionActivity` is throttled to {@link ACTIVITY_TOUCH_MS} in its WHERE clause, which
 * makes the WRITE rare and the SUBREQUEST unconditional — a quarter of every poll's cost buying a
 * row update 1 time in 30. Asking the same question before the call turns that into what it was
 * always meant to be. `lastTouchAt = 0` (a fresh run, or a workflow replay rebuilding the closure)
 * touches immediately, which is the safe direction: the heartbeat is what stops a long wait
 * expiring the run's own single-flight claim.
 */
export function shouldTouchActivity(lastTouchAt: number, now: number): boolean {
	return now - lastTouchAt >= ACTIVITY_TOUCH_MS;
}

/**
 * Captures spent waiting out an engine turn that stays busy for `busyMs`.
 *
 * Mirrors the workflow's loop exactly — the settle capture, then one per sleep — so the cost
 * assertions in the test measure the shipped schedule rather than a model of it.
 */
export function idlePollsForTurn(busyMs: number): number {
	let polls = 1; // the settle capture, before any sleeping
	for (let waited = 0; waited < Math.min(Math.max(busyMs, 0), IDLE_WAIT_MAX_MS); ) {
		waited += idlePollDelayMs(waited);
		polls++;
	}
	return polls;
}

/**
 * Subrequests one idle poll spends now: the relay DO fetch, the session-status read and the
 * cancel-flag read. The activity touch is no longer one of them on all but 1 poll in 30, and is
 * excluded here so the figure is the one the run is actually charged for the overwhelming
 * majority of its polls.
 */
export const SUBREQUESTS_PER_IDLE_POLL = 3;

/** What that poll cost before this change — kept so the test can state the size of the fix. */
export const SUBREQUESTS_PER_IDLE_POLL_BEFORE = 4;

/** Subrequests a run spends waiting, given the length of each of its engine turns. */
export function idleSubrequestsForRun(turnsMs: readonly number[]): number {
	return turnsMs.reduce((total, ms) => total + idlePollsForTurn(ms) * SUBREQUESTS_PER_IDLE_POLL, 0);
}

/** The three fields the wait reads off a capture. Structural, so a test can hand it a fixture. */
export interface IdlePollSnapshot {
	runState: "idle" | "thinking" | "responding";
	alive: boolean;
	cancelled?: boolean;
}

/**
 * Wait for the Engine's turn to end, and return the capture that says so.
 *
 * Lives HERE rather than inline in the workflow for the reason `coding-pause.ts` does: "how long
 * may a run wait, and what does waiting cost" is a rule, and a rule inside a Workflow can only be
 * tested by running one. Both effects are injected — `capture` is a durable step's callback in
 * production, `sleep` is a bare `setTimeout` — so the loop is exercised against a synthetic Engine
 * that never goes idle, which is the case that used to spend the run's whole budget.
 */
export async function awaitEngineIdle<S extends IdlePollSnapshot>(deps: {
	capture: () => Promise<S>;
	sleep: (ms: number) => Promise<void>;
}): Promise<S> {
	await deps.sleep(IDLE_SETTLE_MS);
	let snap = await deps.capture();
	for (let waited = 0; waited < IDLE_WAIT_MAX_MS && snap.runState !== "idle" && snap.alive && !snap.cancelled; ) {
		const delay = idlePollDelayMs(waited);
		await deps.sleep(delay);
		waited += delay;
		snap = await deps.capture();
	}
	return snap;
}

// ── The durable variant, behind a flag (#814) ────────────────────────────────

/**
 * Should the idle wait be built from DURABLE steps rather than one long one? **Default: yes** (#814).
 *
 * ── Why it is on
 *
 * **Surviving an eviction mid-turn**, which is the benefit that holds whatever else is true.
 *
 * The other shape puts the whole wait in ONE `step.do`: up to 480 seconds of `setTimeout` sleeps
 * and up to 70 captures inside a single 10-minute step. A `setTimeout` inside a step does not
 * survive the instance being evicted — the step is retried from its first line, so the wait starts
 * over with a fresh settle and a fresh 480-second window, and `idleRetry` allows that exactly once.
 * An engine turn interrupted twice therefore ends a run that was working. With durable steps a
 * replay returns every completed capture from the journal and resumes at the poll that was in
 * flight, which is the same property `coding-pause.ts` relies on for its handoff and usage-limit
 * parks — both of which chunk for their own reasons (out-ticking the driver claim, staying
 * cancellable) and neither of which is about subrequests.
 *
 * The LOOP is the same function either way ({@link awaitEngineIdle}); only the two effects handed
 * to it differ, which is why every boundary test holds for both paths.
 *
 * ── What is still NOT known, and must not be claimed
 *
 * #814 also argued this would stop the wait "burning subrequest budget in one invocation". **That
 * is unmeasured and this module does not assert it either way.** Cloudflare documents the ceiling
 * as per Workflow INSTANCE (`workflows/reference/limits`), which would mean a sleep does not reset
 * the count and chunking buys nothing there — but the limits page does not say what a sleep or a
 * step boundary does to it, so that reading is an INFERENCE, not a fact. `scratch/
 * subrequest-reset-probe` was written to settle it and has not been run.
 *
 * So: per poll this path spends exactly what the other path spends, as far as anyone here knows.
 * Nobody should cite this flag as a subrequest fix until the probe reports `RESETS`. The file
 * header's arithmetic — which is about the POLL SCHEDULE backing off, not about chunking — is what
 * actually took #523's run under the ceiling, and it is unaffected by this choice.
 *
 * ── What it costs
 *
 * One durable step per capture: 51 for the 4.7-minute turn this file is sized against, 70 for a
 * full window, where there was 1. Cloudflare allows 10,000 steps per Workflow by default
 * (`step.sleep` is documented as not counting), so #523's 26-turn run spends 1,326 of them — at the
 * slow cadence that ceiling is ~27 hours of waiting. It is a second finite budget to watch, not one
 * this change exhausts. It also adds a durable round trip to every poll, so a turn ends a little
 * later than the schedule alone implies.
 *
 * ── The opt-out, and why it survives being made the default
 *
 * `CODING_IDLE_DURABLE=0` / `false` restores the one-step wait. The flag is kept — inverted rather
 * than deleted — because this multiplies the step count of every coding run by ~51, against a
 * ceiling nobody here has hit but nobody here has measured under load either. A default that can
 * only be changed by editing and deploying code is not a default, it is a commitment; this one has
 * a lever. Anything that is not an explicit disable reads as enabled, so an unset var, an empty
 * string and a typo all leave it ON — the safe direction now that ON is the intended state.
 */
export function idleWaitIsDurable(env: { CODING_IDLE_DURABLE?: string } | undefined): boolean {
	return !(env?.CODING_IDLE_DURABLE === "0" || env?.CODING_IDLE_DURABLE === "false");
}

/**
 * {@link awaitEngineIdle}'s two effects, as durable steps with names that are unique and stable.
 *
 * A Workflow step name must be unique within its instance AND identical on a replay, or the
 * journal does not line up. Both follow from the counter living HERE, outside any step body: a
 * replay re-runs this closure and re-derives the same names in the same order, exactly as the
 * workflow's own `s${n++}` does. The sequence is `z0` (the settle sleep), `c0`, `z1`, `c1`, … — a
 * sleep and the capture after it share an index, so a name read off a failed instance says which
 * poll it was.
 *
 * Pure over its two callbacks, so the naming and the boundary are tested without a Workflow.
 */
export function durableIdleDeps<S>(cfg: {
	/** Unique within the instance — the workflow's step counter, e.g. `s12-waitidle`. */
	label: string;
	/** Run ONE capture as its own durable step under `stepName`. */
	capture: (stepName: string) => Promise<S>;
	/** `step.sleep`. */
	sleep: (stepName: string, ms: number) => Promise<void>;
}): { capture: () => Promise<S>; sleep: (ms: number) => Promise<void> } {
	let poll = 0;
	return {
		sleep: (ms) => cfg.sleep(`${cfg.label}-z${poll}`, ms),
		capture: () => cfg.capture(`${cfg.label}-c${poll++}`),
	};
}
