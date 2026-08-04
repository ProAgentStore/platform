import { describe, expect, it } from "vitest";
import {
	instructionKey,
	isStuck,
	MAX_ITERATIONS_CAP,
	needsHuman,
	nextStep,
	NO_PROGRESS_REPEATS,
	readAgentReply,
	sanitizeMaxIterations,
	statusFor,
	type LoopState,
} from "./agent-loop.js";

const state = (over: Partial<LoopState> = {}): LoopState => ({
	iteration: 1,
	maxIterations: 10,
	recentInstructions: [],
	...over,
});

const dec = (decision: "continue" | "done" | "escalate" | "failed", nextInstruction = "", reason = "") => ({
	decision,
	nextInstruction,
	reason,
});

describe("sanitizeMaxIterations", () => {
	it("clamps to a cap a durable runner can honour", () => {
		expect(sanitizeMaxIterations(9999)).toBe(MAX_ITERATIONS_CAP);
		expect(sanitizeMaxIterations(0)).toBe(1);
		expect(sanitizeMaxIterations(-3)).toBe(1);
	});

	it("defaults junk rather than throwing", () => {
		expect(sanitizeMaxIterations("lots")).toBe(10);
		expect(sanitizeMaxIterations(undefined)).toBe(10);
		expect(sanitizeMaxIterations(NaN)).toBe(10);
	});

	it("keeps a sensible request", () => {
		expect(sanitizeMaxIterations(25)).toBe(25);
	});
});

describe("instructionKey", () => {
	it("ignores whitespace and case so trivial reformatting still counts as a repeat", () => {
		expect(instructionKey("Run   the TESTS ")).toBe(instructionKey("run the tests"));
	});

	it("separates genuinely different instructions", () => {
		expect(instructionKey("run the tests")).not.toBe(instructionKey("fix the build"));
	});
});

describe("isStuck", () => {
	it("is false before there is enough history to judge", () => {
		expect(isStuck(["a", "a"])).toBe(false);
	});

	it("fires on N identical instructions in a row", () => {
		expect(isStuck(Array(NO_PROGRESS_REPEATS).fill("a"))).toBe(true);
	});

	it("resets when the loop does something different", () => {
		expect(isStuck(["a", "a", "b"])).toBe(false);
	});

	it("only looks at the tail, so an early repeat does not condemn a progressing run", () => {
		expect(isStuck(["a", "a", "a", "b", "c"])).toBe(false);
	});
});

describe("nextStep", () => {
	it("continues with the model's next instruction", () => {
		const v = nextStep(state(), dec("continue", "run the tests"));
		expect(v).toMatchObject({ continue: true, nextInstruction: "run the tests" });
	});

	it("honours a terminal decision BEFORE the iteration cap", () => {
		// A run that genuinely finished on its last allowed iteration must report "done", not the
		// misleading "max_iterations".
		const v = nextStep(state({ iteration: 10, maxIterations: 10 }), dec("done", "", "all green"));
		expect(v.stopReason).toBe("done");
		expect(v.message).toBe("all green");
	});

	it("stops at the iteration cap when the model wants to continue", () => {
		const v = nextStep(state({ iteration: 10, maxIterations: 10 }), dec("continue", "keep going"));
		expect(v.stopReason).toBe("max_iterations");
		expect(v.continue).toBe(false);
	});

	it("stops on continue-with-no-instruction rather than spinning at full cost", () => {
		const v = nextStep(state(), dec("continue", "   "));
		expect(v.stopReason).toBe("no_progress");
	});

	it("stops a loop repeating the same instruction", () => {
		// Does not rely on the model noticing its own repetition.
		const key = instructionKey("run the tests");
		const v = nextStep(state({ recentInstructions: [key, key] }), dec("continue", "run the tests"));
		expect(v.stopReason).toBe("no_progress");
		expect(v.message).toContain("repeated");
	});

	it("does not mistake a varying loop for a stuck one", () => {
		const v = nextStep(state({ recentInstructions: [instructionKey("a"), instructionKey("a")] }), dec("continue", "b"));
		expect(v.continue).toBe(true);
	});

	it("passes through escalate and failed with the model's reason", () => {
		expect(nextStep(state(), dec("escalate", "", "needs a password")).stopReason).toBe("escalated");
		expect(nextStep(state(), dec("failed", "", "build broken")).message).toBe("build broken");
	});

	it("always gives a message when stopping, even if the model gave no reason", () => {
		for (const d of ["done", "escalate", "failed"] as const) {
			expect(nextStep(state(), dec(d)).message).toBeTruthy();
		}
	});
});

describe("needsHuman / statusFor", () => {
	it("treats a clean finish as needing nobody", () => {
		expect(needsHuman("done")).toBe(false);
		expect(statusFor("done")).toBe("completed");
	});

	it("wakes a human for escalation, failure, budget and no-progress", () => {
		for (const r of ["escalated", "failed", "budget", "no_progress"] as const) {
			expect(needsHuman(r)).toBe(true);
		}
	});

	it("does not wake anyone for a human-initiated cancel", () => {
		expect(needsHuman("cancelled")).toBe(false);
		expect(statusFor("cancelled")).toBe("cancelled");
	});

	it("maps escalation to needs_human, not failure — they are different things to a user", () => {
		expect(statusFor("escalated")).toBe("needs_human");
		expect(statusFor("budget")).toBe("failed");
	});
});

describe("readAgentReply — the AgentDO response shape", () => {
	it("reads the AgentMessage OBJECT, not its stringification", () => {
		// The live bug: AgentDO/chat returns { message: AgentMessage }, and treating `message`
		// as a string produced "[object Object]" — which the orchestrator judged as a broken
		// agent and failed the whole run.
		const out = readAgentReply({ message: { role: "assistant", content: "I can read repos." } });
		expect(out).toBe("I can read repos.");
		expect(out).not.toContain("[object Object]");
	});

	it("prepends tool output so a tools-only turn is not read as empty", () => {
		// An empty turn looks like no-progress to the loop, which then stops early.
		const out = readAgentReply({
			toolMessage: { content: "ran list_subordinates" },
			message: { content: "Here is what I found." },
		});
		expect(out).toContain("ran list_subordinates");
		expect(out).toContain("Here is what I found.");
	});

	it("surfaces the DO's error instead of a blank turn", () => {
		expect(readAgentReply({ error: "No API key configured." })).toContain("No API key configured.");
	});

	it("accepts a plain-string message and a legacy `response` field", () => {
		expect(readAgentReply({ message: "hi" })).toBe("hi");
		expect(readAgentReply({ response: "hi" })).toBe("hi");
	});

	it("says so explicitly when there is genuinely nothing", () => {
		// Never returns "" — an empty string is indistinguishable from a parsing failure.
		for (const body of [{}, null, "nonsense", { message: { content: 42 } }]) {
			expect(readAgentReply(body)).toBe("(the agent returned nothing)");
		}
	});

	it("caps a runaway reply", () => {
		expect(readAgentReply({ message: { content: "x".repeat(20000) } }).length).toBe(8000);
	});
});
