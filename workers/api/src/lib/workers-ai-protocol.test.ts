import { describe, expect, it } from "vitest";
import { TOOL_CAPABLE_CF_DEFAULT } from "../agent-do-prompt.js";
import { announcesAction, fromWorkersAiResult, toWorkersAiBody, workersAiModelFor, workersAiToolRound, WORKERS_AI_PROTOCOL } from "./workers-ai-protocol.js";

const TOOLS = [{ type: "function", function: { name: "read_terminal", description: "", parameters: {} } }];

describe("workersAiModelFor (#851)", () => {
	it("keeps a Workers AI id and maps a brain's Anthropic default to the tool-capable default", () => {
		expect(workersAiModelFor("@cf/meta/llama-3.3-70b-instruct-fp8-fast")).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
		expect(workersAiModelFor("@cf/qwen/qwen2.5-coder-32b-instruct")).toBe("@cf/qwen/qwen2.5-coder-32b-instruct");
		expect(workersAiModelFor("claude-sonnet-4-6")).toBe(TOOL_CAPABLE_CF_DEFAULT);
	});
});

describe("toWorkersAiBody (#851)", () => {
	it("sends max_tokens, not the camelCase Workers AI ignores (default 256)", () => {
		const out = toWorkersAiBody({ messages: [], maxTokens: 4096, timeoutMs: 1 });
		expect(out.max_tokens).toBe(4096);
		expect(out).not.toHaveProperty("maxTokens");
		expect(out).not.toHaveProperty("timeoutMs");
	});

	it("drops the tools for toolChoice none — Workers AI has no tool_choice", () => {
		expect(toWorkersAiBody({ messages: [], tools: TOOLS, toolChoice: "none" })).not.toHaveProperty("tools");
		expect(toWorkersAiBody({ messages: [], tools: TOOLS })).toMatchObject({ tools: TOOLS });
		expect(toWorkersAiBody({ messages: [], tools: TOOLS, toolChoice: "none" })).not.toHaveProperty("toolChoice");
	});

	it("flattens content to a string and keeps only a schema-valid tool_call_id", () => {
		const out = toWorkersAiBody({
			messages: [
				{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
				{ role: "tool", content: "r1", tool_call_id: "abc123XYZ" },
				{ role: "tool", content: "r2", tool_call_id: "toolu_01-not-nine" },
			],
		});
		expect(out.messages).toEqual([
			{ role: "user", content: "a\n\nb" },
			{ role: "tool", content: "r1", tool_call_id: "abc123XYZ" },
			{ role: "tool", content: "r2" },
		]);
	});
});

describe("fromWorkersAiResult (#851)", () => {
	it("flattens Scout's nested call shape, keeping its id", () => {
		const out = fromWorkersAiResult(
			{ response: "", tool_calls: [{ id: "abc123XYZ", type: "function", function: { name: "read_terminal", arguments: { repo_name: "p" } } }] },
			TOOLS,
		);
		expect(out.tool_calls).toEqual([{ name: "read_terminal", arguments: { repo_name: "p" }, id: "abc123XYZ" }]);
		expect(out.protocol).toBe(WORKERS_AI_PROTOCOL);
	});

	it("lifts a call Llama wrote into its text, and strips it from the reply", () => {
		const out = fromWorkersAiResult({ response: 'Checking. {"name": "read_terminal", "parameters": {"repo_name": "p"}}' }, TOOLS);
		expect(out.tool_calls).toEqual([{ name: "read_terminal", arguments: { repo_name: "p" } }]);
		expect(out.response).toBe("Checking.");
	});

	it("never lifts a call to a tool the request did not offer", () => {
		const out = fromWorkersAiResult({ response: '{"name": "@acme/sdk", "version": "1"}' }, TOOLS);
		expect(out.tool_calls).toBeUndefined();
		expect(fromWorkersAiResult({ response: '{"name": "read_terminal"}' }).tool_calls).toBeUndefined();
	});

	it("reports usage as {input, output}, the shape every loop adds up", () => {
		expect(fromWorkersAiResult({ response: "x", usage: { prompt_tokens: 10, completion_tokens: 3 } }).usage).toEqual({ input: 10, output: 3 });
	});
});

describe("workersAiToolRound (#851)", () => {
	it("puts the call in the assistant turn and each result in the tool role, in order", () => {
		const msgs = workersAiToolRound(
			"",
			[
				{ name: "send_to_cli", arguments: { message: "go" }, id: "abc123XYZ" },
				{ name: "read_terminal", arguments: {} },
			],
			["[send_to_cli]: Sent.", "[read_terminal]: idle"],
		);
		expect(msgs[0]).toEqual({ role: "assistant", content: '[{"name":"send_to_cli","arguments":{"message":"go"}},{"name":"read_terminal","arguments":{}}]' });
		expect(msgs.slice(1)).toEqual([
			{ role: "tool", content: "[send_to_cli]: Sent.", tool_call_id: "abc123XYZ" },
			{ role: "tool", content: "[read_terminal]: idle" },
		]);
		// The results are never the model's words.
		expect(msgs.filter((m) => m.role === "assistant").some((m) => String(m.content).includes("Sent."))).toBe(false);
	});
});

describe("announcesAction (#851)", () => {
	it("recognises a promised action and leaves an answer alone", () => {
		expect(announcesAction("Let me check the terminal for you.")).toBe(true);
		expect(announcesAction("I'll send that to the CLI now.")).toBe(true);
		expect(announcesAction("The tests pass: 12 of 12.")).toBe(false);
		expect(announcesAction("I'll keep that in mind.")).toBe(false);
	});
});
