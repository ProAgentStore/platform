/**
 * The coder brain (#1025) on the real schema: capture, the minute sweep's state machine, human
 * precedence, the guardrails and the switch. GitHub, notifications, delivery and the model are the
 * only fakes — the timers are rows, and every tick below is a fresh sweep call (no memory between).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { coderBrainFrom, readCoderBrain, setCoderBrain } from "./coder-brain.js";
import { type DecisionContext, GUARDRAILS, declineAfterModel, declineBeforeModel, decideCoderQuestion, parseBrainReply } from "./coder-brain-decide.js";
import { getCoderQuestion, markHumanAnswered } from "./coder-question-store.js";
import { type CoderQuestionEffects, HUMAN_ONLY_WAIT_MS, captureAndAnnounceQuestion, runDueCoderQuestions } from "./coder-question-sweep.js";
import type { Env } from "../types.js";

const MIN = 60_000;
let d1: RealSchemaD1;
let env: Env;

const CTX: DecisionContext = {
	question: "Which table layout?",
	options: ["compact", "comfortable"],
	why: "The issue asks for a denser list",
	repo: "acme/app",
	issue: { number: 7, title: "Denser fixtures list", body: "Acceptance criteria: use the compact layout.", labels: [] },
	comments: [],
	claudeMd: null,
};
const DECIDE = JSON.stringify({ decision: "compact", confidence: 0.92, reason: "The issue's acceptance criteria say compact.", options_considered: ["compact", "comfortable"] });

function fakes(over: { reply?: string; ctx?: Partial<DecisionContext>; onModel?: () => Promise<void> | void; pro?: string | null } = {}) {
	const log = { comments: [] as string[], notified: [] as Array<{ title: string; alert: boolean }>, delivered: [] as string[], modelCalls: 0, audit: [] as string[] };
	const effects: Partial<CoderQuestionEffects> = {
		postComment: async (_q, body) => {
			log.comments.push(body);
			return true;
		},
		notify: async (_q, title, _body, alert) => {
			log.notified.push({ title, alert });
		},
		deliver: async (_q, value) => {
			log.delivered.push(value);
		},
		context: async (q) => ({ ...CTX, question: q.question, options: q.options, ...over.ctx }),
		model: () => async () => {
			log.modelCalls++;
			await over.onModel?.();
			return over.reply ?? DECIDE;
		},
		proRefusal: async () => over.pro ?? null,
		audit: async (_q, line) => {
			log.audit.push(line);
		},
	};
	return { effects, log };
}

const ask = (effects: Partial<CoderQuestionEffects>) =>
	captureAndAnnounceQuestion(env, { instanceId: "coder", userId: "u1", sessionId: "s1", runId: "run-1", taskId: "csess-s1", question: "Which table layout?", options: ["compact", "comfortable"], why: "denser list" }, effects as CoderQuestionEffects);
const state = async (id: string) => (await getCoderQuestion(env, id))?.state;
const atAsk = (q: { askedAt: number }) => q.askedAt;

beforeEach(async () => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["coder"] });
	d1.exec("INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES ('repo-1', 'coder', 'u1', 'app', 'acme/app')");
	d1.exec("INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, issue_number) VALUES ('s1', 'coder', 'repo-1', 'u1', 7)");
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

describe("AC1 — brain off: the human is told and nothing else happens", () => {
	it("records the question, posts it on the issue, waits the usual 15 minutes, and the sweep never decides", async () => {
		const { effects, log } = fakes();
		const { question, waitMs } = await ask(effects);
		expect(waitMs).toBe(HUMAN_ONLY_WAIT_MS);
		expect(question).toMatchObject({ state: "waiting_human", repo: "acme/app", issueNumber: 7, runId: "run-1" });
		expect(log.comments).toHaveLength(1);
		expect(log.comments[0]).toMatch(/The coder stopped on a question:\*\* Which table layout\?/);
		await runDueCoderQuestions(env, atAsk(question) + 14 * MIN, effects);
		expect(log.modelCalls).toBe(0);
		expect(log.delivered).toEqual([]);
		// When the run stops waiting, the question expires — still nothing decided.
		await runDueCoderQuestions(env, question.expiresAt + 1, effects);
		expect(await state(question.id)).toBe("expired");
		expect(log.modelCalls).toBe(0);
	});

	it("a replayed ask records one question and one comment", async () => {
		const { effects, log } = fakes();
		const a = await ask(effects);
		const b = await ask(effects);
		expect(b.question.id).toBe(a.question.id);
		expect(log.comments).toHaveLength(1);
	});
});

describe("brain on", () => {
	beforeEach(async () => {
		await setCoderBrain(env, "coder", "u1", { enabled: true, humanTimeoutMinutes: 30, escalationTimeoutMinutes: 60 });
	});

	it("waits both timeouts plus a margin, and says the brain may decide", async () => {
		const { effects, log } = fakes();
		const { waitMs, humanMs } = await ask(effects);
		expect(humanMs).toBe(30 * MIN);
		expect(waitMs).toBe(100 * MIN);
		expect(log.comments[0]).toMatch(/within 30 minutes, the coder brain may decide/);
	});

	it("AC2 — a human answer before the timeout: the brain never runs", async () => {
		const { effects, log } = fakes();
		const { question } = await ask(effects);
		expect(await markHumanAnswered(env, "coder", "s1")).toBe(question.id);
		await runDueCoderQuestions(env, atAsk(question) + 31 * MIN, effects);
		expect(log.modelCalls).toBe(0);
		expect(await getCoderQuestion(env, question.id)).toMatchObject({ state: "answered_human", answeredBy: "human" });
	});

	it("nothing happens before the human timeout", async () => {
		const { effects, log } = fakes();
		const { question } = await ask(effects);
		await runDueCoderQuestions(env, atAsk(question) + 29 * MIN, effects);
		expect(log.modelCalls).toBe(0);
		expect(await state(question.id)).toBe("waiting_human");
	});

	it("AC3 — no answer: after the timeout the brain decides, delivers through the answer path, comments and notifies", async () => {
		const { effects, log } = fakes();
		const { question } = await ask(effects);
		const r = await runDueCoderQuestions(env, atAsk(question) + 31 * MIN, effects);
		expect(r.decided).toBe(1);
		expect(log.delivered).toEqual([expect.stringMatching(/^Decided by the coder brain .*: compact\. Reason: The issue's acceptance criteria say compact\./)]);
		expect(log.comments[1]).toMatch(/Decided by coder brain:\*\* compact[\s\S]*Reason:\*\* The issue's acceptance criteria[\s\S]*Options considered:\*\* compact, comfortable/);
		expect(log.notified).toEqual([{ title: "🧠 Coder brain decided", alert: false }]);
		const q = await getCoderQuestion(env, question.id);
		expect(q).toMatchObject({ state: "answered_brain", answeredBy: "brain", decision: "compact", confidence: 0.92, model: "claude-sonnet-4-6" });
		expect(q?.promptHash).toMatch(/^[0-9a-f]{8}$/);
		expect(q?.history.map((h) => h.to)).toEqual(["waiting_human", "brain_deciding", "answered_brain"]);
		// A later tick does nothing more.
		await runDueCoderQuestions(env, atAsk(question) + 40 * MIN, effects);
		expect(log.modelCalls).toBe(1);
	});

	it("AC3 — or it declines: escalated, a louder notification, and an issue comment with the reason", async () => {
		const { effects, log } = fakes({ reply: JSON.stringify({ declined: true, reason: "the issue does not settle it" }) });
		const { question } = await ask(effects);
		const r = await runDueCoderQuestions(env, atAsk(question) + 31 * MIN, effects);
		expect(r.escalated).toBe(1);
		expect(log.delivered).toEqual([]);
		expect(log.comments[1]).toMatch(/could not decide\*\* because the model declined: the issue does not settle it/);
		expect(log.notified).toEqual([{ title: "⚠️ Coder still needs your answer", alert: true }]);
		expect(await state(question.id)).toBe("escalated");
	});

	it("AC4 — escalated and still unanswered: the coder is told to finish what it can, commit to main and close the issue", async () => {
		const { effects, log } = fakes({ reply: "{\"declined\": true, \"reason\": \"owner call\"}" });
		const { question } = await ask(effects);
		await runDueCoderQuestions(env, atAsk(question) + 31 * MIN, effects);
		await runDueCoderQuestions(env, atAsk(question) + 31 * MIN + 59 * MIN, effects);
		expect(await state(question.id)).toBe("escalated");
		const r = await runDueCoderQuestions(env, atAsk(question) + 31 * MIN + 61 * MIN, effects);
		expect(r.unresolved).toBe(1);
		expect(log.delivered).toHaveLength(1);
		expect(log.delivered[0]).toMatch(/Do NOT decide it yourself.*commit straight to main \(no branches, no pull requests\).*close issue #7 with a comment containing: the question; the options \(compact, comfortable\); why the brain declined; what was done \(the commit SHAs\); what is left; and the exact decision needed/);
		expect(log.comments.at(-1)).toMatch(/Decision unresolved/);
		expect(log.notified.at(-1)).toEqual({ title: "⏹ Coder question unresolved", alert: true });
		expect(await state(question.id)).toBe("unresolved");
	});

	it("a human answer wins even while the brain is deciding — the decision is discarded, never delivered", async () => {
		const { effects, log } = fakes({ onModel: async () => void (await markHumanAnswered(env, "coder", "s1")) });
		const { question } = await ask(effects);
		const id = question.id;
		await runDueCoderQuestions(env, question.askedAt + 31 * MIN, effects);
		expect(log.modelCalls).toBe(1);
		expect(log.delivered).toEqual([]);
		expect(await state(id)).toBe("answered_human");
		expect(log.audit.some((l) => /brain's decision was discarded/.test(l))).toBe(true);
	});

	it("AC7 — timers live in the row: a fresh sweep after a 'restart' acts on the same deadlines", async () => {
		const { question } = await ask(fakes().effects);
		// Nothing in memory carries over: a brand-new effects object, a brand-new sweep call.
		const later = fakes();
		await runDueCoderQuestions(env, question.askedAt + 31 * MIN, later.effects);
		expect(later.log.modelCalls).toBe(1);
		expect(await state(question.id)).toBe("answered_brain");
	});

	it("a paused instance, the Pro gate, or the brain switched off mid-wait: no brain decision", async () => {
		const a = fakes();
		const { question } = await ask(a.effects);
		d1.exec("UPDATE agent_instances SET status = 'paused' WHERE id = 'coder'");
		await runDueCoderQuestions(env, question.askedAt + 31 * MIN, a.effects);
		expect(a.log.modelCalls).toBe(0);
		d1.exec("UPDATE agent_instances SET status = 'active' WHERE id = 'coder'");
		await setCoderBrain(env, "coder", "u1", { enabled: false });
		await runDueCoderQuestions(env, question.askedAt + 31 * MIN, a.effects);
		expect(a.log.modelCalls).toBe(0);
		expect(await state(question.id)).toBe("waiting_human"); // left with the human
		await setCoderBrain(env, "coder", "u1", { enabled: true });
		const pro = fakes({ pro: "Upgrade to Pro" });
		await runDueCoderQuestions(env, question.askedAt + 31 * MIN, pro.effects);
		expect(pro.log.modelCalls).toBe(0);
		expect(await getCoderQuestion(env, question.id)).toMatchObject({ state: "escalated", reason: expect.stringMatching(/needs Pro/) });
	});

	it("max_decisions_per_run: past the cap the brain declines without calling the model", async () => {
		await setCoderBrain(env, "coder", "u1", { maxDecisionsPerRun: 1 });
		d1.exec("INSERT INTO coder_questions (id, instance_id, user_id, session_id, run_id, question, state, asked_at, expires_at, answered_by) VALUES ('old', 'coder', 'u1', 's1', 'run-1', 'earlier', 'answered_brain', 1, 2, 'brain')");
		const { effects, log } = fakes();
		const { question } = await ask(effects);
		await runDueCoderQuestions(env, question.askedAt + 31 * MIN, effects);
		expect(log.modelCalls).toBe(0);
		expect(await getCoderQuestion(env, question.id)).toMatchObject({ state: "escalated", reason: expect.stringMatching(/already had 1 brain decision/) });
	});
});

describe("AC5 — the guardrails, enforced in code", () => {
	const limits = { decisionsSoFar: 0, maxDecisions: 3, threshold: 0.8 };
	const run = async (ctx: Partial<DecisionContext>, reply = DECIDE) => {
		let called = 0;
		const out = await decideCoderQuestion({ ...CTX, ...ctx }, limits, async () => {
			called++;
			return reply;
		});
		return { out, called };
	};

	it("a needs-human issue is declined before the model runs", async () => {
		const { out, called } = await run({ issue: { ...CTX.issue!, labels: ["needs-human"] } });
		expect(out).toMatchObject({ decided: false, reason: expect.stringMatching(/labelled "needs-human"/) });
		expect(called).toBe(0);
	});

	for (const [id, question] of [
		["owner_only", "What should the Pro pricing be?"],
		["privileges", "Should I add the deploy token to the repo secrets?"],
		["money", "Which payout schedule should creators get?"],
		["destructive", "Can I delete the old users table?"],
		["delivery_mode", "Should I open a pull request or push a branch?"],
	] as const) {
		it(`${id}: declined before the model runs ("${question}")`, async () => {
			const { out, called } = await run({ question, options: [] });
			expect(out.decided).toBe(false);
			expect(called).toBe(0);
			expect((out as { reason: string }).reason).toBe(GUARDRAILS.find((g) => g.id === id)?.why);
		});
	}

	it("the model's own answer is checked again: a guarded decision, a low confidence, an off-list option", () => {
		expect(declineAfterModel({ decision: "Delete the data", confidence: 0.95, reason: "", optionsConsidered: [] }, [], 0.8)).toMatch(/would delete data/);
		expect(declineAfterModel({ decision: "compact", confidence: 0.6, reason: "", optionsConsidered: [] }, ["compact"], 0.8)).toMatch(/below the threshold 0.8/);
		expect(declineAfterModel({ decision: "huge", confidence: 0.95, reason: "", optionsConsidered: [] }, ["compact", "comfortable"], 0.8)).toMatch(/not one of the options/);
		expect(declineAfterModel({ decision: "compact", confidence: 0.95, reason: "AC says so", optionsConsidered: [] }, ["compact"], 0.8)).toBeNull();
	});

	it("an unparseable or declining reply declines; a threshold change flips the outcome", async () => {
		expect((await run({}, "I think compact")).out.decided).toBe(false);
		expect(parseBrainReply('{"declined": true, "reason": "unclear"}')).toEqual({ declined: "the model declined: unclear" });
		const ok = await decideCoderQuestion(CTX, { ...limits, threshold: 0.9 }, async () => DECIDE);
		const strict = await decideCoderQuestion(CTX, { ...limits, threshold: 0.95 }, async () => DECIDE);
		expect([ok.decided, strict.decided]).toEqual([true, false]);
		expect(declineBeforeModel(CTX, 3, 3)).toMatch(/limit is 3/);
	});
});

describe("AC6 — one writer, one reader", () => {
	it("the writer validates; the reader clamps a stored stray to the defaults", async () => {
		await expect(setCoderBrain(env, "coder", "u1", { humanTimeoutMinutes: 0 })).rejects.toThrow(/humanTimeoutMinutes/);
		await expect(setCoderBrain(env, "coder", "u1", { model: "gpt-x" } as never)).rejects.toThrow(/model/);
		expect(coderBrainFrom({ coderBrain: { enabled: true, humanTimeoutMinutes: -5, confidenceThreshold: 7, model: "nope" } })).toMatchObject({ enabled: true, humanTimeoutMinutes: 30, confidenceThreshold: 0.8, model: "claude-sonnet-4-6" });
		expect(await readCoderBrain(env, "coder", "u1")).toMatchObject({ enabled: false, poEnabled: false, humanTimeoutMinutes: 30, escalationTimeoutMinutes: 60, maxDecisionsPerRun: 3 });
	});
});
