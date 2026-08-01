import { describe, expect, it, vi } from "vitest";
import { closeRun, listRuns, openRun } from "./pipeline-runs.js";
import type { Env } from "../types.js";

/**
 * A DB mock that records every prepared statement + its bound args, and returns a
 * canned `all()` result for reads. Mirrors the fake-D1 style the other lib tests use.
 */
function mockDb(rows: unknown[] = []) {
	const calls: Array<{ sql: string; binds: unknown[] }> = [];
	const DB = {
		prepare(sql: string) {
			const rec = { sql, binds: [] as unknown[] };
			calls.push(rec);
			const stmt = {
				bind(...binds: unknown[]) {
					rec.binds = binds;
					return stmt;
				},
				async run() {
					return { success: true };
				},
				async all() {
					return { results: rows };
				},
			};
			return stmt;
		},
	};
	return { env: { DB } as unknown as Env, calls };
}

describe("openRun", () => {
	it("inserts a 'running' row with started_at and json params", async () => {
		const { env, calls } = mockDb();
		await openRun(env, { runId: "r1", userId: "u1", instanceId: "i1", pipeline: "leads", trigger: "chat", params: { city: "Sydney" } });
		const insert = calls.find((c) => c.sql.includes("INSERT OR IGNORE INTO pipeline_runs"));
		expect(insert).toBeDefined();
		// run_id, user_id, instance_id, pipeline, trigger, params(json), started_at
		expect(insert?.binds.slice(0, 5)).toEqual(["r1", "u1", "i1", "leads", "chat"]);
		expect(insert?.binds[5]).toBe(JSON.stringify({ city: "Sydney" }));
		expect(typeof insert?.binds[6]).toBe("number"); // started_at
	});

	it("never throws when the DB write fails", async () => {
		const env = { DB: { prepare() { throw new Error("db down"); } } } as unknown as Env;
		await expect(openRun(env, { runId: "r1", userId: "u1", instanceId: "i1", pipeline: "p", trigger: "api" })).resolves.toBeUndefined();
	});
});

describe("closeRun", () => {
	it("updates status, finished_at, and the four counts", async () => {
		const { env, calls } = mockDb();
		await closeRun(env, "r1", "completed", { seen: 10, added: 7, skipped: 2, errors: 1 }, "done");
		const upd = calls.find((c) => c.sql.startsWith("UPDATE pipeline_runs"));
		expect(upd).toBeDefined();
		// run_id, status, finished_at, seen, added, skipped, errors, detail
		expect(upd?.binds[0]).toBe("r1");
		expect(upd?.binds[1]).toBe("completed");
		expect(typeof upd?.binds[2]).toBe("number");
		expect(upd?.binds.slice(3, 7)).toEqual([10, 7, 2, 1]);
		expect(upd?.binds[7]).toBe("done");
	});

	it("coerces non-integer counts to integers", async () => {
		const { env, calls } = mockDb();
		await closeRun(env, "r1", "failed", { seen: 3.9, added: 0, skipped: 0, errors: 1 }, undefined);
		const upd = calls.find((c) => c.sql.startsWith("UPDATE pipeline_runs"));
		expect(upd?.binds[3]).toBe(3); // 3.9 | 0 === 3
		expect(upd?.binds[7]).toBeNull(); // no detail
	});
});

describe("listRuns", () => {
	it("scopes to user + instance and parses params json", async () => {
		const { env, calls } = mockDb([
			{ run_id: "r1", user_id: "u1", instance_id: "i1", pipeline: "leads", trigger: "api", status: "completed", params: '{"city":"Sydney"}', started_at: 5, finished_at: 9, seen: 3, added: 2, skipped: 1, errors: 0, detail: null },
		]);
		const runs = await listRuns(env, { userId: "u1", instanceId: "i1" });
		expect(runs).toHaveLength(1);
		expect(runs[0].params).toEqual({ city: "Sydney" });
		expect(runs[0].status).toBe("completed");
		const q = calls[0];
		expect(q.sql).toContain("user_id = ?1");
		expect(q.sql).toContain("instance_id = ?2");
		expect(q.binds).toEqual(["u1", "i1"]);
	});

	it("adds a pipeline filter when given", async () => {
		const { env, calls } = mockDb([]);
		await listRuns(env, { userId: "u1", instanceId: "i1", pipeline: "leads", limit: 10 });
		expect(calls[0].sql).toContain("pipeline = ?3");
		expect(calls[0].binds).toEqual(["u1", "i1", "leads"]);
	});
});
