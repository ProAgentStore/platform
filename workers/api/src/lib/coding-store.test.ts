import { describe, expect, it, vi } from "vitest";
import { suspendActiveSessions, resumeSuspendedSessions } from "./coding-store.js";
import type { CodingSessionStatus } from "./coding-types.js";
import type { Env } from "../types.js";

interface Write { sql: string; args: unknown[] }

function mockEnv(): { env: Env; writes: Write[] } {
	const writes: Write[] = [];
	const DB = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async run() { writes.push({ sql, args }); return { meta: { changes: args.length > 0 ? 1 : 0 } }; },
						async all() { return { results: [] }; },
						async first() { return null; },
					};
				},
			};
		},
	};
	return { env: { DB } as unknown as Env, writes };
}

describe("CodingSessionStatus type", () => {
	it("includes all expected statuses", () => {
		const statuses: CodingSessionStatus[] = ["active", "ended", "error", "suspended"];
		expect(statuses).toHaveLength(4);
		expect(statuses).toContain("suspended");
	});
});

describe("coding-store session lifecycle", () => {
	it("suspendActiveSessions updates status to suspended", async () => {
		const { env, writes } = mockEnv();
		const n = await suspendActiveSessions(env, "inst-1", "user-1");
		expect(n).toBeGreaterThanOrEqual(0);
		expect(writes.length).toBe(1);
		expect(writes[0].sql).toContain("suspended");
		expect(writes[0].sql).toContain("UPDATE coding_sessions");
		expect(writes[0].args).toEqual(["inst-1", "user-1"]);
	});

	it("resumeSuspendedSessions updates status back to active", async () => {
		const { env, writes } = mockEnv();
		const n = await resumeSuspendedSessions(env, "inst-1", "user-1");
		expect(n).toBeGreaterThanOrEqual(0);
		expect(writes.length).toBe(1);
		expect(writes[0].sql).toContain("active");
		expect(writes[0].sql).toContain("suspended");
		expect(writes[0].args).toEqual(["inst-1", "user-1"]);
	});

	it("suspend and resume are inverse operations", async () => {
		const { env, writes } = mockEnv();
		await suspendActiveSessions(env, "inst-1", "user-1");
		await resumeSuspendedSessions(env, "inst-1", "user-1");
		expect(writes.length).toBe(2);
		// First suspends active → suspended
		expect(writes[0].sql).toContain("status = 'suspended'");
		expect(writes[0].sql).toContain("status = 'active'");
		// Second resumes suspended → active
		expect(writes[1].sql).toContain("status = 'active'");
		expect(writes[1].sql).toContain("status = 'suspended'");
	});
});
