import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1 } from "./d1-sqlite.js";
import { deriveClientLevel, listErrors, logError, OBSERVATION_SOURCES, resetServerBuildForTests, sanitizeBuildId, setServerBuild, type ErrorRow } from "./error-log.js";
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
	resetServerBuildForTests();
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
		// Spy so the `[error-log] failed to persist: …` line is captured as a positive assertion
		// rather than printed as noise — the same technique on-error.test.ts uses.
		const errors: unknown[][] = [];
		const spy = vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a); });
		try {
			const env = { DB: { prepare() { throw new Error("db down"); } } } as unknown as Env;
			await expect(logError(env, { source: "x", message: "y" })).resolves.toBeUndefined();
			expect(errors.some((a) => String(a[0]).includes("[error-log] failed to persist"))).toBe(true);
		} finally {
			spy.mockRestore();
		}
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

	it("mirrors an explicit context.traceId, not only the apply workflows' taskId (#529)", async () => {
		// The bridge read `taskId` and nothing else, so a caller whose correlation key has another
		// name — a coding run's loop-run id, a pipeline's run id — mirrored with a NULL `trace_id`.
		// The row was in the timeline and invisible to `?trace_id=<run>`, the query an investigator
		// actually makes. `taskId` still works, and still wins over nothing.
		const { env, mirrors } = collapsingDb();
		await logError(env, { source: "coding:session", message: "run died", context: { traceId: "run_9", taskId: "card_1" } });
		await logError(env, { source: "job-apply", message: "apply crashed", context: { taskId: "card_1" } });
		// (id, ts, user_id, instance_id, trace_id, …)
		expect(mirrors.map((m) => m[4])).toEqual(["run_9", "card_1"]);
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

/**
 * #571 — the client channel carries no level, and deriving one from the status alone put "the noise
 * gate worked" at the same severity as "your credit balance is too low".
 *
 * ## These go RED on the old code
 *
 * The route used to compute the level inline:
 *
 *     level: status !== undefined && status >= 400 && status < 500 ? "warn" : "error",
 *
 * `deriveClientLevel` did not exist, so this block does not compile against it — and restoring that
 * expression in place of the call makes the two observation-source cases below fail with
 * `expected 'error' to be 'warn'`, which is exactly the production row this ticket was filed about.
 */
describe("deriveClientLevel — a statusless OBSERVATION is not a bug (#571)", () => {
	it("files a statusless report from an observation source at warn, and from a failure source at error", () => {
		// The acceptance criterion, in one line: same absence of a status, two different levels,
		// decided by what the server has declared the source to mean.
		expect(deriveClientLevel("client:voice-decision")).toBe("warn");
		expect(deriveClientLevel("client:voice")).toBe("error");
	});

	it("keeps every other statusless client report an error", () => {
		// The distrust argument is unchanged: a name the server has not declared buys nothing.
		for (const source of ["client:app", "client:voice-tts", "client:voice-gate", "client:voice-control", "client:auth", "keys-proxy"]) {
			expect(deriveClientLevel(source), source).toBe("error");
		}
	});

	it("still reads a 4xx as a diagnostic wall and anything else as a failure", () => {
		expect(deriveClientLevel("client:app", 402)).toBe("warn");
		expect(deriveClientLevel("client:app", 429)).toBe("warn");
		expect(deriveClientLevel("client:app", 500)).toBe("error");
		expect(deriveClientLevel("client:app", 0)).toBe("error");
	});

	it("lets a MEASURED status outrank the source name, in both directions", () => {
		// A status is a measurement, a source is a claim. An observation source that somehow carries a
		// 5xx is reporting a real failure and must not be downgraded by its own label — which is the
		// property that keeps a source allowlist from becoming the mirror of the bug it fixes.
		expect(deriveClientLevel("client:voice-decision", 500)).toBe("error");
		expect(deriveClientLevel("client:voice-decision", 403)).toBe("warn");
	});

	it("declares the observation sources explicitly, and only those", () => {
		// ADR 0002 G1 — assert the set, not an example. A source added here changes what `?level=error`
		// returns for every account, so it is a decision someone signs rather than a quiet append.
		expect([...OBSERVATION_SOURCES]).toEqual(["client:voice-decision"]);
	});

	it("routes the report through the same derivation the route uses", async () => {
		// The policy is only worth testing if the write path actually consults it.
		const { env, inserts } = mockDb();
		await logError(env, { source: "client:voice-decision", message: "gate discard", level: deriveClientLevel("client:voice-decision") });
		expect(inserts.find((i) => i.sql.includes("error_log"))?.args[6]).toBe("warn");
	});

	it("reduces nothing — the row still carries its full context", async () => {
		// #511/#535/#538 all reason from this telemetry. The severity changes; the evidence does not.
		const { env, inserts } = mockDb();
		const context = { transcript: "Thank you for watching.", peakLevel: 0.02, frames: 900, gateSawWords: false };
		await logError(env, { source: "client:voice-decision", message: "voice turn rejected as noise", level: "warn", context });
		const row = inserts.find((i) => i.sql.includes("error_log"))!;
		expect(JSON.parse(row.args[5] as string)).toEqual(context);
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

/**
 * The collapse, run against the REAL schema (#538).
 *
 * The stubs above answer "what SQL was issued". That is exactly the question this bug hid behind:
 * the UPDATE was issued, it did change a row, and it still discarded ten of eleven measurements.
 * The only assertion that could have caught it reads the surviving ROW back, so these execute the
 * statements against the schema `workers/api/migrations` actually builds.
 */
describe("logError — a collapsed row keeps the first AND the latest sample (#538)", () => {
	/** The row measured in production on 2026-08-12: 11 occurrences, one `frames` reading. */
	const voice = {
		source: "client:voice",
		message: "voice turn discarded at end-of-turn — the live gate heard no words",
		userId: "u1",
	};
	const rowsOf = (d1: ReturnType<typeof realSchemaD1>) =>
		d1.sqlite.prepare("SELECT * FROM error_log").all() as unknown as ErrorRow[];

	it("11 occurrences with drifting measurements keep BOTH ends, not 11 copies of the first", async () => {
		const d1 = realSchemaD1();
		try {
			const env = { DB: d1.DB } as unknown as Env;
			for (let i = 0; i < 11; i++) {
				await logError(env, { ...voice, context: { peakLevel: 0.664 - i / 100, frames: 244 + i, gateAlive: true } });
			}
			const rows = rowsOf(d1);
			// Still ONE row: the burst protection #423 bought is untouched.
			expect(rows).toHaveLength(1);
			expect(rows[0].repeat_count).toBe(11);
			// `context` is the occurrence that opened the bucket…
			expect(JSON.parse(rows[0].context!)).toMatchObject({ peakLevel: 0.664, frames: 244 });
			// …and the eleventh-and-last is no longer invisible.
			const latest = JSON.parse(rows[0].last_context!) as { peakLevel: number; frames: number };
			expect(latest.frames).toBe(254);
			expect(latest.peakLevel).toBeCloseTo(0.564, 10);
			// The point of the issue, stated as an assertion: whatever survived is not silently
			// the first sample wearing the latest timestamp.
			expect(rows[0].last_context).not.toBe(rows[0].context);
		} finally {
			d1.close();
		}
	});

	it("a row standing for ONE occurrence has no last_context, so a reader can tell the two apart", async () => {
		// Criterion 2: a reader must never mistake a stale sample for the latest. `last_context IS
		// NULL` is the row saying "there has only been one, and `context` is it".
		const d1 = realSchemaD1();
		try {
			await logError({ DB: d1.DB } as unknown as Env, { ...voice, context: { peakLevel: 0.4 } });
			const rows = rowsOf(d1);
			expect(rows).toHaveLength(1);
			expect(rows[0].repeat_count).toBe(1);
			expect(rows[0].last_context).toBeNull();
		} finally {
			d1.close();
		}
	});

	it("a newer build's fields reach the row even when it folds into an older one", async () => {
		// #538 criterion 3, for the rows that CAN still fold — a server-side source carries no
		// build, so #539's identity split does not apply to it. `gateSawWords` was added by #535
		// hours after the rows it needed to appear on already existed; under the old UPDATE it
		// would have read as "the field was never deployed".
		const d1 = realSchemaD1();
		try {
			const env = { DB: d1.DB } as unknown as Env;
			await logError(env, { source: "coding:session", message: "run died", context: { gateAlive: true } });
			await logError(env, { source: "coding:session", message: "run died", context: { gateAlive: true, gateSawWords: true } });
			const rows = rowsOf(d1);
			expect(rows).toHaveLength(1);
			expect(rows[0].context).not.toContain("gateSawWords");
			expect(JSON.parse(rows[0].last_context!)).toMatchObject({ gateSawWords: true });
		} finally {
			d1.close();
		}
	});

	it("listErrors returns the latest sample alongside the first", async () => {
		// The column is worthless if the reader every consumer goes through (GET /v1/errors, MCP
		// list_errors, the admin feed) does not select it.
		const d1 = realSchemaD1();
		try {
			const env = { DB: d1.DB } as unknown as Env;
			await logError(env, { ...voice, context: { peakLevel: 0.1 } });
			await logError(env, { ...voice, context: { peakLevel: 0.9 } });
			const [row] = await listErrors(env, { userId: "u1" });
			expect(JSON.parse(row.context!)).toEqual({ peakLevel: 0.1 });
			expect(JSON.parse(row.last_context!)).toEqual({ peakLevel: 0.9 });
		} finally {
			d1.close();
		}
	});
});

/**
 * The build id, in the row and in the collapse identity (#539).
 *
 * Criterion 2 of the issue names this as the part that must not be skipped: a build living only in
 * `context` is dropped the moment a post-fix occurrence folds into a pre-fix bucket, which is
 * precisely the row a reader is interrogating when they ask whether a deploy landed.
 */
describe("logError — two builds never share a row (#539)", () => {
	const voice = { source: "client:voice", message: "voice turn discarded at end-of-turn", userId: "u1" };
	const rowsOf = (d1: ReturnType<typeof realSchemaD1>) =>
		d1.sqlite.prepare("SELECT * FROM error_log ORDER BY build").all() as unknown as ErrorRow[];

	it("the same failure from a pre-fix and a post-fix bundle produces TWO rows", async () => {
		// The 2026-08-12 shape: the tab kept reporting after the fix deployed. One bucket would have
		// read as "the fix did not work"; two rows say "one bundle stopped and another did not".
		const d1 = realSchemaD1();
		try {
			const env = { DB: d1.DB } as unknown as Env;
			await logError(env, { ...voice, build: "9fb7cd6ab123" });
			await logError(env, { ...voice, build: "9fb7cd6ab123" });
			await logError(env, { ...voice, build: "a1fe58bcd456" });
			const rows = rowsOf(d1);
			expect(rows.map((r) => [r.build, r.repeat_count])).toEqual([
				["9fb7cd6ab123", 2],
				["a1fe58bcd456", 1],
			]);
		} finally {
			d1.close();
		}
	});

	it("a build-carrying occurrence does not fold into a row that has none", async () => {
		// The migration boundary itself: rows written before #539 have `build IS NULL`, and a
		// browser that has since reloaded reports one. `build IS ?8` is what keeps `IS NULL` from
		// silently matching every new occurrence for the rest of the hour.
		const d1 = realSchemaD1();
		try {
			const env = { DB: d1.DB } as unknown as Env;
			await logError(env, voice);
			await logError(env, { ...voice, build: "a1fe58bcd456" });
			// `ORDER BY build` sorts NULL first in SQLite — the pre-#539 row, then the reloaded tab's.
			expect(rowsOf(d1).map((r) => r.build)).toEqual([null, "a1fe58bcd456"]);
		} finally {
			d1.close();
		}
	});

	it("keeps collapsing repeats from ONE build, so the flood protection survives", async () => {
		// The whole risk of widening a collapse key is that it stops collapsing. A build is constant
		// for a tab, so 40 occurrences from one bundle are still one row.
		const d1 = realSchemaD1();
		try {
			const env = { DB: d1.DB } as unknown as Env;
			for (let i = 0; i < 40; i++) await logError(env, { ...voice, build: "dev" });
			const rows = rowsOf(d1);
			expect(rows).toHaveLength(1);
			expect(rows[0].repeat_count).toBe(40);
		} finally {
			d1.close();
		}
	});

	it("listErrors returns the build, so it is readable without decoding context", async () => {
		// Criterion 3. `list_errors` (MCP) and the admin feed both read through these columns.
		const d1 = realSchemaD1();
		try {
			const env = { DB: d1.DB } as unknown as Env;
			await logError(env, { ...voice, build: "a1fe58bcd456" });
			const [row] = await listErrors(env, { userId: "u1" });
			expect(row.build).toBe("a1fe58bcd456");
			// And it is NOT smuggled into context, where #538's collapse would have eaten it.
			expect(row.context).toBeNull();
		} finally {
			d1.close();
		}
	});
});

describe("sanitizeBuildId", () => {
	it("keeps a sha, a dev marker and an unset marker", () => {
		expect(sanitizeBuildId("a1fe58bcd456")).toBe("a1fe58bcd456");
		expect(sanitizeBuildId("dev")).toBe("dev");
		expect(sanitizeBuildId("unset")).toBe("unset");
		expect(sanitizeBuildId("v1.2.3-rc.1")).toBe("v1.2.3-rc.1");
	});

	it("drops anything that is not a build id", () => {
		// The value arrives on an UNAUTHENTICATED POST and lands in a WHERE clause. The risk is not
		// injection (the statement is parameterized) — it is that a caller who can write arbitrary
		// bytes into the collapse key can make every occurrence unique and reinstate #423's flood.
		expect(sanitizeBuildId(undefined)).toBeUndefined();
		expect(sanitizeBuildId(null)).toBeUndefined();
		expect(sanitizeBuildId(42)).toBeUndefined();
		expect(sanitizeBuildId("   ")).toBeUndefined();
		expect(sanitizeBuildId("' OR 1=1 --")).toBe("OR11--");
		expect(sanitizeBuildId("x".repeat(200))).toHaveLength(64);
	});
});

/**
 * #735 — server-side `logError` rows were always `build: null` because no call site passes
 * `e.build` and the Worker had no build id to stamp. `setServerBuild` / `_serverBuild` is
 * the fix: the isolate's build is set once from `env.API_BUILD` in `index.ts` and is used as
 * the fallback whenever `e.build` is absent.
 *
 * ## These go RED on the old code
 *
 * `logError` used to compute `const build = sanitizeBuildId(e.build) ?? null;`. The tests
 * below call `setServerBuild` and then expect the row's build column to be non-null even when
 * no `e.build` is supplied. The old code returns `null` in that case.
 */
describe("logError — server rows carry the isolate build when no e.build is supplied (#735)", () => {
	it("a server-side call without e.build gets the module-level build stamped on the row", async () => {
		// The acceptance criterion from the issue: server rows should never be `build: null` after
		// this fix. `setServerBuild` simulates what `index.ts` does on the first request.
		const d1 = realSchemaD1();
		try {
			setServerBuild("abc123def456");
			const env = { DB: d1.DB } as unknown as Env;
			await logError(env, { source: "coding:session", message: "run failed" });
			const rows = d1.sqlite.prepare("SELECT build FROM error_log").all() as { build: string | null }[];
			expect(rows).toHaveLength(1);
			expect(rows[0].build).toBe("abc123def456");
		} finally {
			d1.close();
		}
	});

	it("an explicit e.build takes precedence over the module-level build", async () => {
		// Client rows supply their own bundle SHA; the module-level build must not override it.
		const d1 = realSchemaD1();
		try {
			setServerBuild("server-build");
			const env = { DB: d1.DB } as unknown as Env;
			await logError(env, { source: "client:app", message: "error", build: "client-build" });
			const rows = d1.sqlite.prepare("SELECT build FROM error_log").all() as { build: string | null }[];
			expect(rows[0].build).toBe("client-build");
		} finally {
			d1.close();
		}
	});

	it("when no build is set at all the row is null, preserving pre-#735 semantics for tests", async () => {
		// `resetServerBuildForTests` (called in afterEach) clears the module-level build, so a test
		// that never calls `setServerBuild` sees `null` — the same state as before #735 landed.
		// This keeps the pre-existing #539 tests (which write without a build) deterministic.
		const d1 = realSchemaD1();
		try {
			const env = { DB: d1.DB } as unknown as Env;
			await logError(env, { source: "server-source", message: "no build set" });
			const rows = d1.sqlite.prepare("SELECT build FROM error_log").all() as { build: string | null }[];
			expect(rows[0].build).toBeNull();
		} finally {
			d1.close();
		}
	});

	it("the module-level build is part of the collapse identity, so two builds do not share a server row", async () => {
		// The same guarantee #539 gave client rows: a post-fix server occurrence does not fold
		// into a pre-fix bucket. This test exercises both builds against the real schema.
		const d1 = realSchemaD1();
		try {
			const env = { DB: d1.DB } as unknown as Env;
			const failure = { source: "unhandled", message: "D1_ERROR: compound SELECT" };
			setServerBuild("build-before-fix");
			await logError(env, failure);
			await logError(env, failure);
			setServerBuild("build-after-fix");
			await logError(env, failure);
			const rows = d1.sqlite
				.prepare("SELECT build, repeat_count FROM error_log ORDER BY build")
				.all() as { build: string; repeat_count: number }[];
			// Two distinct builds → two rows. The pre-fix row has the count; the post-fix row
			// proves the fix is still happening (or not), separately.
			expect(rows.map((r) => [r.build, r.repeat_count])).toEqual([
				["build-after-fix", 1],
				["build-before-fix", 2],
			]);
		} finally {
			d1.close();
		}
	});
});
