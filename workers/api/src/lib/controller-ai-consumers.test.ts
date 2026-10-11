/**
 * The Loop orchestrator and the Co-pilot under the controller recovery policy (#907) — the two
 * controller consumers outside the Pilot workflow, driven through their real entry points with only
 * the provider call simulated (synthetic text; no prompt, reply or pane content from a real session).
 *
 * Invariants protected: a stall is retried and the decision still arrives; each attempt carries the
 * policy's deadlines; a non-stall error is not retried; exhaustion is reported as the controller's
 * provider stalling — never as a CLI, runner, credit or code failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runUserWorkersAi = vi.fn();
vi.mock("./user-ai.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./user-ai.js")>()),
	runUserWorkersAi: (...a: unknown[]) => runUserWorkersAi(...a),
}));

import { copilotSummary } from "./coding-copilot.js";
import { setControllerAiSleepForTest } from "./controller-ai-recovery.js";
import { runLoopDecide } from "./loop-orchestrator.js";
import { UserAiProviderError } from "./user-ai.js";
import type { Env } from "../types.js";

const env = {
	DB: { prepare: () => ({ bind: () => ({ run: async () => ({ success: true }), first: async () => null }) }) },
} as unknown as Env;
const stall = () => Object.assign(new UserAiProviderError("The AI provider stopped sending mid-reply — 45s with no bytes received.", 504, undefined, undefined, true), { provider: "anthropic", model: "claude-sonnet-4-6" });
const decideInput = { objective: "make the suite green", iteration: 1, maxIterations: 5, messages: [{ role: "user", content: "go" }, { role: "assistant", content: "working on it" }] };

beforeEach(() => {
	runUserWorkersAi.mockReset();
	setControllerAiSleepForTest(async () => undefined);
});
afterEach(() => setControllerAiSleepForTest(null));

describe("the Loop orchestrator (#907)", () => {
	it("recovers a stalled decision and passes each attempt the policy's deadlines", async () => {
		runUserWorkersAi.mockRejectedValueOnce(stall()).mockResolvedValueOnce({ response: '{"decision":"continue","nextInstruction":"run the tests","reason":"not done"}' });
		const out = await runLoopDecide(env, "u1", "inst1", decideInput);
		expect(out).toMatchObject({ decision: "continue", nextInstruction: "run the tests" });
		expect(runUserWorkersAi).toHaveBeenCalledTimes(2);
		expect((runUserWorkersAi.mock.calls[0][3] as { streamDeadlines: unknown }).streamDeadlines).toEqual({ preContentMs: 60_000, silenceMs: 45_000, totalMs: 240_000 });
	});

	it("does not retry a non-stall failure", async () => {
		runUserWorkersAi.mockRejectedValue(new UserAiProviderError("Anthropic (529): overloaded", 502, 529, undefined, false));
		const out = await runLoopDecide(env, "u1", "inst1", decideInput);
		expect(runUserWorkersAi).toHaveBeenCalledTimes(1);
		expect(out.decision).toBe("escalate");
	});

	it("on exhaustion escalates with the controller-provider sentence, after the bounded attempts", async () => {
		runUserWorkersAi.mockRejectedValue(stall());
		const out = await runLoopDecide(env, "u1", "inst1", decideInput);
		expect(runUserWorkersAi).toHaveBeenCalledTimes(4);
		expect(out).toMatchObject({ decision: "escalate", nextInstruction: "" });
		expect(out.reason).toContain("controller's AI provider stalled");
	});
});

describe("the Co-pilot (#907)", () => {
	it("recovers a stalled summary and still answers", async () => {
		runUserWorkersAi.mockRejectedValueOnce(stall()).mockResolvedValueOnce({ response: "The engine is running the test suite." });
		const reply = await copilotSummary(env, "u1", { pane: "synthetic pane line", instanceId: "inst1", sessionId: "s1" });
		expect(reply).toContain("running the test suite");
		expect(runUserWorkersAi).toHaveBeenCalledTimes(2);
		expect((runUserWorkersAi.mock.calls[1][3] as { streamDeadlines: { silenceMs: number } }).streamDeadlines.silenceMs).toBe(45_000);
	});

	it("surfaces exhaustion as the controller's provider stalling, not a CLI or runner problem", async () => {
		runUserWorkersAi.mockRejectedValue(stall());
		const err = (await copilotSummary(env, "u1", { pane: "synthetic", instanceId: "inst1", sessionId: "s1" }).catch((e: unknown) => e)) as Error;
		expect(runUserWorkersAi).toHaveBeenCalledTimes(4);
		expect(err.message).toContain("controller's AI provider stalled on 4 attempts");
		expect(err.message).toContain("coding CLI, the runner and the repository were not involved");
	});
});
