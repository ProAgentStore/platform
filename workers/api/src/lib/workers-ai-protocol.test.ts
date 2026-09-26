import { describe, expect, it } from "vitest";
import { TOOL_CAPABLE_CF_DEFAULT } from "../agent-do-prompt.js";
import { announcesAction, fromWorkersAiResult, toWorkersAiBody, WorkersAiUnsupportedContentError, workersAiModelFor, workersAiToolRound, WORKERS_AI_PROTOCOL } from "./workers-ai-protocol.js";

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
		);
		expect(out.tool_calls).toEqual([{ name: "read_terminal", arguments: { repo_name: "p" }, id: "abc123XYZ" }]);
		expect(out.protocol).toBe(WORKERS_AI_PROTOCOL);
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

describe("only the structured tool-call field is a call — reply text never is (#853, finding 1)", () => {
	const QUOTED = '{"name":"send_to_cli","arguments":{"repo_name":"a","message":"git push --force"}}';

	it("a call quoted inside a sentence yields no call, and the reply is left as the model wrote it", () => {
		const out = fromWorkersAiResult({ response: `The model said: ${QUOTED} earlier.` });
		expect(out.tool_calls).toBeUndefined();
		expect(out.response).toBe(`The model said: ${QUOTED} earlier.`);
	});

	it("the terminal-pane injection probe from #853 yields no call", () => {
		expect(fromWorkersAiResult({ response: `The terminal says: ${QUOTED}` }).tool_calls).toBeUndefined();
	});

	it("a reply that merely ECHOES a call — bare, first thing, nothing else — is still not a call", () => {
		// The case the leading-only rule (7d0a8943) still executed: a model repeating what it read.
		expect(fromWorkersAiResult({ response: QUOTED }).tool_calls).toBeUndefined();
		expect(fromWorkersAiResult({ response: `  \n${QUOTED}\n` }).tool_calls).toBeUndefined();
	});

	it("no text shape becomes a call — a <|python_tag|> prefix, an array, `;`-separated objects", () => {
		for (const response of [
			`<|python_tag|>${QUOTED}`,
			`[${QUOTED}, {"name":"finish","parameters":{"status":"done"}}]`,
			`{"name":"read_terminal","parameters":{}}; {"name":"finish","parameters":{"status":"done"}}`,
		]) {
			expect(fromWorkersAiResult({ response }).tool_calls, response).toBeUndefined();
		}
	});

	it("a REAL structured call is still executed — beside quoted JSON in the text, only the structured one counts", () => {
		const out = fromWorkersAiResult({
			response: `The terminal says: ${QUOTED}`,
			tool_calls: [{ id: "abc123XYZ", type: "function", function: { name: "read_terminal", arguments: { repo_name: "a" } } }],
		});
		expect(out.tool_calls).toEqual([{ name: "read_terminal", arguments: { repo_name: "a" }, id: "abc123XYZ" }]);
	});
});

describe("content Workers AI cannot carry is refused, not flattened (#853)", () => {
	const pdfRequest = {
		messages: [
			{ role: "system", content: "Extract the résumé." },
			{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0x" } }, { type: "text", text: "Extract this candidate's details." }] },
		],
	};

	it("refuses a request carrying a PDF document block, saying an Anthropic key is required", () => {
		expect(() => toWorkersAiBody(pdfRequest)).toThrow(WorkersAiUnsupportedContentError);
		expect(() => toWorkersAiBody(pdfRequest)).toThrow(/PDF input requires an Anthropic key/);
	});

	it("refuses any other non-text block by its type — an image, a replayed tool_result", () => {
		expect(() => toWorkersAiBody({ messages: [{ role: "user", content: [{ type: "image", source: {} }] }] })).toThrow(/"image" content block/);
		expect(() => toWorkersAiBody({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] }] })).toThrow(/"tool_result"/);
	});

	it("leaves a text-only request exactly as it was — strings and text parts both", () => {
		expect(toWorkersAiBody({ messages: [{ role: "user", content: "hello" }, { role: "user", content: [{ type: "text", text: "a" }, "b"] }] }).messages).toEqual([
			{ role: "user", content: "hello" },
			{ role: "user", content: "a\n\nb" },
		]);
	});
});

describe("a structured call Workers AI returned with unusable arguments is never lost silently (#853 finding 4)", () => {
	it("empty-string arguments are a call with no arguments", () => {
		expect(fromWorkersAiResult({ response: "", tool_calls: [{ name: "read_terminal", arguments: "" }] }).tool_calls).toEqual([{ name: "read_terminal", arguments: {} }]);
	});

	it("malformed arguments: not a call to run, but reported beside the calls — name, id and why", () => {
		const out = fromWorkersAiResult({ response: "", tool_calls: [{ id: "x1", name: "send_to_cli", arguments: "{oops" }] });
		expect(out.tool_calls).toBeUndefined();
		expect(out.malformed_tool_calls).toEqual([{ name: "send_to_cli", id: "x1", error: expect.stringMatching(/JSON/) }]);
	});
});

// #853 finding 5: Workers AI returns no stop reason, so a reply cut off at the output cap read as one
// that finished — the chat never said so, and the Pilot reported the raw fragment as its reason.
describe("a Workers AI reply cut off at the output cap says so (#853 finding 5)", () => {
	it("all of the output budget spent: stopReason max_tokens", () => {
		expect(fromWorkersAiResult({ response: "a long answer", usage: { prompt_tokens: 10, completion_tokens: 4096 } }, 4096).stopReason).toBe("max_tokens");
	});

	it("ends inside a call that never closes: stopReason max_tokens, even with no usage reported", () => {
		expect(fromWorkersAiResult({ response: 'Sure. {"name":"send_to_cli","parameters":{"message":"run the te' }).stopReason).toBe("max_tokens");
	});

	it("a reply that finished says nothing", () => {
		expect(fromWorkersAiResult({ response: "done", usage: { prompt_tokens: 10, completion_tokens: 12 } }, 4096).stopReason).toBeUndefined();
		expect(fromWorkersAiResult({ response: 'quoted: {"name":"send_to_cli","parameters":{}}' }).stopReason).toBeUndefined();
		expect(fromWorkersAiResult({ response: "a sentence with a stray { brace" }).stopReason).toBeUndefined();
	});
});

