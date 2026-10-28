/**
 * #1385 — where `questions: decide` meets the pause machine. A run that decides never parks, never pages the owner and never flips the card to
 * "needs you"; a run that does not (the default), and every kind of wait that is not a real question, behave exactly as before.
 */
import { describe, expect, it } from "vitest";
import { resolvePause, type PauseDeps } from "./coding-pause.js";
import type { CodingResult } from "./coding-loop.js";

const NOW = Date.parse("2026-10-28T03:00:00Z");
const question: CodingResult = { outcome: "needs_input", detail: "the issue asks for a denser list", fieldNeeded: "Which table layout?", options: ["compact", "comfortable"] } as CodingResult;

function harness(policy?: PauseDeps["questionPolicy"]) {
	const log = { takeovers: 0, asks: 0, notified: 0, announced: 0, cards: [] as string[], slept: 0, policyCalls: [] as Array<Parameters<NonNullable<PauseDeps["questionPolicy"]>>[0]> };
	const deps: PauseDeps = {
		reauthCompletedSince: async () => false,
		restartEngine: async () => {},
		repo: "acme/app",
		instanceId: "i1",
		taskId: "csess-s1",
		now: () => NOW,
		takeover: async () => void log.takeovers++,
		takeoverStatus: async () => ({ resolved: false }),
		endTakeover: async () => {},
		sleep: async () => void log.slept++,
		notify: async () => void log.notified++,
		announce: async () => void log.announced++,
		card: async (status) => void log.cards.push(status),
		tick: async () => log.slept < 3,
		ask: async () => {
			log.asks++;
			return undefined;
		},
		sourceIssue: async () => ({ status: "linked", issue: { repo: "acme/app", number: 394, title: "Fleet rollout", url: "https://github.com/acme/app/issues/394", summary: "" } }),
	};
	if (policy) {
		deps.questionPolicy = async (q) => {
			log.policyCalls.push(q);
			return policy(q);
		};
	}
	return { deps, log };
}
const fresh = { waits: 0, spentMs: 0 };

describe("resolvePause under `questions: decide`", () => {
	it("a decided question resumes the run at once with the platform's note — no takeover, no question on the card, no push, no sleep", async () => {
		const { deps, log } = harness(async () => ({ decided: true, note: "Decision: compact" }));
		const v = await resolvePause(deps, { round: 2, result: question, state: fresh });
		expect(v).toEqual({ resume: true, resumeNote: "Decision: compact" });
		expect(log).toMatchObject({ takeovers: 0, asks: 0, notified: 0, announced: 0, cards: [], slept: 0 });
	});

	it("the policy is shown the question as the owner would have been, with its options, round and linked issue", async () => {
		const { deps, log } = harness(async () => ({ decided: true, note: "n" }));
		await resolvePause(deps, { round: 2, result: question, state: fresh });
		expect(log.policyCalls).toEqual([{ round: 2, question: "Which table layout?", options: ["compact", "comfortable"], why: "the issue asks for a denser list", issue: { repo: "acme/app", number: 394 } }]);
	});

	it("the decision is the platform's, not the owner's: it rides `resumeNote`, never `userHint` or `ownerTurn`", async () => {
		const { deps } = harness(async () => ({ decided: true, note: "n" }));
		const v = await resolvePause(deps, { round: 0, result: question, state: fresh });
		expect(v).not.toHaveProperty("userHint");
		expect(v).not.toHaveProperty("ownerTurn");
	});

	it("a question the policy keeps parks exactly as before: the card, the question and the push", async () => {
		const { deps, log } = harness(async () => ({ decided: false }));
		const v = await resolvePause(deps, { round: 0, result: question, state: fresh });
		expect(v.resume).toBe(false);
		expect(log.takeovers).toBe(1);
		expect(log.asks).toBe(1);
		expect(log.notified).toBeGreaterThan(0);
	});

	it("a policy that throws is a park, never a lost question", async () => {
		const { deps, log } = harness(async () => {
			throw new Error("D1 is down");
		});
		const v = await resolvePause(deps, { round: 0, result: question, state: fresh });
		expect(v.resume).toBe(false);
		expect(log.asks).toBe(1);
	});

	it("only a real question is offered to the policy: a stuck handoff (the owner's computer) and the iteration-cap ask (spend) are never decided", async () => {
		for (const result of [{ outcome: "stuck", detail: "Not inside a trusted directory", steps: 2 }, { outcome: "max_steps", detail: "reached its cap", steps: 40 }] as CodingResult[]) {
			const { deps, log } = harness(async () => ({ decided: true, note: "must not happen" }));
			const v = await resolvePause(deps, { round: 0, result, state: fresh });
			expect(log.policyCalls, result.outcome).toEqual([]);
			expect(v.resume, result.outcome).toBe(false);
		}
	});

	it("a run without a policy (`ask`, the default) never consults one", async () => {
		const { deps, log } = harness();
		const v = await resolvePause(deps, { round: 0, result: question, state: fresh });
		expect(v.resume).toBe(false);
		expect(log.takeovers).toBe(1);
		expect(log.policyCalls).toEqual([]);
	});
});
