import { describe, expect, it } from "vitest";
import { expireOrphanedRuntimeTasks } from "./instances-runtime.js";
import type { Env } from "../types.js";

interface Write {
	sql: string;
	args: unknown[];
}

/** Minimal env.DB stub: SELECT returns `rows`, INSERT/UPDATE writes are recorded. */
function mockEnv(rows: Array<{ id: string; payload: string }>): { env: Env; writes: Write[] } {
	const writes: Write[] = [];
	const DB = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async all() {
							return { results: rows };
						},
						async run() {
							writes.push({ sql, args });
							return {};
						},
						async first() {
							return null;
						},
					};
				},
			};
		},
	};
	return { env: { DB } as unknown as Env, writes };
}

describe("expireOrphanedRuntimeTasks", () => {
	it("marks needs_human / running tasks failed with an orphan reason", async () => {
		const rows = [
			{ id: "t1", payload: JSON.stringify({ id: "t1", type: "job.apply_basic", status: "needs_human" }) },
			{ id: "t2", payload: JSON.stringify({ id: "t2", type: "browser.open", status: "running" }) },
		];
		const { env, writes } = mockEnv(rows);
		const n = await expireOrphanedRuntimeTasks(env, "inst1", "user1");
		expect(n).toBe(2);
		// mirrorRuntimeTask binds (id, instanceId, userId, type, status, payload, ...)
		expect(writes.map((w) => w.args[4])).toEqual(["failed", "failed"]);
		expect(String(writes[0].args[5])).toContain("orphaned");
	});

	it("does nothing when there are no in-flight tasks", async () => {
		const { env, writes } = mockEnv([]);
		const n = await expireOrphanedRuntimeTasks(env, "inst1", "user1");
		expect(n).toBe(0);
		expect(writes.length).toBe(0);
	});
});
