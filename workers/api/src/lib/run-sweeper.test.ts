import { describe, expect, it } from "vitest";
import { STALE_RUN_MS, sweepStaleRuns } from "./run-sweeper.js";
import type { Env } from "../types.js";

const NOW = Date.parse("2026-08-05T12:00:00.000Z");

/** D1 stub: SELECTs return the rows queued per table, UPDATEs are recorded. */
function stubEnv(open: { loop?: string[]; pipeline?: string[] } = {}) {
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
								return { results: (ids ?? []).map((run_id) => ({ run_id })) };
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

	it("measures loop-run quiet from last_progress_at, falling back to started_at", async () => {
		// The SAME rule `summarizeSubordinates` uses. If the sweeper and the supervisor disagreed
		// about what "quiet" means, a run could read as fine to one and dead to the other.
		const { env, selects } = stubEnv({ loop: [] });
		await sweepStaleRuns(env, NOW);
		const s = selects.find((x) => x.sql.includes("agent_loop_runs"));
		expect(s?.sql).toContain("COALESCE(last_progress_at, started_at)");
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
