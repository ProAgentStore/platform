/**
 * #1362 — a run the 3h stale sweep closed records its real outcome when the driver turns out to be alive. Real migrated
 * schema: the sweep, its `run.stalled` event and `finishLoopRun`'s monotonic guard are exercised as written.
 */
import { afterEach, describe, expect, it } from "vitest";
import { finishLoopRun, getLoopRun } from "./agent-loop-store.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { STALE_RUN_MS, sweepStaleRuns } from "./run-sweeper.js";
import type { Env } from "../types.js";

const T0 = Date.parse("2026-10-25T00:00:00Z");
let d1: RealSchemaD1;
afterEach(() => d1.close());

function quietRun(runId = "r1"): Env {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, iteration, max_iterations, started_at) VALUES ('${runId}', 'u1', 'i1', 'implement #9', 'running', 3, 40, ${T0})`);
	return { DB: d1.DB } as unknown as Env;
}
const later = T0 + STALE_RUN_MS + 60_000;

describe("the stale sweep's `failed` is a guess the run's own outcome may correct (#1362)", () => {
	it("a late real outcome replaces the sweep's close — here a credit stop, which auto-resume can then find", async () => {
		const env = quietRun();
		await sweepStaleRuns(env, later);
		expect(await getLoopRun(env, "u1", "r1")).toMatchObject({ status: "failed", stopReason: "failed" });
		expect(await finishLoopRun(env, "r1", "provider_credit", "Stopped because the Anthropic API key has insufficient balance", later + 1_000)).toBe("applied");
		expect(await getLoopRun(env, "u1", "r1")).toMatchObject({ status: "needs_human", stopReason: "provider_credit" });
	});

	it("…and a late `done` reports the run finished", async () => {
		const env = quietRun();
		await sweepStaleRuns(env, later);
		expect(await finishLoopRun(env, "r1", "done", "all green", later + 1_000)).toBe("applied");
		expect(await getLoopRun(env, "u1", "r1")).toMatchObject({ status: "completed", stopReason: "done" });
	});

	it("a corrected run is settled: a retried step neither re-applies nor is overwritten again", async () => {
		const env = quietRun();
		await sweepStaleRuns(env, later);
		expect(await finishLoopRun(env, "r1", "done", "all green", later + 1_000)).toBe("applied");
		expect(await finishLoopRun(env, "r1", "done", "all green", later + 2_000)).toBe("already");
		expect(await finishLoopRun(env, "r1", "failed", "something else", later + 3_000)).toBe("superseded");
	});

	it("a late `failed` leaves the sweep's row as it is — the same verdict, and no second application of a retried step", async () => {
		const env = quietRun();
		await sweepStaleRuns(env, later);
		expect(await finishLoopRun(env, "r1", "failed", "the agent's own failure", later + 1_000)).toBe("already");
	});

	it("a failure the RUN wrote itself is a verdict, not a guess, and stays", async () => {
		const env = quietRun();
		expect(await finishLoopRun(env, "r1", "failed", "the objective cannot be met", T0 + 1_000)).toBe("applied");
		expect(await finishLoopRun(env, "r1", "done", "late", T0 + 2_000)).toBe("superseded");
		expect(await getLoopRun(env, "u1", "r1")).toMatchObject({ status: "failed", stopReason: "failed" });
	});

	it("a settled cancellation is never overwritten (#1015)", async () => {
		const env = quietRun();
		expect(await finishLoopRun(env, "r1", "cancelled", "stopped by you", T0 + 1_000)).toBe("applied");
		expect(await finishLoopRun(env, "r1", "done", "late", T0 + 2_000)).toBe("superseded");
	});
});
