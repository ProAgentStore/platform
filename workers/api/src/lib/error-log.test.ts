import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listErrors, logError } from "./error-log.js";
import type { Env } from "../types.js";

/**
 * The subject takes TWO probabilistic branches — `logError`'s 2% `DELETE FROM error_log` and,
 * through the trace mirror, `logEvent`'s 1% `DELETE FROM agent_events`. Pin the draw for the whole
 * file so no assertion in it rides on a coin toss (#446); the tests that deliberately exercise a
 * prune branch override this with their own `mockReturnValue(0)`, as they already did.
 *
 * Belt and braces, not the fix. The fix is that `collapsingDb` counts the INSERT rather than the
 * table name, so this file is deterministic at ANY value of `Math.random` — which is what the test
 * "does not count the opportunistic retention DELETE as a trace mirror" holds, by forcing 0.
 */
beforeEach(() => {
	vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
	vi.restoreAllMocks();
});

function mockDb(rows: unknown[] = []) {
	const inserts: { sql: string; args: unknown[] }[] = [];
	const queries: string[] = [];
	const db = {
		prepare(sql: string) {
			queries.push(sql);
			return {
				// Bind-less .run() (used by the retention DELETE).
				run: async () => ({}),
				bind(...args: unknown[]) {
					return {
						run: async () => { if (sql.startsWith("INSERT")) inserts.push({ sql, args }); return {}; },
						all: async () => ({ results: rows }),
						first: async () => rows[0] ?? null,
					};
				},
			};
		},
	};
	return { env: { DB: db } as unknown as Env, inserts, queries };
}

describe("logError", () => {
	it("persists source, status, message, and JSON context", async () => {
		const { env, inserts } = mockDb();
		await logError(env, { source: "keys-proxy", userId: "u1", status: 400, message: "boom", context: { host: "api.openai.com" } });
		// logError writes error_log AND bridges a mirror row into agent_events.
		const errRow = inserts.find((i) => i.sql.includes("error_log"));
		expect(errRow).toBeDefined();
		const [, userId, source, status, message, context] = errRow!.args;
		expect(userId).toBe("u1");
		expect(source).toBe("keys-proxy");
		expect(status).toBe(400);
		expect(message).toBe("boom");
		expect(JSON.parse(context as string)).toEqual({ host: "api.openai.com" });
	});

	it("never throws even if the DB blows up", async () => {
		const env = { DB: { prepare() { throw new Error("db down"); } } } as unknown as Env;
		await expect(logError(env, { source: "x", message: "y" })).resolves.toBeUndefined();
	});

	it("bounds oversized message and context", async () => {
		const { env, inserts } = mockDb();
		await logError(env, { source: "s", message: "m".repeat(5000), context: { big: "c".repeat(9000) } });
		expect((inserts[0].args[4] as string).length).toBe(2000);
		expect((inserts[0].args[5] as string).length).toBe(4000);
	});

	it("opportunistically prunes old rows (retention)", async () => {
		const { env, queries } = mockDb();
		const rnd = vi.spyOn(Math, "random").mockReturnValue(0); // force the 2% prune branch
		try {
			await logError(env, { source: "s", message: "m" });
		} finally {
			rnd.mockRestore();
		}
		expect(queries.some((q) => q.startsWith("DELETE FROM error_log") && q.includes("-30 days"))).toBe(true);
	});

	it("does NOT prune on the common path", async () => {
		const { env, queries } = mockDb();
		const rnd = vi.spyOn(Math, "random").mockReturnValue(0.5); // above the 0.02 threshold
		try {
			await logError(env, { source: "s", message: "m" });
		} finally {
			rnd.mockRestore();
		}
		expect(queries.some((q) => q.startsWith("DELETE FROM error_log"))).toBe(false);
	});
});

/**
 * A DB that actually implements the collapse: an UPDATE reports a change only when a matching row
 * is already there. A stub that always reported `changes: 0` (or always 1) would pass both a
 * working collapse and a broken one, which is how #423 shipped a query nobody had run.
 */
function collapsingDb() {
	interface Row { source: string; message: string; level: string; status: unknown; userId: unknown; repeats: number }
	const rows: Row[] = [];
	const mirrors: unknown[][] = [];
	const statements: string[] = [];
	const db = {
		prepare(sql: string) {
			statements.push(sql);
			const exec = (args: unknown[]) => {
				if (sql.startsWith("UPDATE error_log")) {
					const [source, message, level, status, userId] = args;
					const hit = rows.find(
						(r) => r.source === source && r.message === message && r.level === level && r.status === status && r.userId === userId,
					);
					if (!hit) return { meta: { changes: 0 } };
					hit.repeats++;
					return { meta: { changes: 1 } };
				}
				if (sql.includes("INSERT INTO error_log")) {
					const [, userId, source, status, message, , level] = args;
					rows.push({ source: source as string, message: message as string, level: level as string, status, userId, repeats: 1 });
				}
				// Deliberately the INSERT, not the table name (#446). `logEvent` also fires an
				// opportunistic `DELETE FROM agent_events` on ~1% of writes, and a predicate of
				// `sql.includes("agent_events")` counted that DELETE as a mirror — a 1-in-100
				// failure of the collapse test below, which read exactly like the CPU-starvation
				// flake `vitest.config.ts` warns about and is not it. The question this counter
				// asks is "did a trace row get WRITTEN", and the write is the INSERT. If a second
				// writer to this table ever appears, widen this on purpose, not by accident.
				if (sql.includes("INSERT INTO agent_events")) mirrors.push(args);
				return { meta: { changes: 1 } };
			};
			return { run: async () => exec([]), bind: (...args: unknown[]) => ({ run: async () => exec(args), all: async () => ({ results: [] }), first: async () => null }) };
		},
	};
	return { env: { DB: db } as unknown as Env, rows, mirrors, statements };
}

describe("logError — an identical repeat is counted, not re-inserted (#424)", () => {
	const same = { source: "unhandled", message: "D1_ERROR: too many terms in compound SELECT", status: 500 };

	it("60 identical failures produce ONE row carrying the count", async () => {
		// #423's exact shape: 1809 rows, ONE distinct message between them, 97% of the log — and a
		// search for anything else came back four rows. Bounded volume is what makes it safe to
		// start logging MORE (transient infra, diagnostic 4xx) rather than less.
		const { env, rows } = collapsingDb();
		for (let i = 0; i < 60; i++) await logError(env, same);
		expect(rows).toHaveLength(1);
		expect(rows[0].repeats).toBe(60);
	});

	it("does not mirror a collapsed repeat into the trace", async () => {
		// #423 flooded agent_events with 1811 error events for the same reason it flooded
		// error_log. Collapsing one and not the other would leave the trace unreadable.
		const { env, mirrors } = collapsingDb();
		for (let i = 0; i < 10; i++) await logError(env, same);
		expect(mirrors).toHaveLength(1);
	});

	it("does not count the opportunistic retention DELETE as a trace mirror", async () => {
		// #446, made deterministic. `logEvent` prunes `agent_events` on 1% of writes; the fixture
		// used to count that DELETE, so the assertion above read 2 on a 1-in-100 run. One Bernoulli
		// draw per full-suite run gives "fails once in a long run, green in isolation, green on
		// re-run" — the signature of CPU starvation, and not that at all.
		//
		// Forcing the draw is the whole point: at 0 BOTH retention branches fire, so this fails the
		// moment the predicate is widened back to the bare table name. Verified by doing exactly
		// that: "expected length 2 to be 1".
		vi.spyOn(Math, "random").mockReturnValue(0);
		const { env, mirrors, statements } = collapsingDb();
		for (let i = 0; i < 10; i++) await logError(env, same);
		expect(statements.some((s) => s.startsWith("DELETE FROM agent_events"))).toBe(true);
		expect(mirrors).toHaveLength(1);
	});

	it("keeps failures apart when ANY of source, message, status, user or level differs", async () => {
		// Collapse is on EXACT identity, deliberately — not on the normalized signature the
		// summary groups by. Merging "instance abc failed" with "instance def failed" at write
		// time would discard which instance, and no read can get it back.
		const { env, rows } = collapsingDb();
		await logError(env, same);
		await logError(env, { ...same, message: `${same.message} (2)` });
		await logError(env, { ...same, source: "chat" });
		await logError(env, { ...same, status: 502 });
		await logError(env, { ...same, userId: "u1" });
		await logError(env, { ...same, level: "warn" });
		expect(rows).toHaveLength(6);
	});

	it("looks back over a bounded window, so an ongoing failure still shows WHEN", async () => {
		const { env } = collapsingDb();
		let seen = "";
		const spy = { prepare: (sql: string) => { if (sql.startsWith("UPDATE error_log")) seen = sql; return (env as unknown as { DB: { prepare: (s: string) => unknown } }).DB.prepare(sql); } };
		await logError({ DB: spy } as unknown as Env, same);
		// Anchored on created_at, not on the last hit: a rolling window would fold a permanently
		// failing sweep into a single row updated forever, hiding when it started and whether it
		// is still going.
		expect(seen).toContain("created_at >= ?6");
		expect(seen).toContain("repeat_count = repeat_count + 1");
		expect(seen).toContain("last_seen_at = datetime('now')");
	});
});

describe("logError — level", () => {
	it("still records when the collapse query itself fails", async () => {
		// The one component whose job is to not be silent must not be silenced by its own
		// optimisation. A duplicate row is a trivially better outcome than no row.
		const inserts: string[] = [];
		const env = {
			DB: {
				prepare: (sql: string) => ({
					bind: () => ({
						run: async () => {
							if (sql.startsWith("UPDATE error_log")) throw new Error("no such column: level");
							inserts.push(sql);
							return { meta: { changes: 1 } };
						},
					}),
				}),
			},
		} as unknown as Env;
		await logError(env, { source: "s", message: "m" });
		expect(inserts.some((s) => s.includes("INSERT INTO error_log"))).toBe(true);
	});

	it("defaults to error and records warn when asked", async () => {
		const { env, inserts } = mockDb();
		await logError(env, { source: "s", message: "m" });
		await logError(env, { source: "s", message: "m", level: "warn" });
		expect(inserts.filter((i) => i.sql.includes("error_log")).map((i) => i.args[6])).toEqual(["error", "warn"]);
	});
});

describe("listErrors", () => {
	it("orders by the LAST occurrence, not the first", async () => {
		// A collapsed row keeps the created_at of the bucket it opened. Ordering by that sinks an
		// outage that is still happening below things that stopped hours ago.
		const { env, queries } = mockDb();
		await listErrors(env, { all: true });
		expect(queries[0]).toContain("ORDER BY COALESCE(last_seen_at, created_at) DESC");
		expect(queries[0]).toContain("repeat_count");
		expect(queries[0]).toContain("level");
	});

	it("filters by level so warns can be excluded from an error read", async () => {
		const { env, queries } = mockDb();
		await listErrors(env, { userId: "u1", level: "error" });
		expect(queries[0]).toContain("level = ?2");
	});

	it("scopes to the user by default", async () => {
		const { env, queries } = mockDb();
		await listErrors(env, { userId: "u1" });
		expect(queries[0]).toContain("WHERE user_id = ?1");
	});

	it("returns everyone's when all=true (no user filter)", async () => {
		const { env, queries } = mockDb();
		await listErrors(env, { all: true });
		expect(queries[0]).not.toContain("WHERE");
	});

	it("adds a source filter", async () => {
		const { env, queries } = mockDb();
		await listErrors(env, { userId: "u1", source: "auth" });
		expect(queries[0]).toContain("user_id = ?1");
		expect(queries[0]).toContain("source = ?2");
	});
});
