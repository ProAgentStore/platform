/**
 * #1385 — the workflow side of `questions: decide`: only a `decide` run takes the journalled `decide-<round>` step (an `ask` run's steps are
 * exactly what they were), the decision is recorded and posted on the linked issue, and a replayed step cannot post it twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../../lib/d1-sqlite.js";
import type { Env } from "../../types.js";

const posted: Array<{ repo: string; number: number; body: string }> = [];
vi.mock("../../lib/github-issues.js", async () => {
	const actual = await vi.importActual<typeof import("../../lib/github-issues.js")>("../../lib/github-issues.js");
	return { ...actual, postIssueComment: async (_env: unknown, _uid: string, repo: string, number: number, body: string) => {
			posted.push({ repo, number, body });
			return true;
		},
	};
});

const { makePauseEffects } = await import("./pause-effects.js");

let d1: RealSchemaD1;
let env: Env;
const labels: string[] = [];

const effects = (loopRunId: string | null, goal: Record<string, unknown> = {}) =>
	makePauseEffects({
		env,
		step: {} as never,
		goal: { repo: "acme/app", ...goal } as never,
		instanceId: "i1",
		userId: "u1",
		sessionId: "s1",
		repoId: "r1",
		boardTaskId: undefined,
		loopRunId,
		driverId: null,
		workflowInstanceId: undefined,
		cloneUrl: undefined,
		branch: undefined,
		token: undefined,
		tokenUsername: undefined,
		cardId: null,
		runRetry: (async (label: string, fn: () => Promise<unknown>) => {
			labels.push(label);
			return fn();
		}) as never,
		postToChat: async () => {},
		getConn: () => ({}) as never,
		setConn: () => {},
		nextN: () => 0,
		startOnRunner: async () => undefined,
		getObjective: () => null,
	});
const q = { round: 3, question: "Push now or wait?", options: ["Yes — commit and push now", "No — wait and run tests again first"], why: "", issue: { repo: "acme/app", number: 394 } };
const startRun = (id: string, policy: string | null) =>
	d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, questions_policy) VALUES ('${id}', 'u1', 'i1', 'x', 'running', 10, 1, ${policy ? `'${policy}'` : "NULL"})`);

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	env = { DB: d1.DB } as unknown as Env;
	posted.length = 0;
	labels.length = 0;
	startRun("run-d", "decide");
	startRun("run-a", "ask");
});
afterEach(() => d1.close());

describe("makePauseEffects.questionPolicy (#1385)", () => {
	it("a `decide` run takes one journalled step named for the round, decides, posts on the issue and answers with a note", async () => {
		const out = await effects("run-d").deps(3, "decision").questionPolicy?.(q);
		expect(out).toMatchObject({ decided: true });
		expect(labels).toEqual(["decide-3"]);
		expect(posted).toHaveLength(1);
		expect(posted[0]).toMatchObject({ repo: "acme/app", number: 394 });
	});

	it("an `ask` run takes NO step and touches nothing: its journal is byte-for-byte what it was", async () => {
		expect(await effects("run-a").deps(3, "decision").questionPolicy?.(q)).toEqual({ decided: false });
		expect(labels).toEqual([]);
		expect(posted).toEqual([]);
		expect((d1.sqlite.prepare("SELECT count(*) AS n FROM run_question_decisions").get() as { n: number }).n).toBe(0);
	});

	it("a pause with no loop-run row has no policy at all", () => {
		expect(effects(null).deps(0, "decision").questionPolicy).toBeUndefined();
	});

	it("a replayed step decides again but records and comments once", async () => {
		const e = effects("run-d").deps(3, "decision");
		await e.questionPolicy?.(q);
		await e.questionPolicy?.(q);
		expect(posted).toHaveLength(1);
		expect((d1.sqlite.prepare("SELECT count(*) AS n FROM run_question_decisions WHERE run_id = 'run-d'").get() as { n: number }).n).toBe(1);
	});
});

// #1390: the goal the workflow holds is what the judge reads — the objective, the owner's hints, the standing rules.
describe("makePauseEffects.questionPolicy reads the run's own words (#1390)", () => {
	const close = { round: 4, question: "The production E2E failed. How should I finish #243?", options: ["Close #243 and note the failure in a comment", "Leave #243 open and report what failed"], why: "", issue: { repo: "acme/app", number: 243 } };
	const decided = async (goal: Record<string, unknown>) => {
		const out = await effects("run-d", goal).deps(4, "decision").questionPolicy?.(close);
		return out && "note" in out ? out.note : null;
	};

	it("with no words about closing, the ranking is unchanged — the closing option still wins on 'note'", async () => {
		expect(await decided({ objective: "Work #243." })).toContain("Decision: Close #243 and note the failure in a comment");
	});

	it("the goal's objective gates closing: the run is told to keep #243 open", async () => {
		const note = await decided({ objective: "Close #243 only if all three are green; otherwise leave it open and report what failed." });
		expect(note).toContain("Decision: Leave #243 open and report what failed");
		expect(posted[0].body).toContain("Not considered:");
	});

	it("a hint carried on the goal gates it, and so does an owner directive sent mid-run", async () => {
		expect(await decided({ objective: "Work #243.", userHint: "Close #243 only when the production E2E is fully green." })).toContain("Decision: Leave #243 open");
		posted.length = 0;
		d1.exec("DELETE FROM run_question_decisions");
		expect(await decided({ objective: "Work #243.", ownerDirectives: [{ text: "Do not close #243 yet.", at: 1, delivery: "now", processed: true }] })).toContain("Decision: Leave #243 open");
	});

	it("the standing rules gate it", async () => {
		expect(await decided({ objective: "Work #243.", standingInstructions: "Never close an issue unless its production check is green." })).toContain("Decision: Leave #243 open");
	});
});
