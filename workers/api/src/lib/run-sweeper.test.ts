import { describe, expect, it } from "vitest";
import { STALE_RUN_MS, sweepStaleRuns } from "./run-sweeper.js";
import type { Env } from "../types.js";

const NOW = Date.parse("2026-08-05T12:00:00.000Z");

/** D1 stub: SELECTs return the rows queued per table, UPDATEs are recorded. */
function stubEnv(open: { loop?: string[]; pipeline?: string[]; loopSessions?: Record<string, string | null> } = {}) {
	const updates: Array<{ sql: string; args: unknown[] }> = [];
	const selects: Array<{ sql: string; args: unknown[] }> = [];
	const env = {
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async all() {
								selects.push({ sql, args });
								const ids = sql.includes("agent_loop_runs") ? open.loop : open.pipeline;
								return {
									results: (ids ?? []).map((run_id) => ({
										run_id,
										instance_id: `inst-${run_id}`,
										user_id: `user-${run_id}`,
										session_id: open.loopSessions?.[run_id] ?? null,
									})),
								};
							},
							async run() {
								updates.push({ sql, args });
								return { meta: { changes: 1 } };
							},
						};
					},
				};
			},
		},
	} as unknown as Env;
	return { env, updates, selects };
}

describe("sweepStaleRuns — a run nobody will ever close", () => {
	it("closes a silent loop run as FAILED, not escalated", async () => {
		// `escalated` would put it in "Needs you" and imply a human can unblock it by answering a
		// question. Nothing about a dead workflow is answerable — `failed` is the honest word.
		const { env, updates } = stubEnv({ loop: ["r1"] });
		const out = await sweepStaleRuns(env, NOW);
		expect(out.loopRuns).toBe(1);
		const u = updates.find((x) => x.sql.includes("agent_loop_runs"));
		expect(u?.sql).toContain("status = 'failed'");
		expect(u?.sql).toContain("stop_reason = 'failed'");
		expect(u?.args).toContain(NOW); // finished_at, ms epoch like the column
		expect(u?.args).toContain("r1");
	});

	it("marks a silent pipeline run INTERRUPTED — the word that vocabulary already has", async () => {
		const { env, updates } = stubEnv({ pipeline: ["p1"] });
		const out = await sweepStaleRuns(env, NOW);
		expect(out.pipelineRuns).toBe(1);
		const u = updates.find((x) => x.sql.includes("pipeline_runs"));
		expect(u?.sql).toContain("status = 'interrupted'");
	});

	it("measures loop-run quiet from LIVENESS, falling back to progress and then to started_at", async () => {
		// The SAME rule `summarizeSubordinates` uses. If the sweeper and the supervisor disagreed
		// about what "quiet" means, a run could read as fine to one and dead to the other.
		//
		// `last_alive_at` first since 0127 (#580): this predicate is the reason the pause tick wrote
		// `last_progress_at` on a timer, which is what made a parked run's progress timestamp lie.
		// The fallback chain is what keeps a pre-0127 row behaving exactly as it did.
		// `run-liveness.test.ts` asserts the EFFECT of this on real rows; this asserts its shape.
		const { env, selects } = stubEnv({ loop: [] });
		await sweepStaleRuns(env, NOW);
		const s = selects.find((x) => x.sql.includes("agent_loop_runs"));
		expect(s?.sql).toContain("COALESCE(last_alive_at, last_progress_at, started_at)");
		expect(s?.args[0]).toBe(NOW - STALE_RUN_MS);
	});

	it("only ever touches rows still marked running", async () => {
		// The UPDATE re-checks the status it selected on. Without it, a run that closed itself in
		// the gap between the SELECT and the UPDATE would be overwritten with 'failed' — turning a
		// completed run into a failure, which is worse than the stranded row being fixed.
		const { env, updates } = stubEnv({ loop: ["r1"], pipeline: ["p1"] });
		await sweepStaleRuns(env, NOW);
		expect(updates).toHaveLength(2);
		for (const u of updates) expect(u.sql).toContain("WHERE status = 'running'");
	});

	it("issues NO update when nothing is stale", async () => {
		const { env, updates } = stubEnv();
		await expect(sweepStaleRuns(env, NOW)).resolves.toEqual({ loopRuns: 0, pipelineRuns: 0 });
		expect(updates).toHaveLength(0);
	});

	it("bounds one pass so a backlog drains over several minutes", async () => {
		const { env, selects } = stubEnv();
		await sweepStaleRuns(env, NOW);
		for (const s of selects) expect(s.sql).toContain("LIMIT ?2");
	});

	it("waits far longer than the longest LEGITIMATE silence", async () => {
		// A Pilot parked in a human handoff is silent for up to HANDOFF_WAIT_POLLS × 5s = 15 min,
		// and can take several such waits across its rounds. Sweeping a live run tells a supervisor
		// its subordinate failed while it is still working — the expensive direction of the error.
		expect(STALE_RUN_MS).toBeGreaterThanOrEqual(60 * 60_000);
		expect(STALE_RUN_MS).toBe(3 * 60 * 60_000);
	});
});

describe("a dead run's BOARD CARD closes with it (#553 AC 3)", () => {
	it("closes the coding card of every stale run that had a session", async () => {
		// `csess_22d08431` sat in "Running" 16 HOURS after its run died: the sweeper closed the run
		// row and nothing touched the card, so the board — the surface somebody actually looks at —
		// showed an in-flight job for a workflow that no longer existed.
		const { env, updates } = stubEnv({ loop: ["r1", "r2"], loopSessions: { r1: "csess_a", r2: null } });
		await sweepStaleRuns(env, NOW);
		const cards = updates.filter((u) => u.sql.includes("instance_runtime_tasks"));
		// EXACTLY one: `r2` is a chat or pipeline run with no `session_id`, and inventing a card id
		// for it would patch a row belonging to something else.
		expect(cards.length, "one card write, for the one run that had a coding session").toBe(1);
		expect(cards[0].args).toEqual(["failed", "inst-r1", "user-r1", "csess-csess_a"]);
	});

	it("cannot overwrite a card the run itself already closed", async () => {
		// The sweeper is a backstop, not an authority: if the workflow turns out to be alive after
		// all, its own terminal write wins. Same rule this file's header states for the run rows.
		const { env, updates } = stubEnv({ loop: ["r1"], loopSessions: { r1: "csess_a" } });
		await sweepStaleRuns(env, NOW);
		expect(updates.find((u) => u.sql.includes("instance_runtime_tasks"))?.sql).toContain("status IN ('running', 'needs_human')");
	});

	it("writes no card at all when nothing was stale", async () => {
		const { env, updates } = stubEnv({ loop: [] });
		await sweepStaleRuns(env, NOW);
		expect(updates.filter((u) => u.sql.includes("instance_runtime_tasks"))).toHaveLength(0);
	});
});
