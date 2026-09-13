import { beforeEach, describe, expect, it, vi } from "vitest";

// The decider's model call is the thing under test for NOT happening, so it is the one mock.
const runUserWorkersAi = vi.fn();
vi.mock("./user-ai.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./user-ai.js")>()),
	runUserWorkersAi: (...a: unknown[]) => runUserWorkersAi(...a),
}));

import { nextStep, readAgentReply } from "./agent-loop.js";
import { runLoopDecide, settledDecision } from "./loop-orchestrator.js";
import { UserAiCredentialsError } from "./user-ai.js";
import type { Env } from "../types.js";

// The provider's live sentence, as `user-ai.test.ts` pins it, in the frame `user-ai.ts` throws it in.
const CREDIT = "Anthropic (400): Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits. — Insufficient Anthropic credit balance. Top up at console.anthropic.com/settings/billing";
const BAD_KEY = "Anthropic (401): invalid x-api-key — Invalid API key. Update it in Profile → API Keys → Anthropic";

/** A transcript whose last turn is what the durable loop records when AgentDO `/chat` returns `{ error }`. */
function failedTurn(error: string) {
	return [
		{ role: "user", content: "Fix the failing test." },
		{ role: "assistant", content: readAgentReply({ error }) },
	];
}

function fakeEnv() {
	const writes: unknown[][] = [];
	const env = {
		DB: {
			prepare: (sql: string) => ({
				bind: (...args: unknown[]) => ({
					run: async () => {
						writes.push([sql, ...args]);
						return { success: true };
					},
				}),
			}),
		},
	} as unknown as Env;
	return { env, writes };
}

describe("settledDecision — the one outcome the transcript already decides (#768)", () => {
	it.each([
		["an exhausted Anthropic balance", CREDIT],
		["a rejected Anthropic key", BAD_KEY],
		["no key at all", "Add an API key in Profile → API Keys (Anthropic or Cloudflare Workers AI)."],
		["missing Workers AI credentials", new UserAiCredentialsError().message],
		["a rejected Workers AI token", "Cloudflare Workers AI request failed with HTTP 401"],
	])("escalates without a model on %s", (_label, error) => {
		const settled = settledDecision({ messages: failedTurn(error) });
		expect(settled?.decision).toBe("escalate");
		expect(settled?.nextInstruction).toBe("");
		expect(settled?.reason).toContain("Every further step would fail the same way");
	});

	it("names the remedy the rest of the platform names for that class", () => {
		expect(settledDecision({ messages: failedTurn(CREDIT) })?.reason).toContain("console.anthropic.com/settings/billing");
		expect(settledDecision({ messages: failedTurn(BAD_KEY) })?.reason).toContain("only the owner can clear it");
	});

	it.each([
		// A transport drop is retryable: the next act may well succeed, so the orchestrator decides.
		["a provider stall", "Anthropic: the model stopped sending mid-reply"],
		["a rate limit", "Anthropic (429): rate_limit_error"],
		["a model the key cannot reach", "Anthropic (404): model not found — Your API key may not have access to this model."],
		// The guard PROVIDER_FRAMED exists for: the classifier reads any `(403)` as a rejected key.
		["a tool's 403", "GitHub (403): Resource not accessible by integration"],
		["an unclassified DO error", "Not initialized"],
	])("leaves %s to the orchestrator", (_label, error) => {
		expect(settledDecision({ messages: failedTurn(error) })).toBeNull();
	});

	it("never reads what the agent SAID — prose about credit is the orchestrator's to judge", () => {
		const messages = [
			{ role: "user", content: "Check the billing page." },
			{ role: "assistant", content: `The page says: ${CREDIT}` },
		];
		expect(settledDecision({ messages })).toBeNull();
	});

	it("reads only the last turn, and only an assistant turn", () => {
		const recovered = [...failedTurn(CREDIT), { role: "user", content: "Topped up, go on." }, { role: "assistant", content: "Done." }];
		expect(settledDecision({ messages: recovered })).toBeNull();
		expect(settledDecision({ messages: [{ role: "user", content: readAgentReply({ error: CREDIT }) }] })).toBeNull();
		expect(settledDecision({ messages: [] })).toBeNull();
	});

	it("stops the durable loop in the needs-a-human column, not as a continue", () => {
		const settled = settledDecision({ messages: failedTurn(CREDIT) });
		if (!settled) throw new Error("expected a settled decision");
		const verdict = nextStep({ iteration: 1, maxIterations: 10, recentInstructions: [] }, settled, failedTurn(CREDIT)[1].content);
		expect(verdict.continue).toBe(false);
		expect(verdict.stopReason).toBe("escalated");
	});
});

describe("runLoopDecide — the second model call is skipped only when it cannot matter", () => {
	beforeEach(() => runUserWorkersAi.mockReset());

	it("does not call the model on a provider-account failure, and leaves a trace event instead", async () => {
		const { env, writes } = fakeEnv();
		const decision = await runLoopDecide(env, "u1", "inst1", {
			objective: "Fix the failing test.",
			messages: failedTurn(CREDIT),
			iteration: 2,
			maxIterations: 10,
			traceId: "run-1",
		});
		expect(runUserWorkersAi).not.toHaveBeenCalled();
		expect(decision.decision).toBe("escalate");
		const event = writes.find((w) => String(w[0]).startsWith("INSERT INTO agent_events"));
		expect(event).toBeDefined();
		// bind order: id, ts, user_id, instance_id, trace_id, source, level, event, message, context
		expect(event?.slice(3, 9)).toEqual(["u1", "inst1", "run-1", "loop", "warn", "loop.decide_skipped"]);
	});

	it("still asks the model on an ordinary turn", async () => {
		const { env } = fakeEnv();
		runUserWorkersAi.mockResolvedValue({ response: '{"decision":"done","nextInstruction":"","reason":"Tests pass."}' });
		const decision = await runLoopDecide(env, "u1", "inst1", {
			objective: "Fix the failing test.",
			messages: [
				{ role: "user", content: "Fix the failing test." },
				{ role: "assistant", content: "Fixed — all tests pass." },
			],
			iteration: 1,
			maxIterations: 10,
		});
		expect(runUserWorkersAi).toHaveBeenCalledTimes(1);
		expect(decision).toEqual({ decision: "done", nextInstruction: "", reason: "Tests pass." });
	});

	it("still asks the model on a retryable failure", async () => {
		const { env } = fakeEnv();
		runUserWorkersAi.mockResolvedValue({ response: '{"decision":"continue","nextInstruction":"Try again.","reason":""}' });
		await runLoopDecide(env, "u1", "inst1", {
			objective: "Fix the failing test.",
			messages: failedTurn("Anthropic: the model stopped sending mid-reply"),
			iteration: 1,
			maxIterations: 10,
		});
		expect(runUserWorkersAi).toHaveBeenCalledTimes(1);
	});
});
