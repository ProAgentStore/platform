import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "./d1-sqlite.js";
import { countLoopRuns, LOOP_RUNS_COUNT_CAP } from "./agent-loop-store.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
let env: Env;
beforeEach(() => { d1 = realSchemaD1(); env = { DB: d1.DB } as unknown as Env; });
afterEach(() => d1.close());

const seed = (n: number, instance = "i1") => d1.exec(`WITH RECURSIVE s(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM s WHERE x < ${n}) INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at) SELECT '${instance}-' || x, 'u1', '${instance}', 'o', 'completed', 20, x FROM s`);

describe("countLoopRuns is bounded (#1681)", () => {
	it("is exact under the cap", async () => {
		seed(7);
		expect(await countLoopRuns(env, "u1", "i1")).toEqual({ total: 7, lowerBound: false });
		expect(await countLoopRuns(env, "u1", "other")).toEqual({ total: 0, lowerBound: false });
	});

	it("stops at the cap and says it is a lower bound, however many runs there are", async () => {
		seed(LOOP_RUNS_COUNT_CAP + 500);
		expect(await countLoopRuns(env, "u1", "i1")).toEqual({ total: LOOP_RUNS_COUNT_CAP + 1, lowerBound: true });
	});

	it("reads past the cap only as far as the page reaches, so offset paging still sees more", async () => {
		seed(LOOP_RUNS_COUNT_CAP + 500);
		expect(await countLoopRuns(env, "u1", "i1", LOOP_RUNS_COUNT_CAP + 100)).toEqual({ total: LOOP_RUNS_COUNT_CAP + 101, lowerBound: true });
	});
});
