/**
 * #1709 — the owner abandons a run: its questions are cleared, nothing can resume it, and it is settled, over the real schema.
 * Only the Workflows binding is faked.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { getCoderQuestion, recordAnswer, storedAnswer } from "./coder-question-store.js";
import { DECISION_PARK_MS, runDueParkWakes } from "./coding-park.js";
import { abandonRun } from "./run-abandon.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
let env: Env;
let sent: string[];
let workflowGone: boolean;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["i2"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', 'i1', 'u1', 'owner/repo')`);
	sent = [];
	workflowGone = false;
	const CODING_SESSION = {
		get: async () => ({
			status: async () => ({ status: workflowGone ? "terminated" : "waiting" }),
			sendEvent: async (e: { type: string }) => void sent.push(e.type),
		}),
	};
	env = { DB: d1.DB, CODING_SESSION } as unknown as Env;
	const at = Date.now() - 1000;
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type) VALUES ('s1', 'i1', 'r1', 'u1', 'active', 'claude')`);
	d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id, last_alive_at, waiting_reason, waiting_until, parked_since, workflow_instance_id)
	  VALUES ('run-1', 'u1', 'i1', 'x', 'running', 10, ${at}, 's1', ${at}, 'decision', ${at + DECISION_PARK_MS}, ${at}, 'wf-1')`);
	d1.exec(`INSERT INTO coder_questions (id, instance_id, user_id, session_id, run_id, task_id, question, state, asked_at, expires_at)
	  VALUES ('q1', 'i1', 'u1', 's1', 'run-1', 'csess-s1', 'Keep it?', 'waiting_human', ${at}, ${at + 15 * 60_000})`);
});
afterEach(() => d1.close());

const run = () => d1.sqlite.prepare("SELECT status, stop_reason, cancel_requested FROM agent_loop_runs WHERE run_id = 'run-1'").get() as { status: string; stop_reason: string | null; cancel_requested: number };

describe("abandonRun", () => {
	it("clears the parked question, asks the run to stop and wakes its workflow", async () => {
		const out = await abandonRun(env, { userId: "u1", instanceId: "i1", runId: "run-1" });
		expect(out).toMatchObject({ runId: "run-1", was: "running", questionsCleared: 1, outcome: "cancelling" });
		expect(run().cancel_requested).toBe(1);
		const q = await getCoderQuestion(env, "q1");
		expect(q).toMatchObject({ state: "expired" });
		expect(q?.appliedAt).toBeTruthy();
		expect(sent.length).toBeGreaterThan(0);
	});

	it("an answer that arrives afterwards cannot resume it: it is recorded and never applied", async () => {
		await abandonRun(env, { userId: "u1", instanceId: "i1", runId: "run-1" });
		const r = await recordAnswer(env, { instanceId: "i1", userId: "u1", taskId: "csess-s1", value: "yes", via: "console" });
		expect(r?.outcome).toBe("already_applied");
		expect(await storedAnswer(env, "q1")).toBeNull();
	});

	it("an answer already given but not yet used is marked consumed too", async () => {
		await recordAnswer(env, { instanceId: "i1", userId: "u1", taskId: "csess-s1", value: "yes", via: "console" });
		expect(await storedAnswer(env, "q1")).toMatchObject({ value: "yes" });
		await abandonRun(env, { userId: "u1", instanceId: "i1", runId: "run-1" });
		expect(await storedAnswer(env, "q1")).toBeNull();
		expect(await getCoderQuestion(env, "q1")).toMatchObject({ state: "answered_human" });
	});

	it("a parked run whose workflow is gone is settled cancelled here, not left for the sweeper to close continuable", async () => {
		workflowGone = true;
		const out = await abandonRun(env, { userId: "u1", instanceId: "i1", runId: "run-1" });
		expect(out?.outcome).toBe("cancelled");
		expect(run()).toMatchObject({ status: "cancelled", stop_reason: "cancelled" });
		sent.length = 0;
		expect(await runDueParkWakes(env, Date.now() + 10 * 60_000)).toBe(0);
	});

	it("is idempotent and clears a settled run's leftovers without reopening it", async () => {
		await abandonRun(env, { userId: "u1", instanceId: "i1", runId: "run-1" });
		d1.exec("UPDATE agent_loop_runs SET status = 'failed', stop_reason = 'failed'");
		d1.exec(`INSERT INTO coder_questions (id, instance_id, user_id, session_id, run_id, task_id, question, state, asked_at, expires_at, answered_at, answered_by, decision)
		  VALUES ('q2', 'i1', 'u1', 's1', 'run-1', 'csess-s1', 'Again?', 'answered_human', 1, 2, 3, 'human', 'yes')`);
		const again = await abandonRun(env, { userId: "u1", instanceId: "i1", runId: "run-1" });
		expect(again).toMatchObject({ was: "failed", questionsCleared: 1, outcome: "already_ended" });
		expect(await storedAnswer(env, "q2")).toBeNull();
		expect(run().status).toBe("failed");
	});

	it("is the owner's: another user's run, or one on another instance, is not found and nothing changes", async () => {
		expect(await abandonRun(env, { userId: "u2", instanceId: "i2", runId: "run-1" })).toBeNull();
		expect(await abandonRun(env, { userId: "u1", instanceId: "i2", runId: "run-1" })).toBeNull();
		expect(run().cancel_requested).toBe(0);
		expect(await getCoderQuestion(env, "q1")).toMatchObject({ state: "waiting_human" });
	});
});
