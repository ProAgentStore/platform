/**
 * The daily stats rollup (#313) — a cron pass, a keyed read, and one semantic rule.
 *
 * ## Why it exists
 *
 * For AGENT-DEFINED collections a daily snapshot is the only way to get a time series at all. See
 * the header of `migrations/0089_agent_stats_daily.sql` for the full argument; the short version is
 * that the record shape belongs to the agent, so there is no timestamp of ours to aggregate over,
 * and no amount of querying the collection later recovers a history nobody recorded.
 *
 * ## The rule that must not be got wrong
 *
 * **A missing day is a gap, not a zero.** {@link buildSeries} therefore returns
 * `Array<{ day, value: number | null }>` and NEVER coalesces. `stats-rollup.test.ts` asserts a
 * stored 0 and an absent day are distinguishable end to end, because this is exactly the kind of
 * thing a later change "simplifies" to `?? 0` — and then the chart says "you found no leads on
 * Tuesday" when the truth is "nothing ran on Tuesday".
 *
 * ## Completed days only, once per instance per day
 *
 * The sweep writes YESTERDAY's rows. A completed UTC day is immutable, so insert-once on the
 * primary key is exactly right and there is no partial-day row to be misread as a collapse. The
 * candidate query skips any instance that already has a row for the day, which is what bounds the
 * per-minute cost to "active instances not yet rolled up" rather than "every instance".
 */
import { readInstanceConfigPair } from "./instance-config.js";
import { logUnhandled } from "./on-error.js";
import { resolveStatsCards, type StatsCard } from "./stats-schema.js";
import { dayUtc, readDaily, type StatsCtx } from "./stats-sources.js";
import type { Env } from "../types.js";

/** How many instances one cron tick will roll up. The cron is per-minute, so the backlog after
 *  midnight drains in a few ticks; the cap is what stops one tick from exceeding the Worker's
 *  time budget and dying with nothing written. */
const ROLLUP_BATCH = 50;

/** ~400 days, swept in the same pass so the table stays bounded without a second cron. */
const RETENTION_DAYS = 400;

/** Rows deleted per tick. Bounded so the retention sweep can never be the expensive part. */
const RETENTION_BATCH = 500;

/** Only trend cards have history. `line` is the only trend kind — see `familyForKind`. */
export function trendCards(cards: readonly StatsCard[]): StatsCard[] {
	return cards.filter((c) => c.kind === "line");
}

/** UTC `YYYY-MM-DD` for the most recent COMPLETED day. */
export function completedDay(now: Date): string {
	return dayUtc(now.getTime() - 86_400_000);
}

interface ActiveRow {
	instance_id: string;
	user_id: string;
}

/**
 * One table an instance's activity can show up in, and how to bound that table to a day.
 *
 * ## Why this is a table and not one query (#423)
 *
 * These six were arms of a single `UNION` until #423. **D1 caps a compound SELECT at FIVE terms** —
 * measured against the production database on 2026-08-08: five arms execute, six raise
 * `D1_ERROR: too many terms in compound SELECT: SQLITE_ERROR`. That is a PARSE failure, so the
 * statement never ran once. It was the rollup's first query, so `runStatsRollup` threw before
 * writing anything, on every cron tick, from the deploy that shipped it (2026-08-06 23:21 UTC) —
 * 1780 identical rows in 29 hours, ~97% of the entire error log.
 *
 * Six single-table reads have no such ceiling, so a seventh source is a line in this array rather
 * than an outage. Trimming to five arms was rejected for exactly that reason: it puts the next
 * person one commit from the same failure, and the failure is silent.
 *
 * `SELECT DISTINCT` is what `UNION` used to provide. Without it a busy day's `ai_usage` returns a
 * row per model call rather than a row per instance, and the merge below would run over thousands
 * of duplicates instead of a handful of ids.
 */
interface ActivitySource {
	/** The table. A frozen constant — never a runtime value; see the guard in `sql.test.ts`. */
	readonly table: string;
	/** The column bounded to the day. */
	readonly column: string;
	/**
	 * How that column stores time. `text` compares against midnight-aligned `YYYY-MM-DD HH:MM:SS`
	 * so it is correct against BOTH `datetime('now')` output and ISO text; `ms` against epoch
	 * milliseconds. See the header of `stats-sources.ts`.
	 */
	readonly time: "text" | "ms";
	/**
	 * `instance_id` is nullable on this table — some call paths know only the agent. Without the
	 * explicit IS NOT NULL a NULL group is selected and every card is then computed against an
	 * instance id of "null".
	 */
	readonly nullableInstance?: boolean;
}

/** The tables an "active instance" can be observed in. All six existed already; none was added for
 *  the rollup, which is why the shapes differ. */
const ACTIVITY_SOURCES: readonly ActivitySource[] = [
	{ table: "ai_usage", column: "created_at", time: "text", nullableInstance: true },
	{ table: "agent_trigger_events", column: "created_at", time: "text" },
	{ table: "instance_runtime_tasks", column: "updated_at", time: "text" },
	{ table: "agent_events", column: "ts", time: "ms", nullableInstance: true },
	{ table: "agent_loop_runs", column: "started_at", time: "ms" },
	{ table: "pipeline_runs", column: "started_at", time: "ms" },
];

/**
 * One source's candidate read. `?1`/`?2` are the day bounds in that source's own representation,
 * `?3` the day, `?4` the row cap.
 *
 * Exported so a test can assert the generated SQL against every source without a live D1 — the
 * previous shape shipped with six branches nobody had executed, and a wrong column name would have
 * been just as invisible as the compound-SELECT ceiling was.
 */
export function activitySourceSql(s: ActivitySource): string {
	const notNull = s.nullableInstance ? " AND instance_id IS NOT NULL" : "";
	return `SELECT DISTINCT instance_id, user_id FROM ${s.table}
	         WHERE user_id IS NOT NULL${notNull}
	           AND ${s.column} >= ?1 AND ${s.column} < ?2
	           AND NOT EXISTS (SELECT 1 FROM agent_stats_daily d
	                            WHERE d.instance_id = ${s.table}.instance_id AND d.day = ?3)
	         LIMIT ?4`;
}

/** The statements `activeInstancesForDay` issues, for the test that proves each one parses. */
export const activitySourceStatements = (): string[] => ACTIVITY_SOURCES.map(activitySourceSql);

/**
 * Instances that did something on `day` and have no rollup row for it yet.
 *
 * The six reads are issued CONCURRENTLY and merged here, keyed on `instance_id|user_id` — the set
 * semantics the `UNION` used to give. `limit` is applied to the MERGED set, not per branch: a
 * per-branch cap that also decided the batch would silently shrink it to a fraction of
 * `ROLLUP_BATCH` whenever several sources saw the same instance. The per-branch `LIMIT` that
 * remains is only a bound on how much one source can return; it cannot lose an instance
 * permanently, because the next tick re-reads and anything already rolled up drops out of the
 * NOT EXISTS.
 */
export async function activeInstancesForDay(env: Env, day: string, limit = ROLLUP_BATCH): Promise<ActiveRow[]> {
	const startText = `${day} 00:00:00`;
	const endText = `${dayUtc(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000)} 00:00:00`;
	const startMs = Date.parse(`${day}T00:00:00.000Z`);
	const endMs = startMs + 86_400_000;
	const perSource = await Promise.all(
		ACTIVITY_SOURCES.map(async (s) => {
			const [from, to] = s.time === "text" ? [startText, endText] : [startMs, endMs];
			const { results } = await env.DB.prepare(activitySourceSql(s)).bind(from, to, day, limit).all<ActiveRow>();
			return results ?? [];
		}),
	);
	const merged = new Map<string, ActiveRow>();
	for (const rows of perSource) {
		for (const r of rows) {
			if (!r.instance_id || !r.user_id) continue;
			merged.set(`${r.instance_id}|${r.user_id}`, r);
		}
	}
	return [...merged.values()].slice(0, limit);
}

/**
 * Write one card's value for one completed day, once.
 *
 * `INSERT … WHERE NOT EXISTS` is the single-flight shape `claimDelivery` and `runDueTriggers`
 * already use. Note honestly what each half does: the WHERE NOT EXISTS stops the SECOND tick from
 * doing the work, and the PRIMARY KEY is what actually guarantees one row if two ticks somehow
 * interleave between the check and the insert. The insert is therefore allowed to fail on the key
 * without failing the sweep — losing the race means the row is already correct.
 */
export async function insertDailyOnce(
	env: Env,
	row: { instanceId: string; userId: string; cardId: string; day: string; value: number },
): Promise<boolean> {
	const res = await env.DB.prepare(
		`INSERT INTO agent_stats_daily (instance_id, user_id, card_id, day, value_json, computed_at)
		 SELECT ?1, ?2, ?3, ?4, ?5, datetime('now')
		  WHERE NOT EXISTS (
		        SELECT 1 FROM agent_stats_daily WHERE instance_id = ?1 AND card_id = ?3 AND day = ?4)`,
	)
		.bind(row.instanceId, row.userId, row.cardId, row.day, JSON.stringify(row.value))
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

async function instanceCards(env: Env, instanceId: string, userId: string): Promise<StatsCard[]> {
	const pair = await readInstanceConfigPair(env, instanceId, userId);
	if (!pair) return [];
	return resolveStatsCards(pair.agentConfig.statsSchema, pair.config.stats);
}

/** Delete rows older than the retention cap, a bounded batch at a time. */
export async function sweepStatsRetention(env: Env, now: Date): Promise<number> {
	const cutoff = dayUtc(now.getTime() - RETENTION_DAYS * 86_400_000);
	const res = await env.DB.prepare(
		`DELETE FROM agent_stats_daily
		  WHERE rowid IN (SELECT rowid FROM agent_stats_daily WHERE day < ?1 LIMIT ?2)`,
	)
		.bind(cutoff, RETENTION_BATCH)
		.run();
	return res.meta?.changes ?? 0;
}

/**
 * One cron tick. Swallows and logs its own failures — it is one of several independent sweeps
 * sharing the `* * * * *` entry, and a broken rollup must not stop trigger delivery from draining.
 */
export async function runStatsRollup(env: Env, now = new Date()): Promise<{ instances: number; written: number }> {
	const day = completedDay(now);
	let instances = 0;
	let written = 0;
	try {
		const active = await activeInstancesForDay(env, day);
		for (const { instance_id: instanceId, user_id: userId } of active) {
			instances++;
			try {
				const cards = trendCards(await instanceCards(env, instanceId, userId));
				const ctx: StatsCtx = { env, instanceId, userId };
				// Phase 1: collect all values before writing any (#658).
				//
				// `null` from `readDaily` means the source cannot produce a daily scalar for this card
				// (e.g. the source has no `daily` executor, or the backing DO reported it has no such
				// collection). Those cards are skipped — not written as 0.
				//
				// A THROW from `readDaily` means a transient failure. We let it propagate to the
				// per-instance catch so that NO card is written for this instance. With zero writes the
				// `NOT EXISTS` candidate guard finds nothing for the day and the whole instance is
				// retried next tick — correct behaviour. If we caught here and wrote the cards that
				// succeeded, the partial-write would satisfy NOT EXISTS and the failed card would never
				// be revisited.
				const toWrite: Array<{ cardId: string; value: number }> = [];
				for (const card of cards) {
					const value = await readDaily(ctx, card, day);
					if (value === null) continue;
					toWrite.push({ cardId: card.id, value });
				}
				// Phase 2: write — only reached when every readDaily call resolved (or returned null).
				for (const { cardId, value } of toWrite) {
					if (await insertDailyOnce(env, { instanceId, userId, cardId, day, value })) written++;
				}
			} catch (err) {
				// One instance's bad config or unreachable DO must not stop the rest of the batch.
				await logUnhandled(env, err, { path: "scheduled:stats-rollup", method: "CRON", userId });
			}
		}
		await sweepStatsRetention(env, now);
	} catch (err) {
		await logUnhandled(env, err, { path: "scheduled:stats-rollup", method: "CRON" });
	}
	return { instances, written };
}

// ── Reading a series back ───────────────────────────────────────────────────

export interface StatsPoint {
	day: string;
	/** `null` means NO ROW for that day — the agent did not run. It is not zero, and a renderer
	 *  must draw a break in the line rather than touching the axis. */
	value: number | null;
}

/** The `count` UTC days ending at (and including) `throughDay`, oldest first. */
export function enumerateDays(throughDay: string, count: number): string[] {
	const end = Date.parse(`${throughDay}T00:00:00.000Z`);
	const days: string[] = [];
	for (let i = count - 1; i >= 0; i--) days.push(dayUtc(end - i * 86_400_000));
	return days;
}

/**
 * Left-join stored rows onto the full day list.
 *
 * Pure, and separated from the query for exactly one reason: this is where the gap rule lives, and
 * it needs a test that a stored `0` and an absent day come out different.
 */
export function buildSeries(days: readonly string[], rows: ReadonlyArray<{ day: string; value_json: string }>): StatsPoint[] {
	const byDay = new Map<string, number>();
	for (const r of rows) {
		const parsed = Number(JSON.parse(r.value_json));
		// A row whose payload will not parse to a number is dropped, which surfaces as a gap. That is
		// the honest outcome: we recorded something we can no longer read, and a gap says "unknown"
		// where a 0 would claim knowledge.
		if (Number.isFinite(parsed)) byDay.set(r.day, parsed);
	}
	return days.map((day) => ({ day, value: byDay.has(day) ? (byDay.get(day) as number) : null }));
}

/** One trend card's series, owner-scoped, ending at the most recent completed day. */
export async function readStatsSeries(
	env: Env,
	instanceId: string,
	userId: string,
	cardId: string,
	days: number,
	now = new Date(),
): Promise<StatsPoint[]> {
	const throughDay = completedDay(now);
	const wanted = enumerateDays(throughDay, days);
	const { results } = await env.DB.prepare(
		`SELECT day, value_json FROM agent_stats_daily
		  WHERE instance_id = ?1 AND user_id = ?2 AND card_id = ?3 AND day >= ?4 AND day <= ?5
		  ORDER BY day ASC`,
	)
		.bind(instanceId, userId, cardId, wanted[0], throughDay)
		.all<{ day: string; value_json: string }>();
	return buildSeries(wanted, results ?? []);
}

/**
 * The earliest day this instance has ANY rollup row for, or null.
 *
 * Surfaced so a surface can disclose where history begins. There is no backfill: a three-day series
 * on a month-old agent means the rollup started three days ago, not that the agent did nothing
 * before Tuesday, and a chart that does not say so is making the second claim.
 */
export async function statsHistoryStart(env: Env, instanceId: string, userId: string): Promise<string | null> {
	const row = await env.DB.prepare("SELECT MIN(day) AS d FROM agent_stats_daily WHERE instance_id = ?1 AND user_id = ?2")
		.bind(instanceId, userId)
		.first<{ d: string | null }>();
	return row?.d ?? null;
}
