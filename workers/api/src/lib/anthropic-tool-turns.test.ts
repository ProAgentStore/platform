import { describe, expect, it } from "vitest";
import {
	hasToolBlocks,
	mergeContent,
	pairToolBlocks,
	toolResultTurn,
	toolUseIdsOf,
	type RoleMessage,
	type ToolOutcome,
} from "./anthropic-tool-turns.js";

const ok = (content: string): ToolOutcome => ({ content, isError: false });
const bad = (content: string): ToolOutcome => ({ content, isError: true });

describe("toolUseIdsOf — the assistant turn is the authority on what must be answered", () => {
	it("reads the ids in order, ignoring text blocks", () => {
		expect(
			toolUseIdsOf([
				{ type: "text", text: "let me look" },
				{ type: "tool_use", id: "tu_1", name: "repo_read_file", input: { path: "a.ts" } },
				{ type: "tool_use", id: "tu_2", name: "repo_read_file", input: { path: "b.ts" } },
			]),
		).toEqual(["tu_1", "tu_2"]);
	});

	it("returns nothing for a plain-string turn or a provider that sent no blocks", () => {
		expect(toolUseIdsOf("I called tools:\n[repo_tree]: …")).toEqual([]);
		expect(toolUseIdsOf(undefined)).toEqual([]);
		expect(toolUseIdsOf(null)).toEqual([]);
	});

	it("skips a malformed block rather than emitting a useless id", () => {
		expect(toolUseIdsOf([{ type: "tool_use", name: "x" }, { type: "tool_use", id: "", name: "y" }])).toEqual([]);
	});
});

describe("toolResultTurn — every tool_use is answered, and attributably", () => {
	it("answers each id with its own result, in order", () => {
		const turn = toolResultTurn(["tu_1", "tu_2"], new Map([["tu_1", ok("contents of a.ts")], ["tu_2", ok("contents of b.ts")]]), "");
		expect(turn).toEqual([
			{ type: "tool_result", tool_use_id: "tu_1", content: "contents of a.ts" },
			{ type: "tool_result", tool_use_id: "tu_2", content: "contents of b.ts" },
		]);
	});

	it("distinguishes two calls to the SAME tool — the ARGUMENTS loss #398 names", () => {
		// The old follow-up read `[repo_read_file]: <contents>` twice with no path, so the model had
		// to infer which result belonged to which call and guessed when it could not.
		const turn = toolResultTurn(["tu_a", "tu_b"], new Map([["tu_a", ok("A")], ["tu_b", ok("B")]]), "") as Array<Record<string, unknown>>;
		expect(turn.map((b) => [b.tool_use_id, b.content])).toEqual([["tu_a", "A"], ["tu_b", "B"]]);
	});

	it("marks a failed, refused or de-duplicated call as an error", () => {
		const turn = toolResultTurn(["tu_1"], new Map([["tu_1", bad("This tool isn't available to this agent")]]), "") as Array<Record<string, unknown>>;
		expect(turn[0].is_error).toBe(true);
	});

	it("still answers an id the platform never ran, and says so", () => {
		// `normalizeToolCalls` deliberately SKIPS a call whose arguments are malformed JSON, and that
		// call's `tool_use` block is still in the assistant turn. An unanswered id is not a degraded
		// reply — the provider rejects the whole request, so the turn never reaches the user at all.
		const turn = toolResultTurn(["tu_1"], new Map(), "") as Array<Record<string, unknown>>;
		expect(turn).toHaveLength(1);
		expect(turn[0].tool_use_id).toBe("tu_1");
		expect(turn[0].is_error).toBe(true);
		expect(String(turn[0].content)).toContain("did not run");
	});

	it("puts the platform's instruction AFTER the results, in the same turn", () => {
		const turn = toolResultTurn(["tu_1"], new Map([["tu_1", ok("x")]]), "Continue based on the tool results above.") as Array<Record<string, unknown>>;
		expect(turn.map((b) => b.type)).toEqual(["tool_result", "text"]);
	});

	it("never labels a result as the ASSISTANT's words — that is #395's whole premise", () => {
		// `invented-results.ts` stands on one fact: the platform never writes tool-result markup into
		// an assistant message, so a result block in the model's own text is proof by construction.
		// These blocks are the platform's, and they ride a `user` turn (asserted over agent-think's
		// source in agent-think.test.ts). What must never appear here is prose pretending to be one.
		const turn = toolResultTurn(["tu_1"], new Map([["tu_1", ok("real output")]]), "") as Array<Record<string, unknown>>;
		expect(turn.every((b) => b.type === "tool_result")).toBe(true);
		expect(JSON.stringify(turn)).not.toContain("I called tools");
	});
});

describe("hasToolBlocks — a transcript in the structured protocol must still DEFINE its tools", () => {
	// The provider's rule is about the whole conversation, not the current ask: a request whose
	// messages contain tool_use/tool_result and no `tools` is a 400 on the entire turn. The two
	// completions that deliberately send no tools (the final answer, and #395's correction round)
	// are exactly the ones that follow a tool round.
	it("sees a tool_use turn and a tool_result turn", () => {
		expect(hasToolBlocks([{ content: [{ type: "tool_use", id: "tu_1", name: "x", input: {} }] }])).toBe(true);
		expect(hasToolBlocks([{ content: [{ type: "tool_result", tool_use_id: "tu_1", content: "x" }] }])).toBe(true);
	});

	it("is false for a plain conversation and for the prose fallback", () => {
		expect(hasToolBlocks([{ content: "hi" }, { content: "I called tools:\n[repo_tree]: …" }])).toBe(false);
		expect(hasToolBlocks([{ content: [{ type: "text", text: "hi" }] }])).toBe(false);
		expect(hasToolBlocks([])).toBe(false);
	});
});

describe("mergeContent — the merge cannot bury a tool_result", () => {
	it("keeps the plain paragraph join for two strings", () => {
		expect(mergeContent("errored turn", "new question")).toBe("errored turn\n\nnew question");
	});

	it("hoists tool_result blocks to the front when a string is merged in after them", () => {
		// The exact live shape: the tool-result turn, then "Now give your final answer." appended as
		// a second user message. Merged naively the results end up behind the instruction, and the
		// provider requires them to open the turn.
		const merged = mergeContent(
			[{ type: "tool_result", tool_use_id: "tu_1", content: "x" }, { type: "text", text: "Continue…" }],
			"Now give your final answer.",
		) as Array<Record<string, unknown>>;
		expect(merged[0].type).toBe("tool_result");
		expect(merged.map((b) => b.type)).toEqual(["tool_result", "text", "text"]);
	});

	it("hoists them out of the SECOND operand too", () => {
		const merged = mergeContent("some earlier note", [{ type: "tool_result", tool_use_id: "tu_1", content: "x" }]) as Array<Record<string, unknown>>;
		expect(merged[0].type).toBe("tool_result");
	});

	it("leaves block content that has no tool_result alone", () => {
		const merged = mergeContent([{ type: "text", text: "a" }], [{ type: "text", text: "b" }]) as unknown[];
		expect(merged).toEqual([{ type: "text", text: "a" }, { type: "text", text: "b" }]);
	});
});

describe("pairToolBlocks — neither half of a pair may travel alone", () => {
	const useTurn = (id: string): RoleMessage => ({ role: "assistant", content: [{ type: "tool_use", id, name: "repo_tree", input: {} }] });
	const resultTurn = (id: string): RoleMessage => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] });

	it("leaves a matched pair untouched", () => {
		const msgs = [{ role: "user", content: "hi" } as RoleMessage, useTurn("tu_1"), resultTurn("tu_1")];
		expect(pairToolBlocks(msgs)).toEqual(msgs);
	});

	it("drops a tool_result whose tool_use was dropped with a leading assistant turn", () => {
		// `normalizeForAnthropic` drops LEADING assistant turns because a 10-message context window
		// can start on one. That orphans the results answering it, and the provider 400s the whole
		// request — a failure whose cause is three files from the change that allowed it.
		const out = pairToolBlocks([resultTurn("tu_gone"), { role: "assistant", content: "answer" }]);
		expect(out).toEqual([{ role: "assistant", content: "answer" }]);
	});

	it("drops a tool_use that nothing answered", () => {
		const out = pairToolBlocks([{ role: "user", content: "hi" }, useTurn("tu_1")]);
		expect(out).toEqual([{ role: "user", content: "hi" }]);
	});

	it("keeps the surviving blocks of a partially orphaned turn", () => {
		const out = pairToolBlocks([
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "looking" },
					{ type: "tool_use", id: "tu_1", name: "repo_tree", input: {} },
				],
			},
		]);
		expect(out[1].content).toEqual([{ type: "text", text: "looking" }]);
	});

	it("never touches plain string turns", () => {
		const msgs: RoleMessage[] = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
		expect(pairToolBlocks(msgs)).toEqual(msgs);
	});
});
