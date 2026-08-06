import { describe, expect, it } from "vitest";
import { STATS_SOURCES, type StatsCard } from "./stats-schema.js";
import { COLLECTION_SCAN_CAP } from "./stats-schema.js";
import { dayPeriod, readDaily, readPointInTime, statsPeriod, statsSourceDrift, STATS_EXECUTORS, type StatsCtx } from "./stats-sources.js";
import type { Env } from "../types.js";

/** A D1 stub that records the SQL and the bound values, so a test can prove the scoping is in the
 *  QUERY rather than filtered in JS afterwards. */
function fakeEnv(opts: { scalar?: number; rows?: Array<{ label: string | null; v: number }>; collections?: unknown; records?: unknown } = {}) {
	const calls: Array<{ sql: string; binds: unknown[] }> = [];
	const env = {
		DB: {
			prepare: (sql: string) => ({
				bind: (...binds: unknown[]) => {
					calls.push({ sql, binds });
					return {
						first: async () => ({ v: opts.scalar ?? 0 }),
						all: async () => ({ results: opts.rows ?? [] }),
						run: async () => ({ meta: { changes: 1 } }),
					};
				},
			}),
		},
		AGENT: {
			idFromName: (n: string) => n,
			get: () => ({
				fetch: async (req: Request) => {
					const path = new URL(req.url).pathname + new URL(req.url).search;
					const body = path.startsWith("/collections/") ? opts.records : opts.collections;
					return new Response(JSON.stringify(body ?? {}), { status: 200, headers: { "content-type": "application/json" } });
				},
			}),
		},
	} as unknown as Env;
	return { env, calls };
}

const ctx = (env: Env): StatsCtx => ({ env, instanceId: "inst-1", userId: "user-1" });

const card = (over: Partial<StatsCard>): StatsCard => ({ id: "c", title: "C", kind: "number", source: "runs.count", params: {}, ...over });

describe("statsSourceDrift", () => {
	it("has an executor for every declared source and no orphans", () => {
		// A descriptor with no query 500s the first time someone picks it; a query nothing can name
		// is dead code that looks like a feature. Both are build failures rather than surprises.
		expect(statsSourceDrift()).toEqual({ missingExecutor: [], orphanExecutor: [], missingDaily: [] });
	});

	it("gives every source that declares `line` a way to compute one day", () => {
		// A source can never advertise a trend it has no means of snapshotting — a `line` card whose
		// source cannot produce a daily scalar would render a permanently empty chart with no error.
		for (const s of STATS_SOURCES) {
			if (s.kinds.includes("line")) expect(typeof STATS_EXECUTORS[s.id]?.daily).toBe("function");
		}
	});
});

describe("owner scoping", () => {
	it("binds instance AND user on every D1-backed source, in the query", () => {
		// This is the sentence that makes agent-authored stats safe: the card supplies WHICH VIEW,
		// never WHOSE DATA. If a source ever filters in JS instead, this fails.
		const dbSources = STATS_SOURCES.filter((s) => !s.id.startsWith("collection."));
		return Promise.all(
			dbSources.map(async (s) => {
				const { env, calls } = fakeEnv({ rows: [] });
				const kind = s.kinds.includes("number") ? "number" : "bar";
				await readPointInTime(ctx(env), card({ source: s.id, kind, params: { limit: 5 } }), statsPeriod("2026-08-06", 7));
				expect(calls, s.id).toHaveLength(1);
				expect(calls[0].sql, s.id).toContain("instance_id = ?1");
				expect(calls[0].sql, s.id).toContain("user_id = ?2");
				expect(calls[0].binds.slice(0, 2), s.id).toEqual(["inst-1", "user-1"]);
			}),
		);
	});

	it("never interpolates a card param into SQL text", () => {
		// The params here are already regex-validated, but the invariant that matters is that they
		// travel as BOUND VALUES. A source that built a `GROUP BY ${field}` would pass every schema
		// test and still be an injection.
		const { env, calls } = fakeEnv({ rows: [] });
		return readPointInTime(ctx(env), card({ source: "events.by_type", kind: "bar", params: { limit: 7 } }), statsPeriod("2026-08-06", 7)).then(() => {
			expect(calls[0].sql).not.toContain("7");
			expect(calls[0].binds).toContain(7);
		});
	});
});

describe("period boundaries", () => {
	it("only ever produces midnight-aligned text bounds", () => {
		// The tables mix `datetime('now')` text, ISO text and ms epochs. A range compare is
		// format-agnostic ONLY at a day boundary — `'T'` and `' '` both sort after the date prefix
		// and before the next day's. A bound at any other time of day would silently mis-include
		// ISO rows, so this asserts the shape rather than a particular value.
		for (const p of [statsPeriod("2026-08-06", 7), statsPeriod("2026-01-01", 90), dayPeriod("2026-12-31")]) {
			expect(p.startText).toMatch(/^\d{4}-\d{2}-\d{2} 00:00:00$/);
			expect(p.endText).toMatch(/^\d{4}-\d{2}-\d{2} 00:00:00$/);
		}
	});

	it("covers exactly N whole days, ending after the through-day", () => {
		const p = statsPeriod("2026-08-06", 7);
		expect(p.startText).toBe("2026-07-31 00:00:00");
		expect(p.endText).toBe("2026-08-07 00:00:00"); // exclusive — the day after the through-day
		expect(p.endMs - p.startMs).toBe(7 * 86_400_000);
	});

	it("a single-day period is one day wide", () => {
		const p = dayPeriod("2026-08-06");
		expect(p.startText).toBe("2026-08-06 00:00:00");
		expect(p.endMs - p.startMs).toBe(86_400_000);
	});
});

describe("collection sources (Durable Object, not D1)", () => {
	it("reads a count from the schema's maintained recordCount, not by scanning records", () => {
		const { env, calls } = fakeEnv({ collections: { collections: [{ name: "leads", recordCount: 116 }] } });
		return readDaily(ctx(env), card({ source: "collection.count", kind: "line", params: { collection: "leads" } }), "2026-08-06").then((v) => {
			expect(v).toBe(116);
			expect(calls).toHaveLength(0); // no D1 involved at all
		});
	});

	it("returns 0 for a collection that does not exist rather than throwing the card away", () => {
		const { env } = fakeEnv({ collections: { collections: [] } });
		return readDaily(ctx(env), card({ source: "collection.count", kind: "line", params: { collection: "gone" } }), "2026-08-06").then((v) => expect(v).toBe(0));
	});

	it("groups by a field and marks the answer PARTIAL when the scan cap bit", () => {
		// A 500-record sample of a 5000-record collection presented as the whole breakdown is the
		// confident-wrong-number failure. `partial` is how the surface knows to say so.
		const records = Array.from({ length: 3 }, (_, i) => ({ id: `r${i}`, data: { suburb: i === 2 ? "Bondi" : "Newtown" } }));
		const { env } = fakeEnv({ records: { records, total: 5000 } });
		return readPointInTime(ctx(env), card({ source: "collection.group_by", kind: "bar", params: { collection: "leads", field: "suburb", limit: 10 } }), dayPeriod("2026-08-06")).then((v) => {
			expect(v).toEqual({
				type: "groups",
				rows: [
					{ label: "Newtown", value: 2 },
					{ label: "Bondi", value: 1 },
				],
				partial: true,
				scanned: 3,
				total: 5000,
			});
		});
	});

	it("does not claim partial when the whole collection was scanned", () => {
		const { env } = fakeEnv({ records: { records: [{ id: "r", data: { suburb: "Bondi" } }], total: 1 } });
		return readPointInTime(ctx(env), card({ source: "collection.group_by", kind: "bar", params: { collection: "leads", field: "suburb" } }), dayPeriod("2026-08-06")).then((v) => {
			expect(v).toMatchObject({ partial: false, total: 1 });
		});
	});

	it("groups a missing field as (not set) rather than dropping the record", () => {
		// Dropping them would make the group totals silently disagree with the collection size, and
		// "how many leads have no suburb" is usually the interesting answer.
		const { env } = fakeEnv({ records: { records: [{ id: "a", data: {} }, { id: "b", data: { suburb: "" } }], total: 2 } });
		return readPointInTime(ctx(env), card({ source: "collection.group_by", kind: "bar", params: { collection: "leads", field: "suburb" } }), dayPeriod("2026-08-06")).then((v) => {
			expect(v).toMatchObject({ rows: [{ label: "(not set)", value: 2 }] });
		});
	});

	it("asks the DO for no more than the scan cap", () => {
		let asked = "";
		const { env } = fakeEnv({ records: { records: [], total: 0 } });
		(env as unknown as { AGENT: { get: () => { fetch: (r: Request) => Promise<Response> } } }).AGENT.get = () => ({
			fetch: async (r: Request) => {
				asked = new URL(r.url).search;
				return new Response(JSON.stringify({ records: [], total: 0 }));
			},
		});
		return readPointInTime(ctx(env), card({ source: "collection.group_by", kind: "bar", params: { collection: "leads", field: "suburb" } }), dayPeriod("2026-08-06")).then(() => {
			expect(asked).toBe(`?limit=${COLLECTION_SCAN_CAP}`);
		});
	});
});

describe("readDaily", () => {
	it("returns null for a source with no daily executor rather than inventing a zero", () => {
		// A zero here would be written into the rollup and rendered as a real day with no activity.
		// Null means "cannot be snapshotted", and the sweep skips it.
		const { env } = fakeEnv();
		return readDaily(ctx(env), card({ source: "runs.outcome", kind: "bar" }), "2026-08-06").then((v) => expect(v).toBeNull());
	});
});
