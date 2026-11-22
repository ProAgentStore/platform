/**
 * runDueParkWakes runs every minute, so its plan is the cost (#1641). It once read every coder_questions row
 * (~780K rows a call), then every sibling session's runs. It must walk only the parked runs and reach each one's
 * questions and holders through an index. A bare SCAN of anything else fails here.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDueParkWakes } from "./coding-park.js";
import { type RealSchemaD1, realSchemaD1, seedTenant } from "./d1-sqlite.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
});
afterEach(() => d1.close());

describe("runDueParkWakes plan", () => {
	it("starts from the parked runs and searches questions and holders by index, scanning nothing else", async () => {
		const env = { DB: d1.DB, CODING_SESSION: { get: async () => ({ sendEvent: async () => undefined }) } } as unknown as Env;
		await runDueParkWakes(env, Date.now());
		const sweep = d1.issued.find((s) => s.sql.includes("FROM agent_loop_runs r") && s.sql.includes("coder_questions"));
		if (!sweep) throw new Error("the sweep was not issued");
		const plan = (d1.sqlite.prepare(`EXPLAIN QUERY PLAN ${sweep.sql}`).all() as Array<{ detail: string }>).map((r) => r.detail);
		expect(plan).toContain("SCAN r USING INDEX idx_agent_loop_runs_parked");
		expect(plan).toContain("SEARCH q EXISTS USING INDEX idx_coder_questions_run (run_id=?)");
		// #1689: the due runs are found first (materialized), and holders are asked about only for those.
		expect(plan).toContain("MATERIALIZE due");
		expect(plan.indexOf("MATERIALIZE due")).toBeLessThan(plan.findIndex((d) => d.includes("idx_coding_sessions_held")));
		expect(plan.filter((d) => d.startsWith("SCAN") && d !== "SCAN due" && !d.startsWith("SCAN r USING INDEX idx_agent_loop_runs_parked"))).toEqual([]);
	});
});
