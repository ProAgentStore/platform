/**
 * #1385 — `questions: "ask" | "decide"`: the judgement, the wording, and what is recorded and posted. Pure functions plus the real schema for the
 * storage; the issue comment is the only fake. The three questions in the issue (runs f3f023de, 8b38b5d9, 4925523a on instance e4d2d031) are the
 * fixtures, verbatim, because they are the cases the owner complained about.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { applyQuestionsPolicy, decisionComment, decisionNote, effectiveQuestionsPolicy, judgeQuestion, listQuestionDecisions, parseQuestionsPolicy, questionsFromMetadata, reversibilityScore, runQuestionsPolicy } from "./question-policy.js";
import type { Env } from "../types.js";

// ── the three questions from the issue, as the runs asked them ───────────────────────────────────────────────────────────────────────
const ORPHAN = {
	question: "One worker, `pas-data-micro`, has no observability settings and is not in the platform `apps` table — it was never touched by the fleet rollout. How should we handle it?",
	options: [
		"(a) Give me micro's creator_id and I'll register + redeploy it",
		"(b) Delete pas-data-micro (it's an orphan) — production delete; your call",
		"(c) Treat it as out of scope: record 44/44 registered apps verified; note micro as orphan in gates doc; close #394 with that caveat",
	],
};
const PUSH_OR_WAIT = {
	question: "The full `pnpm test` suite is failing with 2 flaky tests on each run, and they look like resource-contention failures. CI on a clean Linux runner will gate the deploy. Should I commit and push now, letting CI be the final verification?",
	options: ["Yes — commit and push now; let CI verify", "No — wait for an idle machine and run tests again first"],
};
const COMPLIANCE = {
	question: "The compliance checker needs fixes in the `@proappstore/compliance` package (a separate repo). The console repo itself cannot fully fix the 8 font findings without either (a) patching the checker or (b) working around it. What should we do?",
	options: [
		"Fix the compliance checker in its own repo (proappstore-online/proappstore or similar) — add sfmono-regular to allowlist; skip interpolated values and regex sources",
		"In console: swap SFMono-Regular→'SF Mono' in index.css (1 finding); move regex strings out of font-family context; use CSS vars for fontBody/fontDisplay (clears all 8 without obfuscation)",
		"Rename 'plausible' field and fix fonts in console however needed — ship it",
		"Show me more detail before deciding",
	],
};

describe("parsing the setting", () => {
	it("absent means inherit; the two words are accepted in any case; anything else names the two words", () => {
		expect(parseQuestionsPolicy(undefined)).toEqual({ ok: true, value: undefined });
		expect(parseQuestionsPolicy(null)).toEqual({ ok: true, value: undefined });
		expect(parseQuestionsPolicy("")).toEqual({ ok: true, value: undefined });
		expect(parseQuestionsPolicy(" Decide ")).toEqual({ ok: true, value: "decide" });
		expect(parseQuestionsPolicy("ask")).toEqual({ ok: true, value: "ask" });
		for (const bad of ["always", "yes", true, 1, {}, ["decide"]]) expect(parseQuestionsPolicy(bad), String(bad)).toEqual({ ok: false, error: 'questions must be "ask" or "decide"' });
	});

	it("the start's own value wins, then the instance default, then ask", () => {
		expect(effectiveQuestionsPolicy("decide", "ask")).toBe("decide");
		expect(effectiveQuestionsPolicy("ask", "decide")).toBe("ask");
		expect(effectiveQuestionsPolicy(undefined, "decide")).toBe("decide");
		expect(effectiveQuestionsPolicy(undefined, undefined)).toBe("ask");
		expect(effectiveQuestionsPolicy(null, null)).toBe("ask");
	});

	it("reads the setting a queued entry carried, and nothing from a blob that is not the shape", () => {
		expect(questionsFromMetadata('{"questions":"decide"}')).toBe("decide");
		expect(questionsFromMetadata('{"autoPickup":{"repo":"a/b","issue":1}}')).toBeUndefined();
		for (const junk of [null, undefined, "", "not json", '{"questions":"always"}', "[]", "null"]) expect(questionsFromMetadata(junk as string | null | undefined), String(junk)).toBeUndefined();
	});
});

describe("what `decide` takes itself — the issue's own questions", () => {
	it("the orphan worker (f3f023de): the option that needs the owner and the delete are set aside, and it takes 'out of scope, record it'", () => {
		const j = judgeQuestion(ORPHAN);
		expect(j).toMatchObject({ park: false, decision: ORPHAN.options[2] });
		if (j.park) throw new Error("expected a decision");
		expect(j.excluded.map((e) => e.option)).toEqual([ORPHAN.options[0], ORPHAN.options[1]]);
		expect(j.excluded[1].why).toMatch(/delete/i);
		expect(j.alternatives).toEqual([ORPHAN.options[0], ORPHAN.options[1]]);
		expect(j.reason).toMatch(/only option that needs nothing from the owner/);
	});

	it("push now or wait (8b38b5d9): both are reversible engineering calls, so it decides — and takes the one that publishes nothing", () => {
		const j = judgeQuestion(PUSH_OR_WAIT);
		expect(j).toMatchObject({ park: false, decision: PUSH_OR_WAIT.options[1], alternatives: [PUSH_OR_WAIT.options[0]], excluded: [] });
		expect(j.park ? "" : j.reason).toMatch(/most reversible of the 2 options/);
	});

	it("where the compliance fix belongs (4925523a): 'show me more detail' is the owner's, and the in-repo change beats reaching into another repo", () => {
		const j = judgeQuestion(COMPLIANCE);
		expect(j).toMatchObject({ park: false, decision: COMPLIANCE.options[1] });
		if (j.park) throw new Error("expected a decision");
		expect(j.excluded.map((e) => e.option)).toEqual([COMPLIANCE.options[3]]);
	});

	it("a question with no options is decided by the run itself: the platform names no choice", () => {
		expect(judgeQuestion({ question: "Which table layout should the dense list use?", options: [] })).toMatchObject({ park: false, decision: null, alternatives: [], excluded: [] });
	});

	it("ties go to the first option offered", () => {
		expect(judgeQuestion({ question: "Which name?", options: ["alpha", "beta", "gamma"] })).toMatchObject({ decision: "alpha" });
	});
});

describe("what `decide` never takes — the issue's explicit list", () => {
	it.each([
		["a credential", "The deploy needs a token. Should I rotate the API key and store the new secret?", ["Yes, rotate it", "No, keep the old one"], "privileges"],
		["a permission", "Should I grant the service account admin rights so the job can run?", ["Grant", "Do not grant"], "privileges"],
		["a destructive act", "Should I delete the staging database and recreate it?", ["Yes", "No"], "destructive"],
		["a force-push", "The branch diverged. Should I force-push over it?", ["Force-push", "Rebase"], "destructive"],
		["spend over the limit", "The run reached its cap. Should it get more iterations to finish?", ["Grant 20 more", "Stop here"], "spend"],
		["billing", "Should I switch the plan and issue a refund to the customer?", ["Do it", "Leave it"], "money"],
	])("%s parks, whatever the options look like", (_n, question, options, guardrail) => {
		expect(judgeQuestion({ question, options })).toMatchObject({ park: true, guardrail });
	});

	it("a question whose every option is a guarded act or hands it back to the owner parks", () => {
		const j = judgeQuestion({ question: "What next for the orphan worker?", options: ["Delete it from production", "Give me the creator id", "Your call"] });
		expect(j).toMatchObject({ park: true });
		expect(j.park ? j.why : "").toMatch(/every option/);
	});

	it("a guarded OPTION among safe ones is set aside rather than parking — but the same word in the QUESTION parks", () => {
		expect(judgeQuestion({ question: "How should we tidy the logs?", options: ["Delete all the logs", "Rotate them weekly"] })).toMatchObject({ park: false, decision: "Rotate them weekly" });
		expect(judgeQuestion({ question: "Should we delete the logs?", options: ["Rotate them weekly", "Keep them"] })).toMatchObject({ park: true, guardrail: "destructive" });
	});

	it("does NOT park on the brain's two broader rules: a question about a brand colour or a git branch is an ordinary engineering call", () => {
		expect(judgeQuestion({ question: "Should the brand colour override live in index.css or in the theme?", options: ["index.css", "the theme"] }).park).toBe(false);
		expect(judgeQuestion({ question: "Should the fix go in a branch or straight on main?", options: ["straight on main", "a branch"] }).park).toBe(false);
	});
});

describe("'most reversible' — a plain, documented ranking", () => {
	it("recording, deferring and staying local rank above redeploying, migrating and publishing", () => {
		expect(reversibilityScore("Record it on the issue and defer")).toBeGreaterThan(reversibilityScore("Rename everything and redeploy"));
		expect(reversibilityScore("Leave it as is")).toBeGreaterThan(reversibilityScore("Rewrite the module"));
		expect(reversibilityScore("Fix it in its own repo")).toBeLessThan(reversibilityScore("Fix it here"));
	});

	it("is capped, so a long option cannot win by repeating itself", () => {
		expect(reversibilityScore("record record record record record record record")).toBe(6);
		expect(reversibilityScore("deploy deploy deploy deploy deploy")).toBe(-3);
	});
});

describe("the words the run and the owner read", () => {
	const decided = judgeQuestion(ORPHAN);
	if (decided.park) throw new Error("fixture");

	it("the run is told the decision, why, and what it may do if the choice cannot work — attributed to the platform, not the owner", () => {
		const note = decisionNote(ORPHAN.question, decided, "proappstore-online/platform#394");
		expect(note).toContain("was not sent to the owner");
		expect(note).toContain("`decide`");
		expect(note).toContain("Decision: (c) Treat it as out of scope");
		expect(note).toContain("take the next most reversible option and say why on proappstore-online/platform#394");
		expect(note).toContain("Alternatives not taken");
		expect(note).not.toMatch(/the owner (answered|said|chose)/i);
	});

	it("a run with no linked issue is told to record in its commits instead", () => {
		expect(decisionNote(ORPHAN.question, decided, null)).toContain("in your commit messages (no issue is linked to this run)");
	});

	it("a question with no options is handed back to the run with the guardrails restated", () => {
		const free = judgeQuestion({ question: "Which layout?", options: [] });
		if (free.park) throw new Error("fixture");
		const note = decisionNote("Which layout?", free, "a/b#1");
		expect(note).toContain("offered no options");
		expect(note).toMatch(/credential, destroy data, spend beyond the limit or need the owner's computer, stop and ask/);
	});

	it("the issue comment carries the question, the decision, the alternatives and what was left to the owner, and says what still waits for them", () => {
		const c = decisionComment("run-1", ORPHAN.question, ORPHAN.options, decided);
		expect(c).toContain("Decided under `questions: decide`");
		expect(c).toContain("run `run-1`");
		expect(c).toContain("**Decided:** (c) Treat it as out of scope");
		expect(c).toContain("Alternatives not taken:");
		expect(c).toContain("Not considered:");
		expect(c).toMatch(/credential, a destructive act, spend over a limit and anything that needs your computer still wait for you/);
	});

	it("bounds what it writes: an enormous question is clipped, not carried whole", () => {
		const long = "x".repeat(5_000);
		expect(decisionComment("r", long, [], { park: false, decision: null, alternatives: [], excluded: [], reason: "r" }).length).toBeLessThan(1_500);
		expect(decisionNote(long, decided, null).length).toBeLessThan(2_000);
	});
});

// ── recording and posting, on the real schema ────────────────────────────────────────────────────────────────────────────────────
describe("recording and posting", () => {
	let d1: RealSchemaD1;
	let env: Env;
	const posted: Array<{ repo: string; number: number; body: string }> = [];
	let postOk = true;
	const ctx = (runId = "run-d", round = 0, issue: { repo: string; number: number } | null = { repo: "acme/app", number: 394 }) => ({
		runId,
		instanceId: "i1",
		userId: "u1",
		round,
		issue,
		postComment: async (repo: string, number: number, body: string) => {
			posted.push({ repo, number, body });
			return postOk;
		},
		now: 1_800_000_000_000,
	});
	const startRun = (id: string, policy: string | null) =>
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, questions_policy) VALUES ('${id}', 'u1', 'i1', 'x', 'running', 10, 1, ${policy ? `'${policy}'` : "NULL"})`);

	beforeEach(() => {
		d1 = realSchemaD1();
		seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
		env = { DB: d1.DB } as unknown as Env;
		posted.length = 0;
		postOk = true;
		startRun("run-d", "decide");
		startRun("run-a", "ask");
		startRun("run-legacy", null);
	});
	afterEach(() => d1.close());

	it("an `ask` run, and a run from before the setting existed, are untouched: nothing recorded, nothing posted", async () => {
		for (const id of ["run-a", "run-legacy"]) {
			expect(await runQuestionsPolicy(env, id)).toBe("ask");
			expect(await applyQuestionsPolicy(env, ctx(id), ORPHAN)).toEqual({ decided: false });
		}
		expect(posted).toEqual([]);
		expect((d1.sqlite.prepare("SELECT count(*) AS n FROM run_question_decisions").get() as { n: number }).n).toBe(0);
	});

	it("a `decide` run records the decision, its alternatives and why, posts it on the linked issue, and resumes with a note", async () => {
		const out = await applyQuestionsPolicy(env, ctx(), ORPHAN);
		expect(out).toMatchObject({ decided: true });
		expect(out.decided && out.note).toContain("Decision: (c)");
		expect(posted).toHaveLength(1);
		expect(posted[0]).toMatchObject({ repo: "acme/app", number: 394 });
		expect(posted[0].body).toContain("**Decided:**");
		const [row] = await listQuestionDecisions(env, "u1", "run-d");
		expect(row).toMatchObject({ outcome: "decided", decision: ORPHAN.options[2], round: 0, issue: { repo: "acme/app", number: 394 }, posted: true, guardrail: null });
		expect(row.alternatives).toEqual([ORPHAN.options[0], ORPHAN.options[1]]);
		expect(row.excluded).toHaveLength(2);
	});

	it("is idempotent per round: a retried step decides again but records and comments once", async () => {
		await applyQuestionsPolicy(env, ctx(), ORPHAN);
		const again = await applyQuestionsPolicy(env, ctx(), ORPHAN);
		expect(again).toMatchObject({ decided: true });
		expect(posted).toHaveLength(1);
		expect(await listQuestionDecisions(env, "u1", "run-d")).toHaveLength(1);
		await applyQuestionsPolicy(env, ctx("run-d", 1), PUSH_OR_WAIT);
		expect(await listQuestionDecisions(env, "u1", "run-d")).toHaveLength(2);
	});

	it("a comment that could not be posted still lets the run continue, and the row says it was not posted", async () => {
		postOk = false;
		expect(await applyQuestionsPolicy(env, ctx(), ORPHAN)).toMatchObject({ decided: true });
		expect((await listQuestionDecisions(env, "u1", "run-d"))[0].posted).toBe(false);
	});

	it("a run with no linked issue records the decision and posts nothing", async () => {
		expect(await applyQuestionsPolicy(env, ctx("run-d", 0, null), ORPHAN)).toMatchObject({ decided: true });
		expect(posted).toEqual([]);
		expect((await listQuestionDecisions(env, "u1", "run-d"))[0]).toMatchObject({ issue: null, posted: false });
	});

	it("a question `decide` keeps parks as usual — and the reason is recorded, so the park is explained", async () => {
		const out = await applyQuestionsPolicy(env, ctx(), { question: "Should I rotate the API key?", options: ["Yes", "No"] });
		expect(out).toEqual({ decided: false });
		expect(posted).toEqual([]);
		const [row] = await listQuestionDecisions(env, "u1", "run-d");
		expect(row).toMatchObject({ outcome: "parked", guardrail: "privileges", decision: null });
		expect(row.reason).toMatch(/something that .*(permissions|tokens|secrets)/i);
	});

	it("is owner-scoped: another account cannot read a run's decisions", async () => {
		await applyQuestionsPolicy(env, ctx(), ORPHAN);
		expect(await listQuestionDecisions(env, "u2", "run-d")).toEqual([]);
	});
});

// ── #1390: what the run's own objective has already ruled out ────────────────────────────────────────────────────────────────────────────
// Run 31555ee5 (ChessClubs-online/chess-clubs#243): the objective said close only if CI, deploy and a production E2E are all green, otherwise leave it
// open and report. The E2E failed; decide took "close" as the most reversible option, and the run closed the issue.
const GATED_OBJECTIVE =
	"Work #243. Close #243 only if all three are green (CI, deploy, and a dispatched production E2E); otherwise leave it open and report what failed.";
const HINT = "Close #243 only when the production E2E is fully green.";
const CLOSE_OR_KEEP = {
	question: "The production E2E failed. How should I finish #243?",
	options: ["Close #243 as done and file a separate issue for the failing E2E", "Leave #243 open and report what failed", "Close #243 and note the failure in a comment"],
};

describe("an objective that gates closing is not decided around (#1390)", () => {
	it("THE INCIDENT: without the run's words a closing option wins on a keyword ('note' reads as reversible); with them, close is set aside and the run keeps #243 open", () => {
		// Baseline: why the run closed it. Nothing in the judge knew the objective, so "Close #243 and note the failure…" outscored "Leave #243 open…".
		expect(judgeQuestion(CLOSE_OR_KEEP)).toMatchObject({ park: false, decision: CLOSE_OR_KEEP.options[2] });
		// With the objective and the hint: close is never chosen for the run.
		const j = judgeQuestion({ ...CLOSE_OR_KEEP, constraints: [GATED_OBJECTIVE, HINT] });
		expect(j).toMatchObject({ park: false, decision: "Leave #243 open and report what failed" });
		if (j.park) throw new Error("expected a decision");
		expect(j.excluded.map((e) => e.option)).toEqual([CLOSE_OR_KEEP.options[0], CLOSE_OR_KEEP.options[2]]);
		expect(j.excluded[0].why).toMatch(/it closes, and the run's objective gates closing \("Work #243\. Close #243 only if|Close #243 only if all three are green/);
		expect(j.excluded[0].why).toMatch(/only the run can check/);
	});

	it("the order the options are offered in does not matter", () => {
		const reversed = { ...CLOSE_OR_KEEP, options: [...CLOSE_OR_KEEP.options].reverse() };
		expect(judgeQuestion({ ...reversed, constraints: [GATED_OBJECTIVE] })).toMatchObject({ park: false, decision: "Leave #243 open and report what failed" });
	});

	it("a hint alone gates it: an objective that says nothing about closing, and a later 'only when green'", () => {
		expect(judgeQuestion({ ...CLOSE_OR_KEEP, constraints: ["Fix the flaky E2E in #243.", HINT] })).toMatchObject({ park: false, decision: "Leave #243 open and report what failed" });
	});

	it("a plain 'do not close' or 'keep it open' gates it too", () => {
		for (const words of ["Do not close #243 — I will review it myself.", "Don't close #243 yet.", "Keep #243 open until I say so.", "Leave the issue open."]) {
			expect(judgeQuestion({ ...CLOSE_OR_KEEP, constraints: [words] }), words).toMatchObject({ park: false, decision: "Leave #243 open and report what failed" });
		}
	});

	it("when EVERY option closes, it parks for the owner rather than closing — and says why", () => {
		const j = judgeQuestion({ question: "How do I finish?", options: ["Close #243 as done", "Close #243 and file a follow-up"], constraints: [GATED_OBJECTIVE] });
		expect(j).toMatchObject({ park: true, guardrail: "objective_constraint" });
		expect(j.park ? j.why : "").toMatch(/gates closing/);
	});

	it("a yes/no question about closing: 'yes' closes, so it is set aside and 'no' is taken", () => {
		const j = judgeQuestion({ question: "Should I close #243 now?", options: ["Yes", "No — leave it open"], constraints: [GATED_OBJECTIVE] });
		expect(j).toMatchObject({ park: false, decision: "No — leave it open" });
		// …and with nothing else to choose, it parks instead of telling the run to 'take the most reversible approach' on a closing question.
		expect(judgeQuestion({ question: "Should I close #243 now?", options: ["Yes"], constraints: [GATED_OBJECTIVE] })).toMatchObject({ park: true, guardrail: "objective_constraint" });
		expect(judgeQuestion({ question: "Should I close #243 now?", options: [], constraints: [GATED_OBJECTIVE] })).toMatchObject({ park: true, guardrail: "objective_constraint" });
	});

	it("an option that says NOT to close is not a closing option", () => {
		const j = judgeQuestion({ question: "What now?", options: ["Close #243", "Do not close #243; file the failure as a new issue", "Wait for the E2E to be re-run"], constraints: [GATED_OBJECTIVE] });
		expect(j.park).toBe(false);
		if (j.park) return;
		expect(j.excluded.map((e) => e.option)).toEqual(["Close #243"]);
		expect(j.decision).not.toBe("Close #243");
	});

	it("nothing changes for a run whose objective does not gate closing, or for a question that is not about closing", () => {
		expect(judgeQuestion({ ...CLOSE_OR_KEEP, constraints: ["Fix the flaky E2E in #243 and close it when done."] })).toMatchObject({ park: false, decision: CLOSE_OR_KEEP.options[2] });
		expect(judgeQuestion({ ...CLOSE_OR_KEEP, constraints: [] })).toMatchObject({ decision: CLOSE_OR_KEEP.options[2] });
		const unrelated = judgeQuestion({ question: "Which table layout?", options: ["compact", "comfortable"], constraints: [GATED_OBJECTIVE, HINT] });
		expect(unrelated).toMatchObject({ park: false, decision: "compact", excluded: [] });
	});

	it("the guardrails still come first: a gated objective does not turn a credential question into a decision", () => {
		expect(judgeQuestion({ question: "Should I rotate the API key?", options: ["Yes", "No"], constraints: [GATED_OBJECTIVE] })).toMatchObject({ park: true, guardrail: "privileges" });
	});

	describe("through the real store: the objective is read from the run, and the decision explains itself", () => {
		let d1: RealSchemaD1;
		let env: Env;
		const posted: string[] = [];
		const ctx = (extra: Record<string, unknown> = {}) => ({
			runId: "run-g",
			instanceId: "i1",
			userId: "u1",
			round: 0,
			issue: { repo: "ChessClubs-online/chess-clubs", number: 243 },
			postComment: async (_r: string, _n: number, body: string) => {
				posted.push(body);
				return true;
			},
			now: 1_800_000_000_000,
			...extra,
		});
		const startRun = (objective: string) =>
			d1.sqlite.prepare("INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, questions_policy) VALUES ('run-g', 'u1', 'i1', ?, 'running', 10, 1, 'decide')").run(objective);

		beforeEach(() => {
			d1 = realSchemaD1();
			seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
			env = { DB: d1.DB } as unknown as Env;
			posted.length = 0;
		});
		afterEach(() => d1.close());

		it("a caller that passes nothing is still held to the objective stored on the run", async () => {
			startRun(GATED_OBJECTIVE);
			const out = await applyQuestionsPolicy(env, ctx(), CLOSE_OR_KEEP);
			expect(out).toMatchObject({ decided: true });
			expect(out.decided && out.note).toContain("Decision: Leave #243 open and report what failed");
			const [row] = await listQuestionDecisions(env, "u1", "run-g");
			expect(row).toMatchObject({ outcome: "decided", decision: "Leave #243 open and report what failed" });
			expect(row.excluded.map((e) => e.option)).toEqual([CLOSE_OR_KEEP.options[0], CLOSE_OR_KEEP.options[2]]);
		});

		it("the comment on the issue says which options were set aside and why — quoting the objective's own sentence", async () => {
			startRun(GATED_OBJECTIVE);
			await applyQuestionsPolicy(env, ctx(), CLOSE_OR_KEEP);
			expect(posted).toHaveLength(1);
			expect(posted[0]).toContain("**Decided:** Leave #243 open and report what failed");
			expect(posted[0]).toContain("Not considered:");
			expect(posted[0]).toContain("Close #243 as done and file a separate issue for the failing E2E — it closes, and the run's objective gates closing");
			expect(posted[0]).not.toContain("(they need you)"); // these options were set aside by the objective, not because they need the owner
		});

		it("a hint the run was given (carried by the goal, not the stored objective) gates it as well", async () => {
			startRun("Work #243 and report.");
			const out = await applyQuestionsPolicy(env, ctx({ constraintTexts: [undefined, HINT] }), CLOSE_OR_KEEP);
			expect(out).toMatchObject({ decided: true });
			expect(out.decided && out.note).toContain("Decision: Leave #243 open");
		});

		it("when every option would close, it parks, records why, and posts nothing", async () => {
			startRun(GATED_OBJECTIVE);
			const out = await applyQuestionsPolicy(env, ctx(), { question: "How do I finish?", options: ["Close #243 as done", "Close #243 and follow up"] });
			expect(out).toEqual({ decided: false });
			expect(posted).toEqual([]);
			const [row] = await listQuestionDecisions(env, "u1", "run-g");
			expect(row).toMatchObject({ outcome: "parked", guardrail: "objective_constraint", decision: null });
			expect(row.reason).toMatch(/gates closing/);
		});

		it("a run whose objective does not gate closing decides as before", async () => {
			startRun("Fix #243 and close it.");
			expect(await applyQuestionsPolicy(env, ctx(), CLOSE_OR_KEEP)).toMatchObject({ decided: true });
			const [row] = await listQuestionDecisions(env, "u1", "run-g");
			expect(row.decision).toBe(CLOSE_OR_KEEP.options[2]);
		});
	});
});
