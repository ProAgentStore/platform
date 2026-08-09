/**
 * Tests for the schedule arithmetic in `cron-schedule.ts`.
 *
 * The `advanceCron` function is the principal guard against the double-fire bug (#412):
 * a negatively-jittered run fires before its slot, and advancing from the FIRE time instead
 * of the SLOT returns the same slot — minutes away instead of a period away.
 */
import { describe, expect, it } from "vitest";
import { advanceCron, applyJitter, nextRunAt } from "./cron-schedule.js";

// ---------------------------------------------------------------------------
// advanceCron — the slot-based period advance (#412)
// ---------------------------------------------------------------------------
describe("advanceCron (#412 — next slot computed from the slot, not the fire time)", () => {
	it("advances @daily by exactly one day when the previous run was negatively jittered (early)", () => {
		// Concrete case from the issue:
		//   slot = 2026-08-09T00:00:00Z  (midnight)
		//   fire = 2026-08-08T23:36:00Z  (slot − 24 min, from earlier negative jitter)
		//   sweep now = 2026-08-08T23:36:00Z
		//
		// Before the fix, nextRunAt("@daily", now=23:36) returned 00:00 that SAME night (24 min
		// away), and a new negative jitter could produce a fire time before midnight again →
		// the trigger fired every night AND at least once more before the next midnight.
		//
		// After the fix, we advance from the SLOT. nextRunAt("@daily", slot=00:00) returns
		// 2026-08-10T00:00:00Z — exactly one day later.

		const slot = "2026-08-09T00:00:00.000Z";
		const sweepNow = new Date("2026-08-08T23:36:00.000Z"); // fired early

		const { slot: nextSlot } = advanceCron("@daily", {
			now: sweepNow,
			slot,
			jitterMinutes: 0, // test the slot without jitter noise
		});

		expect(nextSlot).toBe("2026-08-10T00:00:00.000Z");
	});

	it("advances @daily by exactly one day across five consecutive negative-jitter runs", () => {
		// Simulate five nightly runs, each firing 30 minutes BEFORE its slot.
		// The slot must step by exactly +1 day each time regardless of early fires.
		let slot: string | null = "2026-08-09T00:00:00.000Z";

		for (let day = 0; day < 5; day++) {
			const fireMs = Date.parse(slot!) - 30 * 60_000; // 30 min early
			const sweepNow = new Date(fireMs);

			const { slot: nextSlot } = advanceCron("@daily", {
				now: sweepNow,
				slot,
				jitterMinutes: 0,
			});

			const expectedMs = Date.parse(slot!) + 24 * 60 * 60_000;
			expect(Date.parse(nextSlot)).toBe(expectedMs);
			slot = nextSlot;
		}
	});

	it("advances @daily by exactly one day when the run is positively jittered (late)", () => {
		// Positive jitter: fire AFTER the slot. The next slot must still be exactly +1 day.
		const slot = "2026-08-09T00:00:00.000Z";
		const sweepNow = new Date("2026-08-09T01:15:00.000Z"); // 75 min late (past the slot)

		const { slot: nextSlot } = advanceCron("@daily", {
			now: sweepNow,
			slot,
			jitterMinutes: 0,
		});

		// slot is BEFORE now, so advanceCron uses now as the base (catch-up guard).
		// nextRunAt("@daily", 01:15 on Aug 9) → Aug 10 00:00, which is still +1 day from the slot.
		expect(nextSlot).toBe("2026-08-10T00:00:00.000Z");
	});

	it("recovers correctly when next_slot_at is NULL (rows written before migration 0100)", () => {
		// A row with no slot falls back to now for exactly one run, then acquires a slot.
		// "now" here is 2026-08-08T23:36:00Z. For @daily, the next slot from that time is
		// 2026-08-09T00:00:00Z — the normal next midnight, which is a sane first slot.
		const sweepNow = new Date("2026-08-08T23:36:00.000Z");

		const { slot: nextSlot } = advanceCron("@daily", {
			now: sweepNow,
			slot: null, // no stored slot
			jitterMinutes: 0,
		});

		// After healing, the slot is the next midnight after the fire time.
		expect(nextSlot).toBe("2026-08-09T00:00:00.000Z");
	});

	it("the fire time (with jitter) is always based on the slot, not on now", () => {
		// Verify that applyJitter is called on the slot, not on now.
		// The slot is one day ahead; even with maximum negative jitter the fire time
		// must be well after the sweep, not just minutes after it.

		const slot = "2026-08-09T00:00:00.000Z";
		const sweepNow = new Date("2026-08-08T23:36:00.000Z"); // 24 min before slot

		// Run enough trials to be sure the minimum outcome is always > now.
		for (let i = 0; i < 100; i++) {
			const { slot: nextSlot, fire } = advanceCron("@daily", {
				now: sweepNow,
				slot,
				jitterMinutes: 90,
			});

			const nextSlotMs = Date.parse(nextSlot);
			const fireMs = Date.parse(fire);

			// The next slot must be one day after the stored slot.
			expect(nextSlotMs).toBe(Date.parse(slot) + 24 * 60 * 60_000);

			// The fire time must be within ±90 min of the next slot.
			expect(Math.abs(fireMs - nextSlotMs)).toBeLessThanOrEqual(90 * 60_000 + 1000);

			// Crucially: the fire time must be well AFTER the sweep (not just minutes away).
			// Minimum possible fire = nextSlot − 90 min = 2026-08-09T22:30:00Z (about 23 h away).
			expect(fireMs).toBeGreaterThan(sweepNow.getTime() + 22 * 60 * 60_000);
		}
	});

	it("@hourly advances by 60 minutes from the slot", () => {
		const slot = "2026-08-09T03:00:00.000Z";
		const sweepNow = new Date("2026-08-09T02:55:00.000Z"); // 5 min early

		const { slot: nextSlot } = advanceCron("@hourly", {
			now: sweepNow,
			slot,
			jitterMinutes: 0,
		});

		expect(nextSlot).toBe("2026-08-09T04:00:00.000Z");
	});

	it("every N minutes advances by exactly N minutes from the slot", () => {
		const slot = "2026-08-09T10:30:00.000Z";
		const sweepNow = new Date("2026-08-09T10:28:00.000Z"); // 2 min early

		const { slot: nextSlot } = advanceCron("every 15 minutes", {
			now: sweepNow,
			slot,
			jitterMinutes: 0,
		});

		expect(nextSlot).toBe("2026-08-09T10:45:00.000Z");
	});
});

// ---------------------------------------------------------------------------
// The bug in isolation — proves the old code was wrong, the new code is right
// ---------------------------------------------------------------------------
describe("nextRunAt from fire-time vs slot-time — documents the #412 mechanism", () => {
	it("demonstrates: nextRunAt from the early fire returns the SAME slot (the bug)", () => {
		const slot = "2026-08-09T00:00:00.000Z"; // correct scheduled slot
		const fireTime = "2026-08-08T23:36:00.000Z"; // early fire (negative jitter)

		// Old (broken) path: compute next slot from the FIRE time.
		const buggyNext = nextRunAt("@daily", new Date(fireTime));
		// This returns Aug 9 00:00 — only 24 minutes from the fire time, not a full day.
		expect(buggyNext).toBe(slot); // same midnight the trigger was already pointing at

		// New (correct) path: compute next slot from the SLOT.
		const correctNext = nextRunAt("@daily", new Date(slot));
		// This returns Aug 10 00:00 — a full day later.
		expect(correctNext).toBe("2026-08-10T00:00:00.000Z");
	});
});
