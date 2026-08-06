import { describe, expect, it } from "vitest";
import { buildSeries, completedDay, enumerateDays, insertDailyOnce, trendCards } from "./stats-rollup.js";
import type { StatsCard } from "./stats-schema.js";
import type { Env } from "../types.js";

/**
 * A D1 stub that ENFORCES the primary key on `agent_stats_daily`.
 *
 * The point of the single-flight test is that two ticks produce one row, so a stub that always
 * reports `changes: 1` would pass a broken implementation. This one keeps a real key set and
 * evaluates the `WHERE NOT EXISTS` guard against it.
 */
function fakeStatsDb() {
	const rows = new Map<string, { value_json: string }>();
	const env = {
		DB: {
			prepare: (sql: string) => ({
				bind: (...b: unknown[]) => ({
					run: async () => {
						if (!sql.includes("INSERT INTO agent_stats_daily")) return { meta: { changes: 0 } };
						const [instanceId, , cardId, day, valueJson] = b as string[];
						const key = `${instanceId}|${cardId}|${day}`;
						if (rows.has(key)) return { meta: { changes: 0 } };
						rows.set(key, { value_json: valueJson });
						return { meta: { changes: 1 } };
					},
					first: async () => null,
					all: async () => ({ results: [] }),
				}),
			}),
		},
	} as unknown as Env;
	return { env, rows };
}

describe("completedDay", () => {
	it("is YESTERDAY in UTC — today is deliberately never rolled up", () => {
		// A completed day is immutable, so insert-once is correct and no row is ever
		// wrong-because-partial. A partial day charted next to complete ones reads as a collapse in
		// the metric, which is the same lie the gap rule exists to prevent, in a different shape.
		expect(completedDay(new Date("2026-08-07T00:00:30Z"))).toBe("2026-08-06");
		expect(completedDay(new Date("2026-08-07T23:59:59Z"))).toBe("2026-08-06");
	});

	it("crosses a month and a year boundary correctly", () => {
		expect(completedDay(new Date("2026-03-01T00:10:00Z"))).toBe("2026-02-28");
		expect(completedDay(new Date("2027-01-01T00:10:00Z"))).toBe("2026-12-31");
	});
});

describe("enumerateDays", () => {
	it("returns N consecutive UTC days ending at the through-day, oldest first", () => {
		expect(enumerateDays("2026-08-06", 3)).toEqual(["2026-08-04", "2026-08-05", "2026-08-06"]);
	});

	it("spans a month boundary without dropping or duplicating a day", () => {
		const days = enumerateDays("2026-03-02", 4);
		expect(days).toEqual(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
		expect(new Set(days).size).toBe(4);
	});

	it("produces exactly `count` days for every supported window", () => {
		for (const n of [7, 30, 90]) expect(enumerateDays("2026-08-06", n)).toHaveLength(n);
	});
});

describe("buildSeries — a missing day is a GAP, not a zero", () => {
	it("distinguishes a stored 0 from an absent day", () => {
		// THE rule of #313, and the one most likely to be "simplified" to `?? 0` by a later change.
		// A stored 0 means "the agent ran and found nothing"; an absent day means "nothing ran". A
		// chart that renders both as 0 tells the user they found no leads on Tuesday when the truth
		// is that nothing ran on Tuesday — a plausible value standing in for absent information,
		// the same class as #243 and #252.
		const series = buildSeries(["2026-08-04", "2026-08-05", "2026-08-06"], [
			{ day: "2026-08-04", value_json: "0" },
			{ day: "2026-08-06", value_json: "12" },
		]);
		expect(series).toEqual([
			{ day: "2026-08-04", value: 0 },
			{ day: "2026-08-05", value: null },
			{ day: "2026-08-06", value: 12 },
		]);
		// Stated separately, because `toEqual` on the array would still pass if both became 0.
		expect(series[0].value).toBe(0);
		expect(series[1].value).toBeNull();
		expect(series[0].value).not.toBe(series[1].value);
	});

	it("renders an instance with no history at all as all-null, never as a flat zero line", () => {
		// This is what a freshly shipped rollup looks like. A flat line at zero would assert the
		// agent did nothing for 90 days; nulls assert nothing, which is the truth.
		expect(buildSeries(enumerateDays("2026-08-06", 3), []).every((p) => p.value === null)).toBe(true);
	});

	it("drops an unreadable payload to a gap rather than to zero", () => {
		// We recorded something we can no longer parse. A gap says "unknown"; a 0 would claim
		// knowledge we do not have.
		expect(buildSeries(["2026-08-06"], [{ day: "2026-08-06", value_json: "\"oops\"" }])).toEqual([{ day: "2026-08-06", value: null }]);
	});

	it("ignores a stored row outside the requested window instead of shifting the series", () => {
		expect(buildSeries(["2026-08-06"], [{ day: "2026-08-01", value_json: "5" }])).toEqual([{ day: "2026-08-06", value: null }]);
	});
});

describe("insertDailyOnce", () => {
	const row = { instanceId: "inst-1", userId: "user-1", cardId: "leads_per_day", day: "2026-08-06", value: 7 };

	it("two ticks in the same minute produce ONE row, not two", () => {
		// The cron is `* * * * *` and a sweep can outlive its minute, so overlapping ticks are the
		// normal case rather than the exotic one. Double-writing would double-count a day.
		const { env, rows } = fakeStatsDb();
		return Promise.all([insertDailyOnce(env, row), insertDailyOnce(env, row)]).then((results) => {
			expect(results.filter(Boolean)).toHaveLength(1);
			expect(rows.size).toBe(1);
		});
	});

	it("keeps the FIRST value for a day — a completed day is immutable", () => {
		const { env, rows } = fakeStatsDb();
		return insertDailyOnce(env, row)
			.then(() => insertDailyOnce(env, { ...row, value: 999 }))
			.then((second) => {
				expect(second).toBe(false);
				expect(rows.get("inst-1|leads_per_day|2026-08-06")?.value_json).toBe("7");
			});
	});

	it("keys on (instance, card, day), so two cards and two days do not collide", () => {
		const { env, rows } = fakeStatsDb();
		return Promise.all([
			insertDailyOnce(env, row),
			insertDailyOnce(env, { ...row, cardId: "cost_per_day" }),
			insertDailyOnce(env, { ...row, day: "2026-08-05" }),
			insertDailyOnce(env, { ...row, instanceId: "inst-2" }),
		]).then(() => expect(rows.size).toBe(4));
	});
});

describe("trendCards", () => {
	const mk = (id: string, kind: StatsCard["kind"]): StatsCard => ({ id, title: id, kind, source: "runs.count", params: {} });

	it("selects exactly the line cards — nothing else has history", () => {
		// Family is derived from kind (see stats-schema.ts), so this is the one place the rollup
		// needs to know about it. Rolling up a bar card would store a scalar nothing reads.
		expect(trendCards([mk("a", "line"), mk("b", "number"), mk("c", "bar"), mk("d", "table")]).map((c) => c.id)).toEqual(["a"]);
	});

	it("a card removed from the schema stops being rolled up (its history is simply no longer extended)", () => {
		// #313's verification. Removal is not a delete of the past: the rows stay until the
		// retention cap, so re-adding the card the next day shows the earlier history again.
		expect(trendCards([])).toEqual([]);
	});
});
