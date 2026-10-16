/** #1079 — the decision store's own rules, over the real schema (the workflow and routes call exactly these). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, type RealSchemaD1, seedTenant } from "./d1-sqlite.js";
import { answerDecision, getDecision, markCardApplied, pendingAnswersFor, recordPauseDecision } from "./owner-decisions.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
let env: Env;
const ask = (taskId = "task-1", question = "Notice period") => recordPauseDecision(env, { instanceId: "i1", userId: "u1", kind: "job_apply", subjectId: taskId, taskId, scope: "https://jobs.example/1", field: question, question });
beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

describe("owner decisions (#1079)", () => {
	it("a replayed pause returns the row it already wrote", async () => {
		expect((await ask()).id).toBe((await ask()).id);
	});

	it("the in-window path: the live run consumed the answer, so the next run is not handed it", async () => {
		const q = await ask();
		await answerDecision(env, { instanceId: "i1", userId: "u1", taskId: "task-1", value: "4 weeks", via: "console" });
		await markCardApplied(env, "i1", "task-1", "task-1");
		expect(await getDecision(env, q.id)).toMatchObject({ appliedRef: "task-1" });
		expect(await pendingAnswersFor(env, { instanceId: "i1", userId: "u1", kind: "job_apply", scope: "https://jobs.example/1" })).toEqual([]);
	});

	it("an owner may revise an answer no run has used; the latest answer per question is what the next run gets", async () => {
		await ask();
		await answerDecision(env, { instanceId: "i1", userId: "u1", taskId: "task-1", value: "4 weeks", via: "console" });
		const r = await answerDecision(env, { instanceId: "i1", userId: "u1", taskId: "task-1", value: "2 weeks", via: "mcp" });
		expect(r?.outcome).toBe("revised");
		const pending = await pendingAnswersFor(env, { instanceId: "i1", userId: "u1", kind: "job_apply", scope: "https://jobs.example/1" });
		expect(pending.map((d) => [d.field, d.answer, d.answeredVia])).toEqual([["Notice period", "2 weeks", "mcp"]]);
	});

	it("never drops an answer for want of a row (given its question), and never stores an empty or over-long one", async () => {
		const created = await answerDecision(env, { instanceId: "i1", userId: "u1", taskId: "run-9", question: "Expected salary?", value: "150k", via: "console", create: { kind: "apply_run", subjectId: "app-1", scope: "app-1" } });
		expect(created?.decision).toMatchObject({ kind: "apply_run", scope: "app-1", answer: "150k" });
		expect(await answerDecision(env, { instanceId: "i1", userId: "u1", taskId: "run-9", value: "  ", via: "console" })).toBeNull();
		expect(await answerDecision(env, { instanceId: "i1", userId: "u1", taskId: "run-9", value: "x".repeat(2_001), via: "console" })).toBeNull();
		expect(await answerDecision(env, { instanceId: "i1", userId: "u1", taskId: "no-such-card", value: "y", via: "console" })).toBeNull();
	});
});
