import { describe, expect, it, vi } from "vitest";
import {
	ACTIVITY_TOUCH_MS,
	listIdleSessions,
	reassignSessionNode,
	reconcileOrphanedSessions,
	resumeSessionsForNode,
	suspendSessionsFromOtherNodes,
	touchSessionActivity,
} from "./coding-store.js";
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

	it("suspendSessionsFromOtherNodes also closes the board cards it parks (#206)", async () => {
		// The third of the four exits from `active`. It reads the ids BEFORE the update, because
		// afterwards nothing matches the predicate any more — get that order wrong and the cards
		// stay "running" for sessions this machine no longer owns, which is worse than no card:
		// a supervisor would report work on a machine that has gone.
		const writes: Write[] = [];
		const DB = {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async run() { writes.push({ sql, args }); return { meta: { changes: 2 } }; },
							async all() { return { results: [{ id: "s1" }, { id: "s2" }] }; },
							async first() { return null; },
						};
					},
				};
			},
		};
		await suspendSessionsFromOtherNodes({ DB } as unknown as Env, "inst-1", "user-1", "node-A");
		const card = writes.find((w) => w.sql.includes("instance_runtime_tasks"));
		expect(card).toBeDefined();
		// "cancelled", not "failed" — a takeover on another machine is a relocation, not an error.
		expect(card?.args).toEqual(["cancelled", "inst-1", "user-1", "csess-s1", "csess-s2"]);
	});

	it("reassignSessionNode relocates a session to the machine that's connected now (no status change)", async () => {
		const { env, writes } = mockEnv();
		await reassignSessionNode(env, "inst-1", "user-1", "csess-9", "node-B");
		expect(writes.length).toBe(1);
		expect(writes[0].sql).toContain("UPDATE coding_sessions SET runner_node = ?4");
		expect(writes[0].sql).not.toContain("status ="); // relocate only — the session stays active
		expect(writes[0].args).toEqual(["csess-9", "inst-1", "user-1", "node-B"]);
	});

	it("reassignSessionNode stores an empty/whitespace node as NULL (auto)", async () => {
		const { env, writes } = mockEnv();
		await reassignSessionNode(env, "inst-1", "user-1", "csess-9", "   ");
		expect(writes[0].args).toEqual(["csess-9", "inst-1", "user-1", null]);
	});
});

describe("reconcileOrphanedSessions (#139)", () => {
	// Env whose SELECT returns candidate active sessions past the grace window, and whose
	// UPDATEs are recorded so we can assert exactly which sessions got reaped.
	function reconcileEnv(candidateIds: string[]): { env: Env; updates: Write[] } {
		const updates: Write[] = [];
		const DB = {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async run() { if (sql.includes("UPDATE")) updates.push({ sql, args }); return { meta: { changes: 1 } }; },
							async all() { return { results: candidateIds.map((id) => ({ id })) }; },
							async first() { return null; },
						};
					},
				};
			},
		};
		return { env: { DB } as unknown as Env, updates };
	}

	it("ends active sessions the runner is NOT tracking, and leaves the live ones alone", async () => {
		const { env, updates } = reconcileEnv(["a", "b", "c"]);
		const reaped = await reconcileOrphanedSessions(env, "inst-1", "user-1", ["b"]); // runner tracks only b
		expect(reaped.sort()).toEqual(["a", "c"]);
		// The reaper is one of the FOUR places a session leaves `active` (#206) — each reaped
		// session must also close its board card, or a machine that rebooted leaves the supervisor
		// reading "running" forever, which is the exact state the card exists to disprove.
		const cards = updates.filter((u) => u.sql.includes("instance_runtime_tasks"));
		expect(cards.flatMap((u) => u.args)).toEqual(expect.arrayContaining(["csess-a", "csess-c"]));
		const sessions = updates.filter((u) => u.sql.includes("coding_sessions"));
		expect(sessions).toHaveLength(2); // one endSession UPDATE each for a + c
		for (const u of sessions) {
			expect(u.sql).toContain("status = ?4"); // endSession sets status via bind
			// Guarded WHERE clause — active OR suspended. `pags up --force` on another machine
			// suspends this node's sessions, and since the Pilot no longer cancels on `suspended`
			// (that would kill a legitimately relocated run), an active-only filter left a
			// suspended session with NO way to be stopped: Kill returned 0 changes while its Pilot
			// kept spending BYOK decisions.
			expect(u.sql).toContain("status IN ('active', 'suspended')");
		}
		expect(sessions.flatMap((u) => u.args)).toEqual(expect.arrayContaining(["a", "c"]));
	});

	it("reaps nothing when the runner is tracking every candidate", async () => {
		const { env, updates } = reconcileEnv(["a", "b"]);
		const reaped = await reconcileOrphanedSessions(env, "inst-1", "user-1", ["a", "b"]);
		expect(reaped).toEqual([]);
		expect(updates).toHaveLength(0);
	});
});

describe("session activity + idle listing (#275)", () => {
	/** Records SELECTs too — `mockEnv` only captures writes, and these two are read queries. */
	function readEnv(): { env: Env; reads: Write[] } {
		const reads: Write[] = [];
		const DB = {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async all() { reads.push({ sql, args }); return { results: [] }; },
							async first() { return null; },
							async run() { return { meta: { changes: 0 } }; },
						};
					},
				};
			},
		};
		return { env: { DB } as unknown as Env, reads };
	}

	it("touchSessionActivity throttles itself in the WHERE clause, not with a read", async () => {
		// `/capture` polls every 3 seconds per open session and the Pilot every 2. A read-then-write
		// would double the statements and race; the predicate makes 19 calls out of 20 a statement
		// that writes zero rows.
		const { env, writes } = mockEnv();
		const now = 1_800_000_000_000;
		await touchSessionActivity(env, "inst-1", "user-1", "csess-1", now);
		expect(writes).toHaveLength(1);
		expect(writes[0].sql).toContain("last_activity_at IS NULL OR last_activity_at < ?5");
		expect(writes[0].args).toEqual(["csess-1", "inst-1", "user-1", now, now - ACTIVITY_TOUCH_MS]);
	});

	it("touchSessionActivity only stamps an ACTIVE session", async () => {
		// Refreshing the stamp on an ended session would be a lie, and nothing reads it there.
		const { env, writes } = mockEnv();
		await touchSessionActivity(env, "inst-1", "user-1", "csess-1");
		expect(writes[0].sql).toContain("status = 'active'");
	});

	it("listIdleSessions refuses to hand the sweeper a session whose driver claim is still fresh", async () => {
		// Reaping a session out from under a live Pilot is the one outcome strictly worse than the
		// leak: the run loses its engine mid-step with no explanation anywhere.
		const { env, reads } = readEnv();
		await listIdleSessions(env, 123, 50);
		expect(reads[0].sql).toContain("driver_at IS NULL OR driver_at < ?2");
		expect(reads[0].args).toEqual([123, 123, 50]);
	});

	it("listIdleSessions falls back to updated_at for a row written before the backfill", async () => {
		// A session created by an in-flight isolate mid-deploy has a NULL stamp. Comparing NULL
		// against the cutoff is never true, so without the COALESCE that row would be immortal.
		const { env, reads } = readEnv();
		await listIdleSessions(env, 1, 1);
		expect(reads[0].sql).toContain("COALESCE(last_activity_at, CAST(strftime('%s', updated_at) AS INTEGER) * 1000)");
	});
});
