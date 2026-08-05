import { describe, expect, it } from "vitest";
import { claimSessionDriver, releaseSessionDriver, endSession, touchSessionDriver, STALE_DRIVER_MS } from "./coding-store.js";
import type { Env } from "../types.js";

/** D1 stub whose UPDATE "changes" is decided by a predicate over the SQL, so we can model
 *  a row that does/doesn't satisfy the claim condition. */
function stubEnv(changes: number) {
	const writes: Array<{ sql: string; args: unknown[] }> = [];
	const env = {
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async run() { writes.push({ sql, args }); return { meta: { changes } }; },
							async all() { return { results: [] }; },
							async first() { return null; },
						};
					},
				};
			},
		},
	} as unknown as Env;
	return { env, writes };
}

describe("claimSessionDriver — one driver per engine (#208)", () => {
	it("decides the claim INSIDE the UPDATE, not with a preceding SELECT", async () => {
		// The whole point. A check-then-act lets two concurrent /run calls both read "free" and
		// both proceed — which is the race being closed, not a smaller version of it.
		const { env, writes } = stubEnv(1);
		await claimSessionDriver(env, "i1", "u1", "s1", "d1");
		expect(writes).toHaveLength(1);
		expect(writes[0].sql).toContain("UPDATE coding_sessions");
		expect(writes[0].sql).toContain("driver_id IS NULL OR driver_id = ?5");
	});

	it("refuses a session that is not active", async () => {
		const { env, writes } = stubEnv(0);
		await expect(claimSessionDriver(env, "i1", "u1", "s1", "d1")).resolves.toBe(false);
		expect(writes[0].sql).toContain("status = 'active'");
	});

	it("reports false when another driver holds it", async () => {
		const { env } = stubEnv(0); // predicate didn't match → someone else's claim
		expect(await claimSessionDriver(env, "i1", "u1", "s1", "d1")).toBe(false);
	});

	it("is re-entrant for the SAME driver, so a workflow retry doesn't lock itself out", async () => {
		// Cloudflare re-runs a step body after a retry. If the claim only matched NULL, the second
		// attempt of the very step that took the claim would 409 against itself.
		const { env, writes } = stubEnv(1);
		await claimSessionDriver(env, "i1", "u1", "s1", "d1");
		expect(writes[0].sql).toContain("driver_id = ?5");
		expect(writes[0].args).toContain("d1");
	});

	it("scopes the claim to the owner and instance", async () => {
		const { env, writes } = stubEnv(1);
		await claimSessionDriver(env, "i1", "u1", "s1", "d1");
		expect(writes[0].sql).toContain("instance_id = ?2 AND user_id = ?3");
	});
});

describe("releasing the claim", () => {
	it("a late release cannot free somebody else's claim", async () => {
		const { env, writes } = stubEnv(1);
		await releaseSessionDriver(env, "i1", "u1", "s1", "d1");
		expect(writes[0].sql).toContain("driver_id = ?4");
		expect(writes[0].args).toContain("d1");
	});

	it("ending a session frees its claim — every terminal path, without knowing it exists", async () => {
		// endSession is the ONE place a session leaves `active` (#206), so putting the clear here
		// covers the end route, the orphan reaper, a --force takeover and the Pilot's own close.
		// A claim that outlived its session would lock the repo out of all future runs.
		const { env, writes } = stubEnv(1);
		await endSession(env, "i1", "u1", "s1");
		const upd = writes.find((w) => w.sql.includes("UPDATE coding_sessions"));
		expect(upd?.sql).toContain("driver_id = NULL");
		expect(upd?.sql).toContain("driver_at = NULL");
	});
});

describe("a claim expires — a dead workflow must not lock the session forever", () => {
	it("is takeable once it has gone quiet", () => {
		// The production failure: release happens in endSession, and the reasoning was that a dead
		// workflow gets cleaned up by reconcileOrphanedSessions. That only fires when the RUNNER
		// reports no tmux. A workflow that dies while its tmux is healthy left the session `active`
		// forever, so every later run got "already being worked on" — with nothing to stop and no
		// way back. It happened within hours of shipping.
		const { env, writes } = stubEnv(1);
		return claimSessionDriver(env, "i1", "u1", "s1", "d1").then(() => {
			expect(writes[0].sql).toContain("driver_at < ?6");
			// The cutoff is a timestamp, not a flag — an old claim is stale by arithmetic.
			expect(Number(writes[0].args[5])).toBeLessThan(Date.now());
			expect(Number(writes[0].args[5])).toBeGreaterThan(Date.now() - STALE_DRIVER_MS - 5_000);
		});
	});

	it("treats a pre-heartbeat claim (driver_at NULL) as takeable", () => {
		// Rows claimed before the heartbeat column was written must not be permanent locks.
		const { env, writes } = stubEnv(1);
		return claimSessionDriver(env, "i1", "u1", "s1", "d1").then(() => {
			expect(writes[0].sql).toContain("driver_at IS NULL");
		});
	});

	it("waits longer than the longest LEGITIMATE silence", () => {
		// A live Pilot heartbeats per action, so the only quiet stretch is a human handoff —
		// itself bounded at 15 minutes. Shorter than that and a run loses its own claim while a
		// human is answering it.
		expect(STALE_DRIVER_MS).toBeGreaterThanOrEqual(15 * 60_000);
	});

	it("heartbeats only the claim it actually holds", () => {
		// Scoped to driver_id: a stale workflow must not keep someone else's claim alive.
		const { env, writes } = stubEnv(1);
		return touchSessionDriver(env, "i1", "u1", "s1", "d1").then(() => {
			expect(writes[0].sql).toContain("driver_id = ?4");
			expect(writes[0].sql).toContain("SET driver_at = ?5");
			expect(writes[0].args).toContain("d1");
		});
	});
});

