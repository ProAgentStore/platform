import { describe, expect, it } from "vitest";
import { runDueTriggers, type TriggerRow } from "./triggers.js";
import type { Env } from "../types.js";

/**
 * D1 stub for the cron sweep: SELECT returns the seeded rows, every UPDATE is recorded.
 * `claims` decides whether a compare-and-swap claim succeeds.
 */
function stubEnv(rows: Partial<TriggerRow>[], claims = true) {
	const updates: Array<{ sql: string; args: unknown[] }> = [];
	const env = {
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async all() {
								return { results: rows as TriggerRow[] };
							},
							async run() {
								updates.push({ sql, args });
								return { meta: { changes: claims ? 1 : 0 } };
							},
							async first() {
								return null;
							},
						};
					},
				};
			},
		},
	} as unknown as Env;
	return { env, updates };
}

const trigger = (over: Partial<TriggerRow>): Partial<TriggerRow> => ({
	id: "t1",
	user_id: "u1",
	instance_id: "i1",
	type: "cron",
	action: "create_task",
	enabled: 1,
	config: "{}",
	schedule: "0 9 * * *",
	next_run_at: "2026-08-04T00:00:00.000Z",
	...over,
});

describe("runDueTriggers — one bad row must not stop the platform's cron", () => {
	it("disables a row whose schedule the current grammar rejects, and keeps sweeping", async () => {
		// `* * * * *` was creatable until the minute-floor check (cf79306) and `normalizeSchedule`
		// now throws on it. That computation sat OUTSIDE the per-trigger try, so the throw escaped
		// runDueTriggers entirely — before the claim UPDATE, so `next_run_at` never advanced. The
		// row is due every tick and sorts first (ORDER BY next_run_at ASC), so NO cron trigger on
		// the whole platform ever fired again, for any user, with nothing but a repeating entry in
		// the admin error log to say why.
		const { env, updates } = stubEnv([trigger({ id: "bad", schedule: "* * * * *" }), trigger({ id: "good" })]);
		const res = await runDueTriggers(env, new Date("2026-08-04T01:00:00.000Z"));

		// It did not throw, and it reached the second trigger. (The good row's dispatch also
		// "fails" here — this stub has no instance to act on — which is why `failed` isn't 1.)
		expect(res.checked).toBe(2);
		expect(res.failed).toBeGreaterThanOrEqual(1);

		// The bad row is disabled with a reason, so it cannot be first again next minute.
		const disable = updates.find((u) => u.args[0] === "bad" && u.sql.includes("enabled = 0"));
		expect(disable).toBeTruthy();
		expect(String(disable?.args[1])).toMatch(/no longer valid/i);

		// And the good row was still claimed and dispatched.
		expect(updates.some((u) => u.args[0] === "good" && u.sql.includes("next_run_at"))).toBe(true);
	});

	it("does not disable a row whose schedule is fine", async () => {
		const { env, updates } = stubEnv([trigger({ id: "good" })]);
		await runDueTriggers(env, new Date("2026-08-04T01:00:00.000Z"));
		expect(updates.some((u) => u.sql.includes("enabled = 0"))).toBe(false);
	});

	it("clears the slot when it disables an unschedulable row", async () => {
		// Leaving a slot on a disabled row means re-enabling it later would advance from a
		// position belonging to a schedule that no longer parses.
		const { env, updates } = stubEnv([trigger({ id: "bad", schedule: "* * * * *", next_slot_at: "2026-08-04T00:00:00.000Z" })]);
		await runDueTriggers(env, new Date("2026-08-04T01:00:00.000Z"));
		const disable = updates.find((u) => u.args[0] === "bad" && u.sql.includes("enabled = 0"));
		expect(disable?.sql).toContain("next_slot_at = NULL");
	});
});

/**
 * #412 — the sweep advances from the SLOT, so a negatively-jittered run cannot fire twice.
 *
 * `cron-advance.test.ts` pins the arithmetic. These pin the WIRING: that the sweep reads
 * `next_slot_at` off the row, and writes the new one inside the same compare-and-swap claim that
 * advances `next_run_at`. A perfect `advanceCron` called with the wrong argument — or whose
 * result is dropped on the floor — reproduces the original bug exactly.
 */
describe("runDueTriggers — the slot advances by one period, whatever the jitter", () => {
	/** Claim UPDATE binds: (id, nextRunAt, previousNextRunAt, nextSlotAt). */
	const claimFor = (updates: Array<{ sql: string; args: unknown[] }>, id: string) =>
		updates.find((u) => u.args[0] === id && u.sql.includes("next_run_at = ?2"));

	it("THE BUG: a run firing BEFORE its slot still advances a full day", async () => {
		// The ticket's live row. Slot 2026-08-09T00:00Z; a −24m jitter fired it at 23:36 on the
		// 8th. The old sweep called `nextRunAt("@daily", now = 23:36)` and got 2026-08-09T00:00Z
		// — the slot it was already on — so the next fire landed within about two hours and
		// "@daily" ran twice in one night, with failure_count 0 and last_error null throughout.
		const { env, updates } = stubEnv([
			trigger({
				id: "daily",
				schedule: "@daily",
				config: JSON.stringify({ jitterMinutes: 90 }),
				next_run_at: "2026-08-08T23:36:00.000Z",
				next_slot_at: "2026-08-09T00:00:00.000Z",
			}),
		]);
		const now = new Date("2026-08-08T23:36:00.000Z");
		await runDueTriggers(env, now);

		const claim = claimFor(updates, "daily");
		expect(claim?.args[3]).toBe("2026-08-10T00:00:00.000Z");
		// The fire time it stored is a day out, not later the same night — the observable symptom.
		expect(Date.parse(String(claim?.args[1]))).toBeGreaterThan(now.getTime() + 20 * 60 * 60 * 1000);
	});

	it("writes the slot in the SAME claim that advances next_run_at", async () => {
		// Two statements would let a crash between them leave a fire time from this period beside
		// a slot from the last — which is the split state the ticket is about, re-created.
		const { env, updates } = stubEnv([trigger({ id: "good", schedule: "@daily", next_slot_at: "2026-08-04T00:00:00.000Z" })]);
		await runDueTriggers(env, new Date("2026-08-04T00:00:30.000Z"));

		const claim = claimFor(updates, "good");
		expect(claim?.sql).toContain("next_slot_at = ?4");
		expect(claim?.args[3]).toBe("2026-08-05T00:00:00.000Z");
	});

	it("a legacy row with no slot advances from now and is given one", async () => {
		// No backfill: the row heals on its next sweep. Before this it had nothing to advance
		// from, which is indistinguishable from the old behaviour — for exactly one run.
		const { env, updates } = stubEnv([trigger({ id: "legacy", schedule: "@daily", next_slot_at: null })]);
		await runDueTriggers(env, new Date("2026-08-04T00:16:00.000Z"));

		const claim = claimFor(updates, "legacy");
		expect(claim?.args[3]).toBe("2026-08-05T00:00:00.000Z");
	});
});
