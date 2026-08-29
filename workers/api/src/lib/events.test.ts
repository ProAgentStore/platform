import { describe, expect, it, vi } from "vitest";
import { EVENT_LEVELS, listEvents, logEvent } from "./events.js";
import type { Env } from "../types.js";

function mockDb(rows: unknown[] = []) {
	const inserts: { sql: string; args: unknown[] }[] = [];
	const queries: { sql: string; args: unknown[] }[] = [];
	const db = {
		prepare(sql: string) {
			return {
				run: async () => ({}), // bind-less .run() (retention DELETE)
				bind(...args: unknown[]) {
					queries.push({ sql, args });
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

describe("logEvent", () => {
	it("persists source, level, event, message, ids, and JSON context", async () => {
		const { env, inserts } = mockDb();
		await logEvent(env, {
			source: "apply", event: "apply.step", level: "info", message: "nav",
			userId: "u1", instanceId: "i1", traceId: "task_9", ts: 1000,
			context: { url: "https://x" },
		});
		expect(inserts).toHaveLength(1);
		const [, ts, userId, instanceId, traceId, source, level, event, message, context] = inserts[0].args;
		expect(ts).toBe(1000);
		expect(userId).toBe("u1");
		expect(instanceId).toBe("i1");
		expect(traceId).toBe("task_9");
		expect(source).toBe("apply");
		expect(level).toBe("info");
		expect(event).toBe("apply.step");
		expect(message).toBe("nav");
		expect(JSON.parse(context as string)).toEqual({ url: "https://x" });
	});

	it("defaults level to info and nulls the optional scoping columns", async () => {
		const { env, inserts } = mockDb();
		await logEvent(env, { source: "chat", event: "chat.in", ts: 1 });
		const [, , userId, instanceId, traceId, , level] = inserts[0].args;
		expect(level).toBe("info");
		expect(userId).toBeNull();
		expect(instanceId).toBeNull();
		expect(traceId).toBeNull();
	});

	it("bounds oversized message and context", async () => {
		const { env, inserts } = mockDb();
		await logEvent(env, { source: "s", event: "e", message: "m".repeat(5000), context: { big: "c".repeat(9000) }, ts: 1 });
		expect((inserts[0].args[8] as string).length).toBe(2000);
		expect((inserts[0].args[9] as string).length).toBe(4000);
	});

	it("uses a supplied id and an OR IGNORE insert, so a re-report is a no-op (#294)", async () => {
		// Consequential acts are drained from a runner and can be written by a console poll and a
		// Pilot capture racing each other. Two rows saying "merged a pull request" read as two
		// merges, so the id has to be the caller's and the insert has to tolerate the conflict.
		const { env, inserts } = mockDb();
		await logEvent(env, { id: "act:s1:toolu_1:0", source: "coding", event: "act.consequential", ts: 1 });
		expect(inserts[0].args[0]).toBe("act:s1:toolu_1:0");
		expect(inserts[0].sql).toContain("ON CONFLICT(id) DO NOTHING");
		// Spelled this way rather than `INSERT OR IGNORE` so the literal `INSERT INTO agent_events`
		// prefix survives — several test doubles in this repo recognise a trace write by it.
		expect(inserts[0].sql).toContain("INSERT INTO agent_events");
	});

	it("still mints a uuid when no id is given", async () => {
		// Every existing caller logs a fact that happens once, at the moment it is logged; a random
		// key never collides, so OR IGNORE changes nothing for them.
		const { env, inserts } = mockDb();
		await logEvent(env, { source: "chat", event: "chat.in", ts: 1 });
		expect(inserts[0].args[0]).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("never throws even if the DB blows up", async () => {
		// Spy so the `[events] failed to persist: …` line is captured as a positive assertion
		// rather than printed as noise — the same technique on-error.test.ts uses. The behaviour
		// under test is unchanged: logEvent must not throw; it must report via console.error.
		const errors: unknown[][] = [];
		const spy = vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a); });
		try {
			const env = { DB: { prepare() { throw new Error("db down"); } } } as unknown as Env;
			await expect(logEvent(env, { source: "x", event: "y" })).resolves.toBeUndefined();
			expect(errors.some((a) => String(a[0]).includes("[events] failed to persist"))).toBe(true);
		} finally {
			spy.mockRestore();
		}
	});

	it("opportunistically prunes old rows (retention)", async () => {
		const { env, queries } = mockDb();
		const rnd = vi.spyOn(Math, "random").mockReturnValue(0); // force the 1% prune branch
		try {
			await logEvent(env, { source: "s", event: "e", ts: 1 });
		} finally {
			rnd.mockRestore();
		}
		// The retention DELETE uses a bind-less run(), so it isn't captured in `queries`
		// (which only records bound calls). Assert the insert still landed and no throw.
		expect(queries.some((q) => q.sql.startsWith("INSERT"))).toBe(true);
	});
});

describe("listEvents", () => {
	it("always scopes to user + instance and returns chronological order", async () => {
		// SQL orders ts DESC; listEvents reverses to oldest→newest.
		const { env, queries } = mockDb([{ ts: 3 }, { ts: 2 }, { ts: 1 }]);
		const out = await listEvents(env, { userId: "u1", instanceId: "i1" });
		expect(queries[0].sql).toContain("user_id = ?1");
		expect(queries[0].sql).toContain("instance_id = ?2");
		expect(queries[0].sql).toContain("ORDER BY ts DESC");
		expect(out.map((r) => (r as { ts: number }).ts)).toEqual([1, 2, 3]);
	});

	it("adds trace_id / source / level filters when given", async () => {
		const { env, queries } = mockDb();
		await listEvents(env, { userId: "u1", instanceId: "i1", traceId: "t9", source: "apply", level: "error" });
		const { sql, args } = queries[0];
		expect(sql).toContain("trace_id = ?3");
		expect(sql).toContain("source = ?4");
		// `error` is the top of the ladder, so its floor is a one-element IN — the case where the
		// old equality and the floor agree, and the reason #564's disagreement went unnoticed.
		expect(sql).toContain("level IN (?5)");
		expect(args).toEqual(["u1", "i1", "t9", "apply", "error"]);
	});
});

/**
 * #564 — `level` is documented as a floor ("minimum-interest filter", on both `GET /trace?level=`
 * and the MCP `agent_trace` tool) and was implemented as `level = ?`, so asking for `warn` HID
 * every error. `error` happened to be correct either way, which is why the only read anyone made
 * was the one where the two agree.
 *
 * ── ADR 0002 (a guard states the size of what it measured)
 *
 * This drives EVERY band in the ladder, not the pair that happens to show the bug, and asserts the
 * ladder's own size first (G1): a guard that iterated an empty or one-element `EVENT_LEVELS` would
 * pass against the equality filter it exists to forbid. The denominator — bands examined, and the
 * total number of (band, included-level) pairs proven — is asserted and printed (G2).
 *
 * G4, run 2026-08-15: restoring `where.push(\`level = ?${binds.length}\`)` turns
 * "every band includes itself and everything above it" RED at the first band —
 * `expected [ 'debug' ] to deeply equal [ 'debug', 'info', 'warn', 'error' ]`.
 */
describe("listEvents — `level` is a floor, not an equality (#564)", () => {
	it("the ladder it iterates is the whole ladder", () => {
		// G1. Ordered least→most interesting; the order is what the floor means.
		expect(EVENT_LEVELS).toEqual(["debug", "info", "warn", "error"]);
		expect(EVENT_LEVELS.length).toBeGreaterThan(1);
	});

	it("every band includes itself and everything above it", async () => {
		let pairs = 0;
		for (const [i, level] of EVENT_LEVELS.entries()) {
			const { env, queries } = mockDb();
			await listEvents(env, { userId: "u1", instanceId: "i1", level });
			const bound = queries[0].args.slice(2);
			const expected = EVENT_LEVELS.slice(i);
			// The whole point: asking for `warn` must not drop `error`.
			expect(bound).toEqual([...expected]);
			expect(queries[0].sql).toContain(`level IN (${expected.map((_, n) => `?${n + 3}`).join(", ")})`);
			// …and must not smuggle in the bands BELOW it, which would make the filter a no-op.
			for (const below of EVENT_LEVELS.slice(0, i)) expect(bound).not.toContain(below);
			pairs += expected.length;
		}
		// G2 — 4 bands, 4+3+2+1 = 10 (band, included-level) pairs proven.
		expect(pairs).toBe((EVENT_LEVELS.length * (EVENT_LEVELS.length + 1)) / 2);
		console.log(`✓ listEvents level floor: ${EVENT_LEVELS.length} bands, ${pairs} band/level inclusions asserted`);
	});

	it("matches an unrecognised level exactly rather than returning everything", async () => {
		// A filter nobody can parse must return nothing, never the whole trace. Reachable through
		// `logEvent`, which writes whatever `level` it is handed with no enum check at the DB.
		const { env, queries } = mockDb();
		await listEvents(env, { userId: "u1", instanceId: "i1", level: "critical" as never });
		expect(queries[0].sql).toContain("level IN (?3)");
		expect(queries[0].args).toEqual(["u1", "i1", "critical"]);
	});

	it("omits the level clause entirely when no level is asked for", async () => {
		const { env, queries } = mockDb();
		await listEvents(env, { userId: "u1", instanceId: "i1" });
		// Not `not.toContain("level")` — the SELECT list names the column. It is the WHERE clause
		// that must be absent.
		expect(queries[0].sql).not.toContain("level IN");
		expect(queries[0].sql).not.toContain("level =");
		expect(queries[0].args).toEqual(["u1", "i1"]);
	});
});
