import { describe, expect, it } from "vitest";
import { extractJsonObject, parseLoopDecision } from "./loop-decide.js";

describe("extractJsonObject", () => {
	it("pulls the first balanced object out of surrounding prose/fences", () => {
		expect(extractJsonObject('Here you go:\n```json\n{"decision":"done"}\n```\nHope that helps'))
			.toBe('{"decision":"done"}');
	});
	it("is not fooled by a brace inside a string value", () => {
		expect(extractJsonObject('{"nextInstruction":"use the } char"}'))
			.toBe('{"nextInstruction":"use the } char"}');
	});
	it("stops at the first complete object (ignores a trailing example)", () => {
		expect(extractJsonObject('{"decision":"continue"} and e.g. {"decision":"done"}'))
			.toBe('{"decision":"continue"}');
	});
	it("returns null when there is no object", () => {
		expect(extractJsonObject("just prose, no json")).toBeNull();
	});
});

describe("parseLoopDecision", () => {
	it("parses clean JSON", () => {
		const r = parseLoopDecision('{"decision":"continue","nextInstruction":"run the tests","reason":"not done"}');
		expect(r).toEqual({ decision: "continue", nextInstruction: "run the tests", reason: "not done" });
	});

	it("parses JSON wrapped in a code fence with a trailing sentence", () => {
		const r = parseLoopDecision('```json\n{"decision":"done","reason":"objective met"}\n```\nAll finished!');
		expect(r.decision).toBe("done");
		expect(r.reason).toBe("objective met");
	});

	it("normalizes decision casing/whitespace", () => {
		expect(parseLoopDecision('{"decision":" DONE "}').decision).toBe("done");
	});

	it("ignores an unknown decision value and falls back to prose", () => {
		// decision:"maybe" isn't valid → prose inference sees "continue".
		expect(parseLoopDecision('{"decision":"maybe"} let us continue to the next step').decision).toBe("continue");
	});

	it("infers a decision from a prose-only reply (no JSON) instead of dead-ending", () => {
		expect(parseLoopDecision("The objective is fully met, nothing more to do.").decision).toBe("done");
		expect(parseLoopDecision("The agent keeps repeating itself, this has failed.").decision).toBe("failed");
		expect(parseLoopDecision("This needs a human — the agent is asking a question.").decision).toBe("escalate");
	});

	it("uses the whole prose reply as the next instruction when continuing", () => {
		const r = parseLoopDecision("Continue: now add error handling to the parser.");
		expect(r.decision).toBe("continue");
		expect(r.nextInstruction).toContain("add error handling");
	});

	it("escalates (with a debuggable excerpt) when truly unparseable", () => {
		const r = parseLoopDecision("asdf qwer zxcv");
		expect(r.decision).toBe("escalate");
		expect(r.reason).toContain("asdf qwer");
	});

	it("escalates on an empty reply", () => {
		expect(parseLoopDecision("").reason).toBe("Empty LLM response");
	});
});
