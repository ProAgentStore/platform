/**
 * #1077 item 4: a run the SWEEPER closes frees its repo exactly like one that ended by itself, so the
 * repo's queue drains. Before this the workflow's terminal path was the only drain, and a run that
 * died never reached it — everything queued behind it waited for something else to drain it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { drained } = vi.hoisted(() => ({ drained: [] as Array<[string, string | null, string]> }));
vi.mock("./objective-queue-start.js", () => ({
	tryDequeueAndStart: async (_env: unknown, instanceId: string, repoId: string | null, userId: string) => {
		drained.push([instanceId, repoId, userId]);
		return { drained: false };
	},
}));

import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { sweepStaleRuns } from "./run-sweeper.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
let env: Env;
beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', 'i1', 'u1', 'owner/repo')`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status) VALUES ('s1', 'i1', 'r1', 'u1', 'active'), ('s2', 'i1', 'r1', 'u1', 'ended')`);
	env = { DB: d1.DB } as unknown as Env;
	drained.length = 0;
});
afterEach(() => d1.close());

describe("the run sweeper drains what it frees (#1077)", () => {
	it("closing a silent coding run drains that repo's queue — once per repo", async () => {
		const old = Date.now() - 24 * 3_600_000;
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id, last_alive_at)
		  VALUES ('dead-1', 'u1', 'i1', 'x', 'running', 10, ${old}, 's1', ${old}), ('dead-2', 'u1', 'i1', 'y', 'running', 10, ${old}, 's2', ${old})`);
		const r = await sweepStaleRuns(env);
		expect(r.loopRuns).toBe(2);
		expect(drained).toEqual([["i1", "r1", "u1"]]);
	});

	it("a run with no coding session (a chat loop) has no checkout queue to drain", async () => {
		const old = Date.now() - 24 * 3_600_000;
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, last_alive_at) VALUES ('chat', 'u1', 'i1', 'x', 'running', 10, ${old}, ${old})`);
		await sweepStaleRuns(env);
		expect(drained).toEqual([]);
	});
});
