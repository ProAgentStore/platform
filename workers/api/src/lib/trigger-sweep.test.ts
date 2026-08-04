import { describe, expect, it, vi } from "vitest";
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
});
