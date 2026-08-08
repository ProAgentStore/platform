/**
 * The SQL this Worker assembles AT RUNTIME, executed against the real schema (#438).
 *
 * `sql-schema.test.ts` sweeps every statement written out in full — about five hundred of them —
 * and cannot see one with a `${…}` in it, which is roughly forty more and the half where the risk
 * lives. A statement built per call only exists once the code runs, so the only way to check it is
 * to run the code with a database that really parses what it is handed. That is `realSchemaD1()`.
 *
 * The two modules below are here because each already shipped a defect of exactly this kind:
 *
 *   • `stats-rollup.ts` (#423) — six `SELECT`s joined by `UNION`, over D1's five-term ceiling.
 *     A PARSE failure, so it never executed on any environment: 1780 identical error rows in
 *     29.6 hours, 97% of the log, and the stats feature never wrote a row in production.
 *   • `instance-work.ts` (#434) — the same ceiling, reached one branch per subordinate at
 *     runtime. `instance-work.test.ts:28-37` asserted the broken shape AS THE DESIGN, against a
 *     stub that recorded SQL strings and never parsed them. The live supervisor sat at five
 *     subordinates, one short of a team that reads as permanently idle, against a product limit
 *     of twelve.
 *
 * This file is NOT a replacement for those suites. They cover the pure shaping either side of the
 * query and run in microseconds; this one proves the statement in the middle is a statement.
 *
 * Every other module that assembles SQL at runtime is uncovered until somebody writes the same
 * kind of test for it. That is a real gap and it is named rather than implied — `realSchemaD1()`
 * exists so the cost of closing one is a fixture, not a framework.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { assertD1Preparable, type RealSchemaD1, realSchemaD1, seedTenant } from "./d1-sqlite.js";
import { recentActsForInstances, recentRunsForInstances, recentWorkForInstances } from "./instance-work.js";
import { compoundSelectTerms, D1_MAX_COMPOUND_TERMS } from "./sql.js";
import { activeInstancesForDay, activitySourceStatements, insertDailyOnce, sweepStatsRetention } from "./stats-rollup.js";
import type { Env } from "../types.js";

const DAY = "2026-08-06";
const MS = Date.parse(`${DAY}T06:00:00.000Z`);

let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	env = { DB: d1.DB } as unknown as Env;
});

/** Every statement the code issued stayed inside D1's parse ceiling. */
function ceilingHeld() {
	const over = d1.issued.filter((s) => compoundSelectTerms(s.sql) > D1_MAX_COMPOUND_TERMS);
	expect(over.map((s) => s.sql), `${over.length} statement(s) over D1's ${D1_MAX_COMPOUND_TERMS}-term ceiling`).toEqual([]);
}

describe("stats-rollup issues statements D1 can parse (#423)", () => {
	beforeEach(() => {
		seedTenant(d1, {
			userId: "user-1",
			instanceIds: [
				"inst-1",
				"inst-2",
				"inst-3",
				"inst-4",
				"inst-5",
				"inst-done",
				"inst-todo",
				"text-before",
				"text-in",
				"text-after",
				"ms-before",
				"ms-in",
				"ms-after",
			],
		});
	});

	it("every activity source's generated statement prepares against the schema", () => {
		// The six statements are built per source: the table name and the timestamp column are
		// interpolated, so a seventh source added with a column that does not exist on its table
		// is invisible to a string-matching stub AND to the static sweep.
		const statements = activitySourceStatements();
		expect(statements.length).toBeGreaterThanOrEqual(6);
		for (const sql of statements) expect(() => assertD1Preparable(sql, d1.sqlite), sql).not.toThrow();
	});

	it("finds an instance in each source, and merges them into one candidate set", async () => {
		d1.exec(`
			INSERT INTO ai_usage (id, user_id, instance_id, provider, model, kind, created_at)
			 VALUES ('u1', 'user-1', 'inst-1', 'anthropic', 'claude', 'chat', '${DAY} 01:00:00');
			INSERT INTO agent_trigger_events (id, trigger_id, user_id, instance_id, type, status, created_at)
			 VALUES ('e1', 'trig-inst-1', 'user-1', 'inst-1', 'cron', 'ok', '${DAY} 02:00:00');
			INSERT INTO instance_runtime_tasks (id, instance_id, user_id, type, status, payload, created_at, updated_at)
			 VALUES ('t1', 'inst-2', 'user-1', 'ticket', 'open', '{}', '${DAY} 03:00:00', '${DAY} 03:00:00');
			INSERT INTO agent_events (id, ts, user_id, instance_id, source, event)
			 VALUES ('ev1', ${MS}, 'user-1', 'inst-3', 'chat', 'turn');
			INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, max_iterations, started_at)
			 VALUES ('r1', 'user-1', 'inst-4', 'go', 5, ${MS});
			INSERT INTO pipeline_runs (run_id, user_id, instance_id, pipeline, started_at)
			 VALUES ('p1', 'user-1', 'inst-5', 'leads', ${MS});
		`);

		const rows = await activeInstancesForDay(env, DAY);

		// inst-1 appears in two sources and must be ONE candidate — the set semantics the UNION
		// used to provide and the merge now has to.
		expect(rows.map((r) => r.instance_id).sort()).toEqual(["inst-1", "inst-2", "inst-3", "inst-4", "inst-5"]);
		expect(d1.issued.length).toBe(6);
		ceilingHeld();
	});

	it("skips an instance already rolled up for that day, and only for that day", async () => {
		// The NOT EXISTS is what stops the tick redoing its work forever. A string-matching stub
		// can assert the text is present; only running it can show it selects the right rows.
		d1.exec(`
			INSERT INTO ai_usage (id, user_id, instance_id, provider, model, kind, created_at)
			 VALUES ('u1', 'user-1', 'inst-done', 'anthropic', 'claude', 'chat', '${DAY} 01:00:00'),
			        ('u2', 'user-1', 'inst-todo', 'anthropic', 'claude', 'chat', '${DAY} 01:00:00');
			INSERT INTO agent_stats_daily (instance_id, user_id, card_id, day, value_json)
			 VALUES ('inst-done', 'user-1', 'calls', '${DAY}', '1');
		`);
		expect((await activeInstancesForDay(env, DAY)).map((r) => r.instance_id)).toEqual(["inst-todo"]);
		expect((await activeInstancesForDay(env, "2026-08-05")).map((r) => r.instance_id)).toEqual([]);
	});

	it("the day bounds really exclude the neighbouring days, in both time representations", async () => {
		// `ai_usage` compares TEXT and `agent_events` epoch-ms. Binding one to the other is silent:
		// the source simply reports no activity, forever.
		d1.exec(`
			INSERT INTO ai_usage (id, user_id, instance_id, provider, model, kind, created_at)
			 VALUES ('a', 'user-1', 'text-before', 'p', 'm', 'chat', '2026-08-05 23:59:59'),
			        ('b', 'user-1', 'text-in', 'p', 'm', 'chat', '${DAY} 00:00:00'),
			        ('c', 'user-1', 'text-after', 'p', 'm', 'chat', '2026-08-07 00:00:00');
			INSERT INTO agent_events (id, ts, user_id, instance_id, source, event)
			 VALUES ('d', ${Date.parse(`${DAY}T00:00:00.000Z`) - 1}, 'user-1', 'ms-before', 'chat', 'x'),
			        ('e', ${Date.parse(`${DAY}T00:00:00.000Z`)}, 'user-1', 'ms-in', 'chat', 'x'),
			        ('f', ${Date.parse("2026-08-07T00:00:00.000Z")}, 'user-1', 'ms-after', 'chat', 'x');
		`);
		expect((await activeInstancesForDay(env, DAY)).map((r) => r.instance_id).sort()).toEqual(["ms-in", "text-in"]);
	});

	it("writes a day's card once, and the retention sweep deletes only what is past the cap", async () => {
		const row = { instanceId: "inst-1", userId: "user-1", cardId: "calls", day: DAY, value: 7 };
		expect(await insertDailyOnce(env, row)).toBe(true);
		expect(await insertDailyOnce(env, row), "the second tick must not write again").toBe(false);

		d1.exec(`INSERT INTO agent_stats_daily (instance_id, user_id, card_id, day, value_json)
		          VALUES ('inst-1', 'user-1', 'calls', '2020-01-01', '1')`);
		expect(await sweepStatsRetention(env, new Date(`${DAY}T00:00:00.000Z`))).toBe(1);
		const left = d1.sqlite.prepare("SELECT day FROM agent_stats_daily ORDER BY day").all() as { day: string }[];
		expect(left.map((r) => r.day)).toEqual([DAY]);
	});
});

describe("supervision reads survive a full team (#434)", () => {
	// The product limit. Twelve branches in one statement is 12 > 5 and never parses; the read is
	// wrapped in a `.catch`, so what a supervisor saw was not an error but an idle team.
	const IDS = Array.from({ length: 12 }, (_, i) => `inst-${i + 1}`);

	beforeEach(() => {
		seedTenant(d1, { userId: "user-1", instanceIds: IDS });
		seedTenant(d1, { userId: "user-2", instanceIds: [] });
		for (const id of IDS) {
			d1.exec(`
				INSERT INTO instance_runtime_tasks (id, instance_id, user_id, type, status, payload, created_at, updated_at)
				 VALUES ('task-${id}', '${id}', 'user-1', 'ticket', 'open', '{"title":"card for ${id}"}', '${DAY} 01:00:00', '${DAY} 01:00:00');
				INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, max_iterations, started_at)
				 VALUES ('run-${id}', 'user-1', '${id}', 'objective for ${id}', 5, ${MS});
				INSERT INTO agent_events (id, ts, user_id, instance_id, source, event, message, context)
				 VALUES ('act-${id}', ${MS}, 'user-1', '${id}', 'coding', 'act.consequential', 'merged a PR',
				         '{"act":"pr.merge","command":"gh pr merge","irreversible":true}');
			`);
		}
	});

	it("returns a card for every one of twelve subordinates", async () => {
		const items = await recentWorkForInstances(env, "user-1", IDS);
		expect(items.map((i) => i.instanceId).sort()).toEqual([...IDS].sort());
		ceilingHeld();
	});

	it("returns a run for every one of twelve subordinates", async () => {
		const runs = await recentRunsForInstances(env, "user-1", IDS);
		expect(runs.map((r) => r.instanceId).sort()).toEqual([...IDS].sort());
		ceilingHeld();
	});

	it("returns an act for every one of twelve subordinates", async () => {
		const acts = await recentActsForInstances(env, "user-1", IDS);
		expect(acts.map((a) => a.instanceId).sort()).toEqual([...IDS].sort());
		expect(acts.every((a) => a.kind === "pr.merge" && a.irreversible)).toBe(true);
		ceilingHeld();
	});

	it("gives each subordinate its OWN newest rows, not the globally newest", async () => {
		// The reason these are per-instance branches rather than one `IN (…) ORDER BY … LIMIT n`.
		// A flat query returns the newest n across the whole team, so one busy subordinate crowds
		// out the other eleven and the supervisor reads a team of one — a bug that looks like
		// correct SQL and can only be seen by running it against rows.
		for (let i = 0; i < 30; i++) {
			d1.exec(`INSERT INTO instance_runtime_tasks (id, instance_id, user_id, type, status, payload, created_at, updated_at)
			          VALUES ('busy-${i}', 'inst-1', 'user-1', 'ticket', 'open', '{}', '${DAY} 09:00:00', '${DAY} 09:00:${String(i).padStart(2, "0")}')`);
		}
		const items = await recentWorkForInstances(env, "user-1", IDS);
		expect(new Set(items.map((i) => i.instanceId)).size).toBe(12);
	});

	it("reads only the caller's rows", async () => {
		d1.exec(`INSERT INTO instance_runtime_tasks (id, instance_id, user_id, type, status, payload, created_at, updated_at)
		          VALUES ('other', 'inst-1', 'user-2', 'ticket', 'open', '{}', '${DAY} 09:00:00', '${DAY} 09:00:00')`);
		const items = await recentWorkForInstances(env, "user-2", IDS);
		expect(items.map((i) => i.id)).toEqual(["other"]);
	});

	it("the UNCHUNKED shape — what shipped — is refused", () => {
		// The proof that the tests above are load-bearing. Same branch, twelve of them in one
		// statement, which is what `unionAllChunks` produced before #434 chunked it.
		const branch = (p: number) =>
			`SELECT * FROM (SELECT instance_id, id FROM instance_runtime_tasks
			                 WHERE instance_id = ?${p} AND user_id = ?1 ORDER BY updated_at DESC LIMIT ?2)`;
		const unchunked = IDS.map((_, j) => branch(j + 3)).join("\nUNION ALL\n");
		expect(() => d1.sqlite.prepare(unchunked), "plain SQLite parses it — the ceiling is D1's alone").not.toThrow();
		expect(() => assertD1Preparable(unchunked, d1.sqlite)).toThrow(/too many terms in compound SELECT: 12 > 5/);
	});

	it("no statement at all for a supervisor with no subordinates", async () => {
		expect(await recentWorkForInstances(env, "user-1", [])).toEqual([]);
		expect(d1.issued, "an empty UNION ALL is a syntax error — the guard is the early return").toEqual([]);
	});
});
