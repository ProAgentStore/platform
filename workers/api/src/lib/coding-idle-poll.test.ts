import { describe, expect, it } from "vitest";
import {
	IDLE_SETTLE_MS,
	awaitEngineIdle,
	type IdlePollSnapshot,
	IDLE_POLL_FAST_MS,
	IDLE_POLL_MEDIUM_MS,
	IDLE_POLL_SLOW_MS,
	IDLE_WAIT_MAX_MS,
	SUBREQUESTS_PER_IDLE_POLL,
	SUBREQUESTS_PER_IDLE_POLL_BEFORE,
	idlePollDelayMs,
	idlePollsForTurn,
	idleSubrequestsForRun,
	shouldTouchActivity,
} from "./coding-idle-poll.js";
import { ACTIVITY_TOUCH_MS } from "./coding-store.js";

/**
 * The three production runs this is sized against (#523), from the population sweep on the
 * issue: they died at 120, 122 and 122 minutes of wall clock with 37, 37 and 26 Pilot steps, and
 * the nearest survivor completed at 99 minutes / 34 steps.
 *
 * `Chess coder 2` is the one modelled below because it is the WORST case for the "it is the step
 * count" theory and therefore the best case for this one: 26 steps over 122 minutes is 4.7 minutes
 * of Engine per step, the longest turns in the population.
 */
const DIED_AFTER_MS = 122 * 60_000;
const DIED_AFTER_STEPS = 26;
const TURN_MS = Math.round(DIED_AFTER_MS / DIED_AFTER_STEPS);

/**
 * Cloudflare's documented default, per WORKFLOW INSTANCE — not per invocation, which is why a
 * `step.sleep` cannot be the remedy (workflows/reference/limits, read 2026-08-13).
 */
const CF_DEFAULT_SUBREQUEST_CEILING = 10_000;

/** The flat 2-second loop this replaces: `for (poll = 0; poll < 240; …) { await sleep(2000); … }`. */
function pollsBeforeThisChange(busyMs: number): number {
	return 1 + Math.ceil(Math.min(busyMs, IDLE_WAIT_MAX_MS) / 2_000);
}

describe("the Pilot's idle poll fits a long run under the subrequest ceiling (#523)", () => {
	it("reproduces the death: the old poll cost more than the whole ceiling on the run that died", () => {
		const before = pollsBeforeThisChange(TURN_MS) * DIED_AFTER_STEPS * SUBREQUESTS_PER_IDLE_POLL_BEFORE;
		// 26 turns × 142 polls × 4 = 14,768 against a 10,000 ceiling. The run did not fail; it ran
		// out of a resource nobody was counting, at roughly 68% of the way through — which is where
		// 83 minutes of waiting lands inside 122 minutes of wall clock.
		expect(before).toBe(14_768);
		expect(before).toBeGreaterThan(CF_DEFAULT_SUBREQUEST_CEILING);
	});

	it("the same run now fits, with the ceiling untouched", () => {
		const after = idleSubrequestsForRun(Array.from({ length: DIED_AFTER_STEPS }, () => TURN_MS));
		// 26 turns × 51 polls × 3 = 3,978. Stated as the exact number rather than "less": the size
		// of the margin is the whole claim, and a schedule edit that halves it should be read as a
		// decision rather than pass quietly.
		expect(after).toBe(3_978);
		expect(after).toBeLessThan(CF_DEFAULT_SUBREQUEST_CEILING / 2);
	});

	it("a 4.7-minute engine turn costs 51 captures instead of 142", () => {
		expect(idlePollsForTurn(TURN_MS)).toBe(51);
		expect(pollsBeforeThisChange(TURN_MS)).toBe(142);
	});

	it("the survivor's shape is still comfortably inside the ceiling", () => {
		// 99 minutes / 34 steps — the nearest run that COMPLETED. It must not become the next
		// casualty when somebody lengthens the schedule's fast band.
		const survivor = idleSubrequestsForRun(Array.from({ length: 34 }, () => Math.round((99 * 60_000) / 34)));
		expect(survivor).toBeLessThan(CF_DEFAULT_SUBREQUEST_CEILING / 2);
	});
});

describe("the backoff schedule", () => {
	it("keeps today's 2-second cadence for the first 30 seconds, where most turns finish", () => {
		expect(idlePollDelayMs(0)).toBe(IDLE_POLL_FAST_MS);
		expect(idlePollDelayMs(29_999)).toBe(IDLE_POLL_FAST_MS);
	});

	it("steps to 5s and then 10s as the turn proves it is long", () => {
		expect(idlePollDelayMs(30_000)).toBe(IDLE_POLL_MEDIUM_MS);
		expect(idlePollDelayMs(119_999)).toBe(IDLE_POLL_MEDIUM_MS);
		expect(idlePollDelayMs(120_000)).toBe(IDLE_POLL_SLOW_MS);
		expect(idlePollDelayMs(60 * 60_000)).toBe(IDLE_POLL_SLOW_MS);
	});

	it("never goes backwards — a longer wait is never polled harder than a shorter one", () => {
		let previous = 0;
		for (let waited = 0; waited <= IDLE_WAIT_MAX_MS; waited += 1_000) {
			const delay = idlePollDelayMs(waited);
			expect(delay).toBeGreaterThanOrEqual(previous);
			previous = delay;
		}
	});

	it("costs at most one slow poll of extra latency at the end of a turn", () => {
		// The whole price of the change, named. Anything larger is a different trade and should
		// fail here rather than be discovered as "the Pilot got sluggish".
		expect(IDLE_POLL_SLOW_MS).toBeLessThanOrEqual(10_000);
	});
});

describe("the wait boundary is EXACTLY where it was", () => {
	/**
	 * The regression the issue names: the old bound was a poll COUNT (240 × 2s = 8 minutes of
	 * sleeping) sized against `idleRetry`'s 10-minute `step.do` timeout. Carrying that count over
	 * to a backed-off schedule would have stretched the window to roughly 40 minutes and moved the
	 * failure from "the wait gave up" to "the durable step timed out", which reads as a crash.
	 */
	it("still gives up after 8 minutes of sleeping, as the flat 240-poll loop did", () => {
		expect(IDLE_WAIT_MAX_MS).toBe(240 * 2_000);
	});

	it("an engine that never goes idle stops at the boundary rather than polling forever", () => {
		const forever = idlePollsForTurn(Number.MAX_SAFE_INTEGER);
		expect(forever).toBe(idlePollsForTurn(IDLE_WAIT_MAX_MS));
		expect(forever).toBe(70);
	});

	it("a turn that finishes instantly still costs the one settle capture", () => {
		expect(idlePollsForTurn(0)).toBe(1);
		expect(idlePollsForTurn(-1)).toBe(1);
	});
});

describe("awaitEngineIdle — the loop the workflow actually runs", () => {
	/** A synthetic Engine: busy for `busyMs` of SLEPT time, then idle. Records every sleep. */
	function engine(busyMs: number, overrides: Partial<IdlePollSnapshot> = {}) {
		const slept: number[] = [];
		let elapsed = 0;
		const captures: IdlePollSnapshot[] = [];
		return {
			slept,
			captures,
			deps: {
				sleep: async (ms: number) => {
					slept.push(ms);
					// The settle sleep is not part of the wait budget, so it does not advance the clock
					// the schedule reads — exactly as the workflow's loop does not count it.
					if (slept.length > 1) elapsed += ms;
				},
				capture: async (): Promise<IdlePollSnapshot> => {
					const snap = { runState: (elapsed >= busyMs ? "idle" : "thinking") as IdlePollSnapshot["runState"], alive: true, ...overrides };
					captures.push(snap);
					return snap;
				},
			},
		};
	}

	it("settles before the first capture, so a stale idle is never read as the turn ending", async () => {
		const e = engine(0);
		await awaitEngineIdle(e.deps);
		expect(e.slept[0]).toBe(IDLE_SETTLE_MS);
		expect(e.captures).toHaveLength(1);
	});

	it("an engine that NEVER goes idle stops at the boundary — the case that used to spend the run", async () => {
		// The issue's own stated regression risk: hold the engine non-idle for the full window and
		// assert the loop still terminates at the same place with the same snapshot.
		const e = engine(Number.MAX_SAFE_INTEGER);
		const snap = await awaitEngineIdle(e.deps);
		expect(snap.runState).toBe("thinking");
		expect(e.captures).toHaveLength(idlePollsForTurn(IDLE_WAIT_MAX_MS));
		expect(e.captures).toHaveLength(70);
		// 8 minutes of sleeping, not 8 minutes of poll COUNT stretched to 40 by the backoff.
		expect(e.slept.slice(1).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(IDLE_WAIT_MAX_MS);
		expect(e.slept.slice(1).reduce((a, b) => a + b, 0)).toBeLessThan(IDLE_WAIT_MAX_MS + IDLE_POLL_SLOW_MS);
	});

	it("uses the backed-off schedule rather than a flat 2 seconds", async () => {
		const e = engine(Number.MAX_SAFE_INTEGER);
		await awaitEngineIdle(e.deps);
		expect(new Set(e.slept.slice(1))).toEqual(new Set([IDLE_POLL_FAST_MS, IDLE_POLL_MEDIUM_MS, IDLE_POLL_SLOW_MS]));
	});

	it("stops the moment the engine dies, without waiting out the window", async () => {
		const e = engine(Number.MAX_SAFE_INTEGER, { alive: false });
		const snap = await awaitEngineIdle(e.deps);
		expect(snap.alive).toBe(false);
		expect(e.captures).toHaveLength(1);
	});

	it("stops the moment the run is cancelled — Stop and Kill still land within one poll", async () => {
		const e = engine(Number.MAX_SAFE_INTEGER, { cancelled: true });
		const snap = await awaitEngineIdle(e.deps);
		expect(snap.cancelled).toBe(true);
		expect(e.captures).toHaveLength(1);
	});

	it("returns as soon as the turn ends, on the 4.7-minute turn that killed the run", async () => {
		const e = engine(TURN_MS);
		const snap = await awaitEngineIdle(e.deps);
		expect(snap.runState).toBe("idle");
		expect(e.captures).toHaveLength(idlePollsForTurn(TURN_MS));
	});
});

describe("the activity heartbeat is asked before it is paid for", () => {
	it("touches on a fresh run, and on a replay that rebuilt the closure", () => {
		expect(shouldTouchActivity(0, Date.now())).toBe(true);
	});

	it("skips the write it already made this minute — the quarter of every poll that bought nothing", () => {
		const now = 1_700_000_000_000;
		expect(shouldTouchActivity(now, now)).toBe(false);
		expect(shouldTouchActivity(now - ACTIVITY_TOUCH_MS + 1, now)).toBe(false);
		expect(shouldTouchActivity(now - ACTIVITY_TOUCH_MS, now)).toBe(true);
	});

	it("follows the store's own throttle rather than a second copy of the number", () => {
		// The SQL `UPDATE` keeps its own `last_activity_at < now - ACTIVITY_TOUCH_MS` guard, so the
		// two must agree or the caller would skip a write the store would have made.
		expect(ACTIVITY_TOUCH_MS).toBe(60_000);
	});

	it("takes a poll from four subrequests to three", () => {
		expect(SUBREQUESTS_PER_IDLE_POLL).toBe(SUBREQUESTS_PER_IDLE_POLL_BEFORE - 1);
	});
});
