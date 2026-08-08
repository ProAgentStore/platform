import { describe, expect, it } from "vitest";
import { findCompoundSelectOverruns } from "./sql.js";
import {
	activeInstancesForDay,
	activitySourceStatements,
	buildSeries,
	completedDay,
	enumerateDays,
	insertDailyOnce,
	trendCards,
} from "./stats-rollup.js";
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

/**
 * A D1 stub for the candidate read that answers PER TABLE and records what it was asked.
 *
 * The shape of #423's failure is the reason this exists: the candidate query had never executed,
 * anywhere, and the suite was green because nothing in it ever reached the query. A stub that
 * accepts any SQL and returns a fixed list would reproduce exactly that hole, so this one keys its
 * answer off the table named in the statement — a wrong table name returns nothing and the
 * assertion fails.
 */
function fakeActivityDb(byTable: Record<string, Array<{ instance_id: string; user_id: string }>>) {
	const asked: Array<{ sql: string; binds: unknown[] }> = [];
	const env = {
		DB: {
			prepare: (sql: string) => ({
				bind: (...binds: unknown[]) => ({
					all: async () => {
						asked.push({ sql, binds });
						const table = /FROM (\w+)/.exec(sql)?.[1] ?? "";
						const limit = Number(binds[3]) || 50;
						return { results: (byTable[table] ?? []).slice(0, limit) };
					},
				}),
			}),
		},
	} as unknown as Env;
	return { env, asked };
}

/**
 * The candidate read — the query that failed on every tick for 29 hours (#423).
 *
 * `stats-rollup.test.ts` covered `buildSeries`, `completedDay`, `enumerateDays`, `insertDailyOnce`
 * and `trendCards` and NOT this, which is precisely how a query that cannot parse shipped green.
 */
describe("activeInstancesForDay", () => {
	const DAY = "2026-08-06";

	it("issues one statement per source, none of them a compound SELECT", () => {
		// THE regression. Six arms of a `UNION` exceeded D1's five-term ceiling and the statement
		// never parsed. Asserting "no overrun" would also pass if someone trimmed to five arms, so
		// assert the structural property instead: no statement unions anything at all.
		const statements = activitySourceStatements();
		expect(statements.length).toBeGreaterThanOrEqual(6);
		for (const sql of statements) {
			expect(sql, sql).not.toMatch(/\bUNION\b/i);
			expect(findCompoundSelectOverruns(`const q = \`${sql}\`;`), sql).toEqual([]);
		}
	});

	it("every source is owner-scoped, day-bounded and skips days already rolled up", () => {
		// Dropping any one of these is silent: an unscoped read is cross-tenant, an unbounded one
		// rolls up the wrong day, and a missing NOT EXISTS re-does work every tick forever.
		for (const sql of activitySourceStatements()) {
			expect(sql, sql).toContain("user_id IS NOT NULL");
			expect(sql, sql).toContain("SELECT DISTINCT instance_id, user_id");
			expect(sql, sql).toMatch(/>= \?1 AND \w+ < \?2/);
			expect(sql, sql).toContain("NOT EXISTS");
			expect(sql, sql).toContain("d.day = ?3");
		}
	});

	it("merges the sources into a SET — an instance seen in three of them is one candidate", () => {
		const both = { instance_id: "inst-1", user_id: "user-1" };
		const { env } = fakeActivityDb({
			ai_usage: [both, { instance_id: "inst-2", user_id: "user-1" }],
			agent_events: [both],
			agent_loop_runs: [both],
		});
		return activeInstancesForDay(env, DAY).then((rows) => {
			expect(rows).toHaveLength(2);
			expect(rows.map((r) => r.instance_id).sort()).toEqual(["inst-1", "inst-2"]);
		});
	});

	it("applies the batch cap to the MERGED set, not per source", () => {
		// The trap called out in #423: with a per-branch cap deciding the batch, six sources seeing
		// the same instances shrink a 50-instance tick to a handful and the backlog never drains.
		const rows = (n: number, from: number) =>
			Array.from({ length: n }, (_, i) => ({ instance_id: `inst-${from + i}`, user_id: "user-1" }));
		const { env } = fakeActivityDb({ ai_usage: rows(3, 0), agent_events: rows(3, 3), pipeline_runs: rows(3, 6) });
		return activeInstancesForDay(env, DAY, 9).then((r) => expect(r).toHaveLength(9));
	});

	it("binds text bounds to text columns and epoch-ms bounds to ms columns", () => {
		// The two representations are not interchangeable: an ISO string compared against `ts` is
		// silently never in range, so a source would report no activity forever rather than fail.
		const { env, asked } = fakeActivityDb({});
		return activeInstancesForDay(env, DAY).then(() => {
			const byTable = new Map(asked.map((a) => [/FROM (\w+)/.exec(a.sql)?.[1] ?? "", a.binds]));
			expect(byTable.get("ai_usage")?.[0]).toBe("2026-08-06 00:00:00");
			expect(byTable.get("ai_usage")?.[1]).toBe("2026-08-07 00:00:00");
			expect(byTable.get("agent_events")?.[0]).toBe(Date.parse("2026-08-06T00:00:00.000Z"));
			expect(byTable.get("agent_events")?.[1]).toBe(Date.parse("2026-08-07T00:00:00.000Z"));
			for (const binds of byTable.values()) expect(binds[2]).toBe(DAY);
		});
	});

	it("drops a row missing an instance or an owner rather than rolling up an instance of 'null'", () => {
		const { env } = fakeActivityDb({
			ai_usage: [{ instance_id: "", user_id: "user-1" }, { instance_id: "inst-1", user_id: "" }, { instance_id: "inst-2", user_id: "user-1" }],
		});
		return activeInstancesForDay(env, DAY).then((rows) => expect(rows).toEqual([{ instance_id: "inst-2", user_id: "user-1" }]));
	});
});

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
