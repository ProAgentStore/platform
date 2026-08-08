import { afterEach, describe, expect, it, vi } from "vitest";
import { advanceCron } from "./cron-schedule.js";

/**
 * #412 — a negatively-jittered run must not shorten the interval.
 *
 * The bug was not in the cron arithmetic and not in the jitter; both were individually correct.
 * It was that ONE stored time served as both the fire moment and the schedule position, so
 * computing the next slot from the fire moment let a −24m jitter hand back the same slot 24
 * minutes later. These tests pin the separation, not the arithmetic.
 */

afterEach(() => {
	vi.restoreAllMocks();
});

/** Force `applyJitter`'s ± offset to a known sign. 0 → −j (the dangerous end), 1 → +j. */
function pinJitter(unitInterval: number) {
	vi.spyOn(Math, "random").mockReturnValue(unitInterval);
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe("advanceCron — the slot is state, the jitter is presentation", () => {
	it("THE BUG: a negatively-jittered run still advances a FULL day", () => {
		// Reproduces the ticket's worked example exactly. Slot 2026-08-09T00:00Z, jitter 90m
		// landing at its negative extreme → fires 2026-08-08T22:30Z. `now` is that fire moment.
		// The old code did `nextRunAt("@daily", now)` and got 2026-08-09T00:00Z back — the slot
		// it had just fired — 90 minutes away instead of a day.
		pinJitter(0);
		const now = new Date("2026-08-08T22:30:00.000Z");
		const { slot, fire } = advanceCron("@daily", { now, slot: "2026-08-09T00:00:00.000Z", jitterMinutes: 90 });

		expect(slot).toBe("2026-08-10T00:00:00.000Z");
		// And the fire time is a day away too, not the same night.
		expect(Date.parse(fire)).toBeGreaterThan(now.getTime() + 20 * 60 * 60 * 1000);
	});

	it("steps @daily by exactly one period across many negative-jitter runs", () => {
		// The acceptance criterion, run as a machine rather than argued: walk a trigger through
		// consecutive runs with jitter pinned to its NEGATIVE extreme — the case that used to
		// compound, because a second run before midnight restarted the whole cycle.
		pinJitter(0);
		let slot = "2026-08-09T00:00:00.000Z";
		const seen = [slot];

		for (let i = 0; i < 10; i++) {
			// Each run fires at its jittered time, which with jitter pinned negative is 90 minutes
			// BEFORE the slot — the sweep's `now`.
			const now = new Date(Date.parse(slot) - 90 * 60_000);
			const next = advanceCron("@daily", { now, slot, jitterMinutes: 90 });
			slot = next.slot;
			seen.push(slot);
		}

		for (let i = 1; i < seen.length; i++) {
			expect(Date.parse(seen[i]) - Date.parse(seen[i - 1])).toBe(DAY_MS);
		}
		// Ten runs, ten days — never eleven slots in ten days.
		expect(seen).toHaveLength(11);
		expect(seen.at(-1)).toBe("2026-08-19T00:00:00.000Z");
	});

	it("steps by exactly one period with POSITIVE jitter too", () => {
		// The case that always worked. It is here so a future change cannot fix the negative
		// branch by breaking the positive one.
		pinJitter(1);
		let slot = "2026-08-09T00:00:00.000Z";
		for (let i = 0; i < 5; i++) {
			const now = new Date(Date.parse(slot) + 90 * 60_000);
			const prev = slot;
			slot = advanceCron("@daily", { now, slot, jitterMinutes: 90 }).slot;
			expect(Date.parse(slot) - Date.parse(prev)).toBe(DAY_MS);
		}
	});

	it("the fire time is the slot when there is no jitter", () => {
		const now = new Date("2026-08-08T00:16:00.000Z");
		const { slot, fire } = advanceCron("@daily", { now, slot: "2026-08-08T00:00:00.000Z" });
		expect(slot).toBe("2026-08-09T00:00:00.000Z");
		expect(fire).toBe(slot);
	});

	it("keeps the wall-clock hour in a timezone rather than drifting with the jitter", () => {
		// The slot is what carries the zone's meaning. If the next slot were derived from a
		// jittered instant, "08:00 in Melbourne" would wander by the jitter every single day.
		pinJitter(0);
		let slot = "2026-07-12T22:00:00.000Z"; // 08:00 Melbourne
		for (let i = 0; i < 4; i++) {
			const now = new Date(Date.parse(slot) - 30 * 60_000);
			slot = advanceCron("0 8 * * *", { now, slot, timeZone: "Australia/Melbourne", jitterMinutes: 30 }).slot;
		}
		expect(slot).toBe("2026-07-16T22:00:00.000Z");
	});
});

describe("advanceCron — bases that are not a live slot", () => {
	it("a legacy row with no slot advances from now, exactly as before, and gains one", () => {
		// Migration 0100 adds the column with no backfill: a slot that was never stored cannot be
		// recovered. The row behaves as it always did for ONE run and is correct forever after.
		const now = new Date("2026-08-08T00:16:00.000Z");
		for (const missing of [null, undefined, ""]) {
			const { slot } = advanceCron("@daily", { now, slot: missing, jitterMinutes: 0 });
			expect(slot).toBe("2026-08-09T00:00:00.000Z");
		}
	});

	it("an unparseable slot is treated as absent, not as NaN", () => {
		// `Date.parse` returns NaN and every comparison against NaN is false, so the base falls
		// through to `now`. Asserted because the alternative — `new Date(NaN)` reaching
		// `nextRunAt` — produces an Invalid Date and a row that can never fire again.
		const now = new Date("2026-08-08T00:16:00.000Z");
		expect(advanceCron("@daily", { now, slot: "not-a-date", jitterMinutes: 0 }).slot).toBe("2026-08-09T00:00:00.000Z");
	});

	it("a sweep resuming after an outage does NOT replay every missed slot", () => {
		// The hazard introduced by naively using the slot alone: after a three-day gap the stored
		// slot is far in the past, and stepping slot→slot would return a time still behind `now`,
		// firing immediately, over and over, until it caught up — a catch-up storm against a real
		// logged-in account. `max(slot, now)` resumes at the next REAL slot instead.
		const now = new Date("2026-08-12T10:00:00.000Z");
		const { slot, fire } = advanceCron("@daily", { now, slot: "2026-08-09T00:00:00.000Z", jitterMinutes: 0 });
		expect(slot).toBe("2026-08-13T00:00:00.000Z");
		expect(Date.parse(fire)).toBeGreaterThan(now.getTime());
	});

	it("an interval schedule advances exactly one period when jitter is smaller than the period", () => {
		// `every 15 minutes` with 5 minutes of jitter, pinned negative — the interval-schedule
		// version of the @daily bug. Without the slot, firing at slot−5 and asking "what's next"
		// returned slot+10, and the interval quietly shortened on every negatively-jittered run.
		pinJitter(0);
		let slot = "2026-08-08T00:00:00.000Z";
		for (let i = 0; i < 6; i++) {
			const now = new Date(Date.parse(slot) - 5 * 60_000);
			const prev = slot;
			slot = advanceCron("every 15 minutes", { now, slot, jitterMinutes: 5 }).slot;
			expect(Date.parse(slot) - Date.parse(prev)).toBe(15 * 60_000);
		}
	});

	it("jitter WIDER than the period drifts rather than storming — the lesser of two evils", () => {
		// `every 15 minutes` with 90 minutes of jitter is a self-contradictory configuration that
		// the API nonetheless accepts (`jitterMinutes` is clamped at 720 and never compared to the
		// schedule). Documenting the behaviour rather than pretending it cannot arise:
		//
		// The run fires 90 minutes AFTER its slot, so slot+15 is already an hour in the past.
		// Advancing to it would produce a fire time floored to `now + 60s`, then another, and
		// another, until the chain caught up — six rapid runs to "make up" missed 15-minute
		// windows nobody wanted. `max(slot, now)` gives up the phase instead and advances from
		// now, so the schedule drifts but never doubles up.
		//
		// If this configuration should be REFUSED at the edge rather than absorbed here, that is
		// a separate decision about the create/update grammar, not about this function.
		pinJitter(1);
		const slot = "2026-08-08T00:00:00.000Z";
		const now = new Date(Date.parse(slot) + 90 * 60_000);
		const next = advanceCron("every 15 minutes", { now, slot, jitterMinutes: 90 });

		expect(Date.parse(next.slot)).toBe(now.getTime() + 15 * 60_000);
		// The property that actually matters: never SHORTER than one period from the last fire.
		expect(Date.parse(next.slot) - now.getTime()).toBeGreaterThanOrEqual(15 * 60_000);
	});

	it("propagates an invalid schedule as a throw, so the sweep can disable the row", () => {
		// `runDueTriggers` relies on this: `normalizeSchedule` rejecting a row an older grammar
		// accepted is what triggers the disable-with-a-reason branch. Swallowing it here would
		// silently resurrect the one-bad-row-stops-every-cron failure (cf79306).
		expect(() => advanceCron("* * * * *", { now: new Date("2026-08-08T00:00:00.000Z") })).toThrow();
	});
});
