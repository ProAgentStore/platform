/**
 * #1678: a `decision` park in the inbox, on the real schema — the SQL runs, so the predicate is tested on rows.
 *
 * The owner's top item was a question they had ALREADY answered (the run's own status said "ANSWER
 * PENDING, not waiting on you"), and it linked to a suspended session's view, which has nothing to answer.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { readInbox } from "./inbox.js";
import type { Env } from "../types.js";

const NOW = Date.parse("2026-11-20T12:00:00Z");
let d1: RealSchemaD1;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
});
afterEach(() => d1.close());

const ask = (taskId: string, question: string) => JSON.stringify({ question, options: ["A", "B"], field: question, taskId });

function decisionRun(runId: string, sessionId: string, waitingAsk: string | null) {
	d1.sqlite
		.prepare(
			`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, waiting_reason, waiting_until, parked_since, waiting_ask, session_id)
			 VALUES (?, 'u1', 'i1', 'Implement console issue #10', 'running', 30, ?, 'decision', ?, ?, ?, ?)`,
		)
		.run(runId, NOW - 60_000, NOW + 86_400_000, NOW - 30_000, waitingAsk, sessionId);
}

function question(id: string, runId: string, sessionId: string, state: string, extra: { answered_at?: number; applied_at?: number } = {}) {
	d1.sqlite
		.prepare(
			`INSERT INTO coder_questions (id, instance_id, user_id, session_id, run_id, task_id, question, state, asked_at, expires_at, answered_at, applied_at)
			 VALUES (?, 'i1', 'u1', ?, ?, ?, 'How should we proceed?', ?, ?, ?, ?, ?)`,
		)
		.run(id, sessionId, runId, `csess-${sessionId}`, state, NOW - 50_000, NOW + 50_000, extra.answered_at ?? null, extra.applied_at ?? null);
}

const read = async () => (await readInbox({ DB: d1.DB } as unknown as Env, "u1", NOW)).items;

describe("inbox: a run parked on a decision (#1678)", () => {
	it("leaves out a run whose answer is recorded and not yet applied: it waits on the run, not the owner", async () => {
		decisionRun("r-answered", "s1", ask("csess-s1", "Which scope?"));
		question("q1", "r-answered", "s1", "answered_human", { answered_at: NOW - 10_000 });
		decisionRun("r-unresolved", "s2", ask("csess-s2", "Which scope?"));
		question("q2", "r-unresolved", "s2", "unresolved");
		expect(await read()).toEqual([]);
	});

	it("an open question is listed once, as the question, on the task page where it is answered", async () => {
		decisionRun("r-open", "s1", ask("csess-s1", "Which scope?"));
		question("q1", "r-open", "s1", "waiting_human");
		const items = await read();
		expect(items.map((i) => i.id)).toEqual(["coder_question:q1"]);
		expect(items[0].route).toBe("/instances/i1/tasks/csess-s1");
	});

	it("a park with no open or pending question names its question and links to its task page", async () => {
		decisionRun("r-bare", "s1", ask("csess-s1", "Fix all three, or only the small ones?"));
		// An answer that was already APPLIED says nothing about this later park.
		question("q-old", "r-bare", "s1", "answered_human", { answered_at: NOW - 40_000, applied_at: NOW - 35_000 });
		const items = await read();
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ id: "run_parked:r-bare", kind: "run_parked", title: "Fix all three, or only the small ones?", route: "/instances/i1/tasks/csess-s1", urgency: "blocking" });
	});

	it("without a stored ask it keeps the generic title and falls back to the session", async () => {
		decisionRun("r-noask", "s1", null);
		const [item] = await read();
		expect(item).toMatchObject({ title: "A run is waiting for your decision", route: "/instances/i1/coding/s1" });
	});
});
