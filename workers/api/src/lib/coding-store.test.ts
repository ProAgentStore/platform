import { describe, expect, it, vi } from "vitest";
import { suspendSessionsFromOtherNodes, resumeSessionsForNode } from "./coding-store.js";
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

describe("coding-store session lifecycle (node-owned suspend/resume)", () => {
	it("suspendSessionsFromOtherNodes parks only sessions NOT owned by the registering node", async () => {
		const { env, writes } = mockEnv();
		const n = await suspendSessionsFromOtherNodes(env, "inst-1", "user-1", "node-A");
		expect(n).toBeGreaterThanOrEqual(0);
		expect(writes.length).toBe(1);
		expect(writes[0].sql).toContain("status = 'suspended'");
		expect(writes[0].sql).toContain("UPDATE coding_sessions");
		// The ownership guard: leave the registering node's OWN active sessions alone.
		expect(writes[0].sql).toContain("runner_node IS NULL OR runner_node != ?3");
		expect(writes[0].args).toEqual(["inst-1", "user-1", "node-A"]);
	});

	it("resumeSessionsForNode resumes only THIS node's suspended sessions, index-safe (one/repo, free repos only)", async () => {
		const { env, writes } = mockEnv();
		const n = await resumeSessionsForNode(env, "inst-1", "user-1", "node-A");
		expect(n).toBeGreaterThanOrEqual(0);
		expect(writes.length).toBe(1);
		expect(writes[0].sql).toContain("status = 'active'");
		expect(writes[0].sql).toContain("status = 'suspended'");
		expect(writes[0].sql).toContain("runner_node = ?3");
		// At most one per repo (newest) and only where no active session already exists —
		// so it can never violate idx_coding_sessions_one_active.
		expect(writes[0].sql).toContain("MAX(rowid)");
		expect(writes[0].sql).toContain("repo_id NOT IN");
		expect(writes[0].args).toEqual(["inst-1", "user-1", "node-A"]);
	});
});
