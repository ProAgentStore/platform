/**
 * The owner-scoped aggregates behind {@link STATS_SOURCES} (#310).
 *
 * ## Every query is scoped by the SERVER, never by the card
 *
 * Each executor below binds `instance_id = ?1 AND user_id = ?2` itself. Nothing a card carries
 * reaches a WHERE clause as SQL: `params` are validated against the source's declared param table
 * (`validateStatsCard`) and then bound as values. That is the whole safety story for agent-authored
 * cards — the schema says WHAT to show, never WHOSE data.
 *
 * ## No fifth record of what happened
 *
 * Every source reads a table that already exists for its own reasons: `ai_usage` (0048/0074/0080),
 * `agent_loop_runs` (0062), `pipeline_runs` (0052), `instance_runtime_tasks` (0012), `agent_events`
 * (0038), `agent_trigger_events` (0045), or the instance's own Durable-Object collections. Nothing
 * here writes.
 *
 * ## Mixed timestamp formats, and why the comparisons are still safe
 *
 * Three storage shapes are in play: `datetime('now')` text (`"YYYY-MM-DD HH:MM:SS"`), occasional
 * ISO text (`"YYYY-MM-DDTHH:MM:SS.sssZ"`), and ms-epoch integers. Text bounds are always taken at a
 * DAY boundary (`"YYYY-MM-DD 00:00:00"`), and at a day boundary both text shapes order identically
 * against it — `'T'` (0x54) and `' '` (0x20) both sit after the date prefix and before the next
 * day's. So a range compare is format-agnostic as long as the bound is midnight, which is the only
 * kind of bound this module produces. A bound at any other time of day would NOT be safe, which is
 * why {@link statsPeriod} only ever builds midnight boundaries.
 */
import type { CollectionRecord, CollectionSchema } from "../agent-storage-types.js";
import { COLLECTION_SCAN_CAP, MAX_CARD_LIMIT, STATS_SOURCES, type StatsCard, type StatsCardKind, type StatsUnit, unitFor } from "./stats-schema.js";
import type { Env } from "../types.js";

export interface StatsCtx {
	env: Env;
	instanceId: string;
	userId: string;
}

/** A half-open [start, end) range, expressed in both storage shapes. See the header. */
export interface StatsPeriod {
	/** Inclusive lower bound for TEXT timestamp columns, always `"YYYY-MM-DD 00:00:00"`. */
	startText: string;
	/** Exclusive upper bound for TEXT timestamp columns. */
	endText: string;
	/** Inclusive lower bound for ms-epoch columns. */
	startMs: number;
	/** Exclusive upper bound for ms-epoch columns. */
	endMs: number;
}

/** Declared once, in the source table beside the caveat (`stats-schema.ts`), because the SAME unit
 *  has to reach both a scalar and a trend series. Re-exported here so existing importers of
 *  `StatsUnit` are unaffected. */
export type { StatsUnit };

export type StatsValue =
	| { type: "scalar"; value: number; unit: StatsUnit }
	| {
			type: "groups";
			rows: Array<{ label: string; value: number }>;
			/** True when the answer covers only part of the data. Never silently true — the console
			 *  and `get_stats` both surface it, because a truncated breakdown presented as complete is
			 *  the confident-wrong-number failure this whole feature is trying not to repeat. */
			partial?: boolean;
			scanned?: number;
			total?: number;
	  };

/** UTC `YYYY-MM-DD` for a ms-epoch instant. */
export function dayUtc(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

/** ms-epoch of `YYYY-MM-DD` at 00:00:00 UTC. */
export function dayStartMs(day: string): number {
	return Date.parse(`${day}T00:00:00.000Z`);
}

/** The half-open range covering `days` whole UTC days ending at (and including) `throughDay`. */
export function statsPeriod(throughDay: string, days: number): StatsPeriod {
	const endMs = dayStartMs(throughDay) + 86_400_000;
	const startMs = endMs - days * 86_400_000;
	return {
		startText: `${dayUtc(startMs)} 00:00:00`,
		endText: `${dayUtc(endMs)} 00:00:00`,
		startMs,
		endMs,
	};
}

/** The range covering exactly one UTC day. */
export function dayPeriod(day: string): StatsPeriod {
	return statsPeriod(day, 1);
}

type Params = Record<string, string | number>;

interface Executor {
	/** Live read over `period`. `kind` picks scalar vs grouped for the sources that do both. */
	point(ctx: StatsCtx, params: Params, period: StatsPeriod, kind: StatsCardKind): Promise<StatsValue>;
	/**
	 * One scalar for one COMPLETED UTC day — the unit the rollup stores (#313).
	 *
	 * Absent means the source cannot back a `line` card. `validateStatsCard` already refuses that
	 * combination via the source's `kinds`, and `stats-sources.test.ts` asserts the two agree, so a
	 * source can never declare a trend it has no way to compute.
	 */
	daily?(ctx: StatsCtx, params: Params, period: StatsPeriod): Promise<number>;
}

// ── D1 helpers ──────────────────────────────────────────────────────────────

/**
 * One number from a one-row query, read from the FIRST column whatever it is aliased.
 *
 * Not `AS v` any more: a dollar aggregate has to carry a name that says whether it is value or a
 * charge (#346), and a reader that insisted on one alias would have forced every query to answer
 * to the same anonymous letter.
 */
async function scalar(ctx: StatsCtx, sql: string, ...extra: unknown[]): Promise<number> {
	const row = await ctx.env.DB.prepare(sql)
		.bind(ctx.instanceId, ctx.userId, ...extra)
		.first<Record<string, unknown>>();
	return Number(Object.values(row ?? {})[0] ?? 0) || 0;
}

async function groups(ctx: StatsCtx, sql: string, limit: number, extra: unknown[]): Promise<StatsValue> {
	const { results } = await ctx.env.DB.prepare(sql)
		.bind(ctx.instanceId, ctx.userId, ...extra, limit)
		.all<{ label: string | null; v: number }>();
	return {
		type: "groups",
		rows: (results ?? []).map((r) => ({ label: r.label ?? "(not set)", value: Number(r.v ?? 0) })),
	};
}

function limitOf(params: Params): number {
	const n = Number(params.limit);
	return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), MAX_CARD_LIMIT) : MAX_CARD_LIMIT;
}

// ── The instance's own collections (Durable Object, not D1) ─────────────────

async function doFetch<T>(ctx: StatsCtx, path: string): Promise<T | null> {
	// The DO is addressed by instance id, and the CALLER has already proved ownership of that
	// instance (`requireOwnedInstance` on the route, an owner-scoped row lookup in the rollup). The
	// DO itself holds only this instance's storage, so there is no cross-tenant read to guard here
	// the way the D1 queries need `user_id`.
	const stub = ctx.env.AGENT.get(ctx.env.AGENT.idFromName(ctx.instanceId));
	const res = await stub.fetch(new Request(`https://agent${path}`));
	if (!res.ok) return null;
	return (await res.json()) as T;
}

async function collectionCount(ctx: StatsCtx, name: string): Promise<number> {
	// `collectionList` reads only the schema keys (which carry a maintained `recordCount`), so this
	// is a handful of DO reads rather than a scan of every record.
	const body = await doFetch<{ collections?: CollectionSchema[] }>(ctx, "/collections");
	const schema = body?.collections?.find((c) => c.name === name);
	return schema ? Number(schema.recordCount ?? 0) : 0;
}

// ── The executors, keyed by source id ───────────────────────────────────────

export const STATS_EXECUTORS: Record<string, Executor> = {
	"usage.tokens": {
		async point(ctx, _p, period) {
			return { type: "scalar", unit: unitFor("usage.tokens"), value: await usageTokens(ctx, period) };
		},
		daily: (ctx, _p, period) => usageTokens(ctx, period),
	},

	// The source id is stored in every agent's stats schema, so it stays `usage.cost` — what it
	// REPORTS is notional value, which the label, the caveat and the SQL alias now all say.
	"usage.cost": {
		async point(ctx, _p, period) {
			return { type: "scalar", unit: unitFor("usage.cost"), value: await usageValue(ctx, period) };
		},
		daily: (ctx, _p, period) => usageValue(ctx, period),
	},

	"runs.count": {
		async point(ctx, _p, period) {
			return { type: "scalar", unit: unitFor("runs.count"), value: await runsCount(ctx, period) };
		},
		daily: (ctx, _p, period) => runsCount(ctx, period),
	},

	"runs.outcome": {
		point(ctx, params, period) {
			return groups(
				ctx,
				`SELECT status AS label, COUNT(*) AS v FROM agent_loop_runs
				  WHERE instance_id = ?1 AND user_id = ?2 AND started_at >= ?3 AND started_at < ?4
				  GROUP BY status ORDER BY v DESC LIMIT ?5`,
				limitOf(params),
				[period.startMs, period.endMs],
			);
		},
	},

	"pipeline.runs": {
		async point(ctx, params, period, kind) {
			if (kind === "number" || kind === "line") {
				return { type: "scalar", unit: unitFor("pipeline.runs"), value: await pipelineRuns(ctx, period) };
			}
			return groups(
				ctx,
				`SELECT status AS label, COUNT(*) AS v FROM pipeline_runs
				  WHERE instance_id = ?1 AND user_id = ?2 AND started_at >= ?3 AND started_at < ?4
				  GROUP BY status ORDER BY v DESC LIMIT ?5`,
				limitOf(params),
				[period.startMs, period.endMs],
			);
		},
		daily: (ctx, _p, period) => pipelineRuns(ctx, period),
	},

	"board.by_column": {
		point(ctx, params, period) {
			return groups(
				ctx,
				`SELECT status AS label, COUNT(*) AS v FROM instance_runtime_tasks
				  WHERE instance_id = ?1 AND user_id = ?2 AND updated_at >= ?3 AND updated_at < ?4
				  GROUP BY status ORDER BY v DESC LIMIT ?5`,
				limitOf(params),
				[period.startText, period.endText],
			);
		},
	},

	"events.by_type": {
		point(ctx, params, period) {
			return groups(
				ctx,
				`SELECT event AS label, COUNT(*) AS v FROM agent_events
				  WHERE instance_id = ?1 AND user_id = ?2 AND ts >= ?3 AND ts < ?4
				  GROUP BY event ORDER BY v DESC LIMIT ?5`,
				limitOf(params),
				[period.startMs, period.endMs],
			);
		},
	},

	"triggers.fires": {
		async point(ctx, params, period, kind) {
			if (kind === "number" || kind === "line") {
				return { type: "scalar", unit: unitFor("triggers.fires"), value: await triggerFires(ctx, period) };
			}
			return groups(
				ctx,
				`SELECT status AS label, COUNT(*) AS v FROM agent_trigger_events
				  WHERE instance_id = ?1 AND user_id = ?2 AND created_at >= ?3 AND created_at < ?4
				  GROUP BY status ORDER BY v DESC LIMIT ?5`,
				limitOf(params),
				[period.startText, period.endText],
			);
		},
		daily: (ctx, _p, period) => triggerFires(ctx, period),
	},

	"collection.count": {
		async point(ctx, params) {
			// Deliberately window-independent: a collection's size is a running total, not a count of
			// what happened in the last 30 days. The card's caveat says exactly that, because a
			// number that ignores the window selector while sitting next to ones that don't is
			// otherwise read as a bug.
			return { type: "scalar", unit: unitFor("collection.count"), value: await collectionCount(ctx, String(params.collection)) };
		},
		// The rollup runs just after midnight UTC, so the value it stores for a completed day is the
		// collection's size AT THE END of that day. That is the only history obtainable: records
		// carry a schema the agent defined, so there is no timestamp of ours to aggregate over.
		daily: (ctx, params) => collectionCount(ctx, String(params.collection)),
	},

	"collection.group_by": {
		async point(ctx, params) {
			const collection = String(params.collection);
			const field = String(params.field);
			const body = await doFetch<{ records?: CollectionRecord[]; total?: number }>(
				ctx,
				`/collections/${encodeURIComponent(collection)}/records?limit=${COLLECTION_SCAN_CAP}`,
			);
			const records = body?.records ?? [];
			const total = Number(body?.total ?? records.length);
			const counts = new Map<string, number>();
			for (const rec of records) {
				const raw = rec?.data?.[field];
				const label = raw === undefined || raw === null || raw === "" ? "(not set)" : String(raw).slice(0, 80);
				counts.set(label, (counts.get(label) ?? 0) + 1);
			}
			const rows = [...counts.entries()]
				.map(([label, value]) => ({ label, value }))
				.sort((a, b) => b.value - a.value)
				.slice(0, limitOf(params));
			return {
				type: "groups",
				rows,
				// `partial` is the honest half of the scan cap. Without it a 500-record sample of a
				// 5000-record collection renders as the whole picture.
				partial: total > records.length,
				scanned: records.length,
				total,
			};
		},
	},
};

async function usageTokens(ctx: StatsCtx, period: StatsPeriod): Promise<number> {
	return scalar(
		ctx,
		`SELECT COALESCE(SUM(input_tokens + output_tokens
		        + COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_tokens, 0)), 0) AS v
		   FROM ai_usage
		  WHERE instance_id = ?1 AND user_id = ?2 AND created_at >= ?3 AND created_at < ?4`,
		period.startText,
		period.endText,
	);
}

/**
 * List-price VALUE of this instance's AI, not a bill (#346).
 *
 * Unfiltered on purpose: this is a dashboard number answering "how much AI is my agent using",
 * and restricting it to charged rows would show $0.00 for a Coder whose engine runs on the
 * owner's Claude subscription — an agent that plainly did a great deal of work. The alias says
 * `value_micros` so nothing downstream can read it as money without renaming it first; the
 * source's own label and caveat (`stats-schema.ts`) say the same thing to the user.
 */
async function usageValue(ctx: StatsCtx, period: StatsPeriod): Promise<number> {
	return scalar(
		ctx,
		`SELECT COALESCE(SUM(cost_micros), 0) AS value_micros FROM ai_usage
		  WHERE instance_id = ?1 AND user_id = ?2 AND created_at >= ?3 AND created_at < ?4`,
		period.startText,
		period.endText,
	);
}

async function runsCount(ctx: StatsCtx, period: StatsPeriod): Promise<number> {
	return scalar(
		ctx,
		`SELECT COUNT(*) AS v FROM agent_loop_runs
		  WHERE instance_id = ?1 AND user_id = ?2 AND started_at >= ?3 AND started_at < ?4`,
		period.startMs,
		period.endMs,
	);
}

async function pipelineRuns(ctx: StatsCtx, period: StatsPeriod): Promise<number> {
	return scalar(
		ctx,
		`SELECT COUNT(*) AS v FROM pipeline_runs
		  WHERE instance_id = ?1 AND user_id = ?2 AND started_at >= ?3 AND started_at < ?4`,
		period.startMs,
		period.endMs,
	);
}

async function triggerFires(ctx: StatsCtx, period: StatsPeriod): Promise<number> {
	return scalar(
		ctx,
		`SELECT COUNT(*) AS v FROM agent_trigger_events
		  WHERE instance_id = ?1 AND user_id = ?2 AND created_at >= ?3 AND created_at < ?4`,
		period.startText,
		period.endText,
	);
}

/** Run one card's LIVE query. Trend (`line`) cards do not come through here — they read the
 *  rollup — and asking for one is a programming error, not a user-facing one. */
export async function readPointInTime(ctx: StatsCtx, card: StatsCard, period: StatsPeriod): Promise<StatsValue> {
	const exec = STATS_EXECUTORS[card.source];
	if (!exec) throw new Error(`No executor for stats source "${card.source}"`);
	return exec.point(ctx, card.params, period, card.kind);
}

/** One completed day's scalar for a trend card. Null when the source cannot produce one. */
export async function readDaily(ctx: StatsCtx, card: StatsCard, day: string): Promise<number | null> {
	const exec = STATS_EXECUTORS[card.source];
	if (!exec?.daily) return null;
	return exec.daily(ctx, card.params, dayPeriod(day));
}

/** Sources declared in the schema table but with no executor, and vice versa. Zero on both sides is
 *  asserted by a test — a descriptor with no query 500s at read time, and a query nothing can name
 *  is dead code that looks like a feature. */
export function statsSourceDrift(): { missingExecutor: string[]; orphanExecutor: string[]; missingDaily: string[] } {
	const declared = STATS_SOURCES.map((s) => s.id);
	return {
		missingExecutor: declared.filter((id) => !STATS_EXECUTORS[id]),
		orphanExecutor: Object.keys(STATS_EXECUTORS).filter((id) => !declared.includes(id)),
		missingDaily: STATS_SOURCES.filter((s) => s.kinds.includes("line") && !STATS_EXECUTORS[s.id]?.daily).map((s) => s.id),
	};
}
