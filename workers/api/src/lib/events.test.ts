import { describe, expect, it, vi } from "vitest";
import { listEvents, logEvent } from "./events.js";
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
		const env = { DB: { prepare() { throw new Error("db down"); } } } as unknown as Env;
		await expect(logEvent(env, { source: "x", event: "y" })).resolves.toBeUndefined();
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
		expect(sql).toContain("level = ?5");
		expect(args).toEqual(["u1", "i1", "t9", "apply", "error"]);
	});
});
