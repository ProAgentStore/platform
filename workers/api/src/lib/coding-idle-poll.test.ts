import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	IDLE_SETTLE_MS,
	awaitEngineIdle,
	durableIdleDeps,
	idleWaitIsDurable,
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
import { stripCommentsAndLiterals } from "./source-guard.js";
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


// ── #814: the same wait, built from durable steps, behind a flag ─────────────
describe("the durable idle wait (#814)", () => {
	/** Records every step and sleep NAME, over the same synthetic-Engine clock the block above uses. */
	function durableEngine(busyMs: number, overrides: Partial<IdlePollSnapshot> = {}) {
		const names: string[] = [];
		const slept: number[] = [];
		let elapsed = 0;
		const deps = durableIdleDeps<IdlePollSnapshot>({
			label: "s12-waitidle",
			sleep: async (name, ms) => {
				names.push(name);
				slept.push(ms);
				if (slept.length > 1) elapsed += ms;
			},
			capture: async (name) => {
				names.push(name);
				return { runState: elapsed >= busyMs ? "idle" : "thinking", alive: true, ...overrides };
			},
		});
		return { names, slept, deps };
	}

	it("is ON by default — an unset var, an empty string and a typo all leave the durable wait in force", () => {
		// The direction flipped with the default (#814). Anything that is not an explicit disable
		// reads as enabled, which is the safe direction now that enabled is the intended state: a
		// mistyped opt-out leaves the eviction-surviving path running rather than silently removing it.
		for (const v of [undefined, "", "1", "true", "on", "yes", "TRUE", "FALSE", "no"]) {
			expect(idleWaitIsDurable({ CODING_IDLE_DURABLE: v }), String(v)).toBe(true);
		}
		expect(idleWaitIsDurable(undefined)).toBe(true);
		expect(idleWaitIsDurable({})).toBe(true);
	});

	it("can still be turned OFF — the lever survives being made the default", () => {
		// Kept rather than deleted: this multiplies every run's step count by ~51 against a ceiling
		// nobody has measured under load, and a default with no lever is a commitment, not a default.
		expect(idleWaitIsDurable({ CODING_IDLE_DURABLE: "0" })).toBe(false);
		expect(idleWaitIsDurable({ CODING_IDLE_DURABLE: "false" })).toBe(false);
	});

	it("an engine that NEVER goes idle stops at the SAME boundary with the SAME snapshot — the issue's own acceptance test", async () => {
		const e = durableEngine(Number.MAX_SAFE_INTEGER);
		const snap = await awaitEngineIdle(e.deps);
		expect(snap.runState).toBe("thinking");
		// 70 captures and 8 minutes of sleeping: identical to the one-step path, because it IS the same loop.
		expect(e.names.filter((n) => n.includes("-c"))).toHaveLength(70);
		expect(e.slept[0]).toBe(IDLE_SETTLE_MS);
		const sleeping = e.slept.slice(1).reduce((a, b) => a + b, 0);
		expect(sleeping).toBeGreaterThanOrEqual(IDLE_WAIT_MAX_MS);
		expect(sleeping).toBeLessThan(IDLE_WAIT_MAX_MS + IDLE_POLL_SLOW_MS);
	});

	it("names every step uniquely — a Workflow refuses a repeated step name inside one instance", async () => {
		const e = durableEngine(Number.MAX_SAFE_INTEGER);
		await awaitEngineIdle(e.deps);
		expect(new Set(e.names).size).toBe(e.names.length);
		// Sleep first, then the capture that shares its index; the index then advances.
		expect(e.names.slice(0, 5)).toEqual(["s12-waitidle-z0", "s12-waitidle-c0", "s12-waitidle-z1", "s12-waitidle-c1", "s12-waitidle-z2"]);
	});

	it("derives the SAME names on a second pass — what a replay needs for the journal to line up", async () => {
		const first = durableEngine(TURN_MS);
		const second = durableEngine(TURN_MS);
		await awaitEngineIdle(first.deps);
		await awaitEngineIdle(second.deps);
		expect(second.names).toEqual(first.names);
	});

	it("still stops within one poll of a cancel or a dead engine", async () => {
		const cancelled = durableEngine(Number.MAX_SAFE_INTEGER, { cancelled: true });
		await awaitEngineIdle(cancelled.deps);
		expect(cancelled.names).toEqual(["s12-waitidle-z0", "s12-waitidle-c0"]);
		const dead = durableEngine(Number.MAX_SAFE_INTEGER, { alive: false });
		await awaitEngineIdle(dead.deps);
		expect(dead.names.filter((n) => n.includes("-c"))).toHaveLength(1);
	});

	/**
	 * The cost, stated — it is a SECOND finite budget. Cloudflare allows 10,000 steps per Workflow
	 * by default ("step.sleep does not count towards the maximum steps limit", limits page, read
	 * 2026-09-19), and this path spends one per capture where the other spends one per turn.
	 */
	it("spends one durable step per capture: 1,326 on the run #523 is sized against, under the 10,000 default", () => {
		const CF_DEFAULT_STEP_CEILING = 10_000;
		expect(idlePollsForTurn(TURN_MS)).toBe(51);
		expect(DIED_AFTER_STEPS * idlePollsForTurn(TURN_MS)).toBe(1_326);
		expect(DIED_AFTER_STEPS * idlePollsForTurn(TURN_MS)).toBeLessThan(CF_DEFAULT_STEP_CEILING);
		// …and it does NOT change what a poll costs in subrequests, which is the claim #814 made for it.
		expect(idleSubrequestsForRun(Array(DIED_AFTER_STEPS).fill(TURN_MS))).toBe(3_978);
	});

	// Source assertions, in this package's established style: the wiring is one expression inside a
	// Workflow that cannot be run here, and what matters is that each half of it EXISTS.
	describe("the workflow's wiring", () => {
		const workflow = readFileSync(join(__dirname, "../workflows/coding-session.ts"), "utf-8");

		it("reads the flag, and keeps the one-step wait as the other branch", () => {
			expect(workflow).toContain("idleWaitIsDurable(env)");
			expect(workflow).toContain(": guard(runIdle, label, () => awaitEngineIdle({ capture, sleep })),");
		});

		it("derives the step label ONCE, outside the branch — the counter cannot depend on which wait ran", () => {
			// Both arms used to spell `s${n++}-waitidle` for themselves. That advanced `n` by one
			// either way only because the two happened to match; a replay taking the other arm after
			// the flag moved would look up a journal that no longer lines up, and every LATER step
			// name would shift with it. One increment, above the ternary, removes the whole class.
			const wiring = workflow.slice(workflow.indexOf("waitIdle: () => {"), workflow.indexOf("onEvent: (type, message, data)"));
			// In two halves, the idiom this block already used: the label is a template literal, and a
			// plain string cannot quote its placeholder without tripping `noTemplateCurlyInString`.
			expect(wiring).toContain("const label = `s");
			expect(wiring).toContain("-waitidle`;");
			// Counted over CODE, not prose — the comment above the line quotes the old spelling, and a
			// raw text count would read that as a second increment. `stripCommentsAndLiterals` is the
			// same lexer `fetch-deadline.test.ts` scans with, so this counts what the engine sees.
			expect(stripCommentsAndLiterals(wiring).match(/n\+\+/g) ?? []).toHaveLength(1);
			// …and both arms consume that label rather than building their own.
			expect(wiring).toContain("durableIdleDeps({ label,");
			expect(wiring).toContain("guard(runIdle, label,");
		});

		it("says the chunking is for eviction survival, not for subrequests", () => {
			// The one claim #814 made that is still unmeasured must not be restated as fact at the
			// call site — `scratch/subrequest-reset-probe` has never been run. Matched over
			// whitespace-collapsed text, because a comment rewraps and a phrase that spans two lines
			// is the same statement; pinning the line breaks would fail on an edit that changed nothing.
			const prose = workflow.replace(/^\s*\/\/\s?/gm, " ").replace(/\s+/g, " ");
			expect(prose).toContain("NOT known to save subrequests");
			expect(prose).toContain("survives an eviction rather than restarting");
		});

		it("routes every durable capture through the runner guard — a disconnect mid-wait must still pause, not end, the run (#341)", () => {
			expect(workflow).toContain("capture: (name) => guard(runRetry, name, capture)");
		});

		it("sleeps durably, not on a setTimeout", () => {
			expect(workflow).toContain("sleep: (name, ms) => step.sleep(name, ms)");
		});
	});
});
