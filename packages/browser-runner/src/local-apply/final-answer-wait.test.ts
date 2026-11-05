import { describe, expect, it } from "vitest";
import { finalAnswerLease, finalAnswerPageAvailable, finalAnswerTimeout, readFinalAnswerPage, resumeAnswerSources, waitForFinalAnswers, type FinalAnswerPauseOptions } from "./final-answer-wait.js";
import type { LocalApplyPause } from "./contract.js";

const pause = (): LocalApplyPause => ({ reason: "missing_answer", question: "Licence number?", handoffRequestId: "epoch-1", answerWait: { kind: "final_review", expiresAt: 10_000, budgetMs: 9000, questions: ["Licence number?", "Start date?"] } });
describe("final-review exact-answer handoff", () => {
	it("keeps one absolute configured MCP budget through partial responses and deferred replay", async () => {
		let now = 0; const pending = ["Licence number?", "Start date?"];
		const sources: Array<{ text: string; answerQuestion?: string; answerText?: string }> = [{ text: "Historical", answerQuestion: pending[0], answerText: "stale" }];
		const epochs: FinalAnswerPauseOptions[] = []; const finished: unknown[] = [];
		const outcome = await waitForFinalAnswers({ questions: () => pending, sources: () => sources, stopped: () => false, now: () => now, maxMinutes: 20,
			started: (options) => { epochs.push(options); }, finished: (...args) => finished.push(args),
			wait: async (question, options) => { epochs.push(options); now += 500_000; sources.push({ text: "Owner answer", answerQuestion: question, answerText: "current" }); return true; },
			answered: (question) => { pending.splice(pending.indexOf(question), 1); },
		});
		expect(outcome).toBe("answered"); expect(pending).toEqual([]);
		expect(new Set(epochs.map((entry) => entry.finalReviewAnswers.key)).size).toBe(1);
		expect(epochs.map((entry) => entry.finalReviewAnswers.expiresAt)).toEqual([1_080_000, 1_080_000, 1_080_000]);
		expect(finished).toEqual([[epochs[0]!.finalReviewAnswers.key, false]]);
	});
	it("does not clear a question from unrelated new source text or a historical answer", async () => {
		const questions = ["Licence number?"]; const sources = [{ text: "Old", answerQuestion: questions[0], answerText: "old" }];
		const outcome = await waitForFinalAnswers({ questions: () => questions, sources: () => sources, stopped: () => false, now: () => 0, maxMinutes: 20, started: () => {}, finished: () => {}, answered: () => { throw new Error("Unrelated source cleared a blocker"); }, wait: async () => { sources.push({ text: "New", answerQuestion: "Other question?", answerText: "unrelated" }); return true; } });
		expect(outcome).toBe("unanswered"); expect(questions).toEqual(["Licence number?"]);
	});
	it("anchors the lease before a delayed first replay and retains unanswered blockers after expiry", async () => {
		let now = 0; let lease: ReturnType<typeof finalAnswerLease> | undefined; let stopped = false;
		const questions = ["Licence number?"]; const page = { isClosed: () => false };
		const outcome = await waitForFinalAnswers({ questions: () => questions, sources: () => [], stopped: () => stopped, now: () => now, maxMinutes: 1,
			started: (options) => { lease = finalAnswerLease(undefined, options, page); }, finished: (_key, expired) => { expect(expired).toBe(true); }, answered: () => { throw new Error("Expired answer applied"); },
			wait: async (_question, options) => { expect(lease?.expiresAt).toBe(54_000); now = 54_000; stopped = !!finalAnswerTimeout(lease, now, questions); expect(finalAnswerLease(lease, options, page)).toBe(lease); return true; },
		});
		expect(outcome).toBe("stopped"); expect(questions).toEqual(["Licence number?"]);
		expect(finalAnswerTimeout(lease, now, questions)).toMatchObject({ outcome: "blocked", blockReason: "incomplete", questions });
	});
	it.each([
		{ key: "old-epoch", answers: [{ question: "Licence number?", answer: "123" }], now: 0 },
		{ key: "epoch-1", answers: [], now: 0 },
		{ key: "epoch-1", answers: [{ question: "Other?", answer: "123" }], now: 0 },
		{ key: "epoch-1", answers: [{ question: "Licence number?", answer: " " }], now: 0 },
		{ key: "epoch-1", answers: [{ question: "Licence number?", answer: "123" }, { question: "Licence number?", answer: "456" }], now: 0 },
		{ key: "epoch-1", answers: [{ question: "Licence number?", answer: "123" }], now: 10_000 },
	])("rejects the entire invalid or stale batch before constructing sources: %j", ({ key, answers, now }) => { expect(() => resumeAnswerSources(answers, pause(), key, now)).toThrow(); });
	it("does not replace an active final-review call or its absolute lease", async () => {
		const owner = {}; const questions = ["Licence number?"]; const sources: Array<{ text: string; answerQuestion?: string; answerText?: string }> = [];
		let release!: (value: boolean) => void; let starts = 0, finishes = 0;
		const input = { owner, questions: () => questions, sources: () => sources, stopped: () => false, now: () => 0, maxMinutes: 20,
			started: () => { starts++; }, finished: () => { finishes++; }, answered: (question: string) => { questions.splice(questions.indexOf(question), 1); }, wait: async () => new Promise<boolean>((resolve) => { release = resolve; }),
		};
		const first = waitForFinalAnswers(input); expect(await waitForFinalAnswers({ ...input })).toBe("busy"); expect(starts).toBe(1); expect(finishes).toBe(0);
		sources.push({ text: "Current owner answer", answerQuestion: "Licence number?", answerText: "REG-123" }); release(true);
		expect(await first).toBe("answered"); expect(finishes).toBe(1);
	});
	it("rejects a duplicate answer epoch in the running gap, and accepts partial exact current answers", () => {
		expect(() => resumeAnswerSources([{ question: "Licence number?", answer: "123" }], undefined, "epoch-1", 0)).toThrow(/no longer current/);
		expect(resumeAnswerSources([{ question: "Licence number?", answer: " 123 " }], pause(), "epoch-1", 0)).toEqual([{ label: "owner answers", text: "Q: Licence number?\nA: 123", answerQuestion: "Licence number?", answerText: "123" }]);
	});
	it("requires the same still-live page object", () => {
		expect(readFinalAnswerPage(() => { throw new Error("Unavailable adapter"); })).toBeNull();
		const page = { isClosed: () => false }; const lease = finalAnswerLease(undefined, { finalReviewAnswers: { key: "k", expiresAt: 10_000, budgetMs: 9000, questions: [] } }, page);
		expect(finalAnswerPageAvailable(lease, page)).toBe(true); expect(finalAnswerPageAvailable(lease, { isClosed: () => false })).toBe(false);
		page.isClosed = () => true; expect(finalAnswerPageAvailable(lease, page)).toBe(false);
	});
});
