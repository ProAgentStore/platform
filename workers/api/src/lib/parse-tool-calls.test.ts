import { describe, expect, it } from "vitest";
import { parseToolCallsFromText, normalizeToolCalls, splitToolCalls } from "./parse-tool-calls.js";

describe("parseToolCallsFromText", () => {
	it("parses single tool call", () => {
		const { calls } = parseToolCallsFromText('{"name":"write_memory","parameters":{"key":"test","type":"identity","content":"val"}}');
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("write_memory");
		expect(calls[0].arguments.key).toBe("test");
	});

	it("parses flat-shape calls where args are sibling top-level keys", () => {
		// A model emitting {"name":"write_memory","key":"x","type":"knowledge","content":"y"}
		// (no parameters/arguments wrapper) must still yield the args, not {}.
		const { calls } = parseToolCallsFromText('{"name":"write_memory","key":"x","type":"knowledge","content":"y"}');
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("write_memory");
		expect(calls[0].arguments).toEqual({ key: "x", type: "knowledge", content: "y" });
	});

	it("parses multiple tool calls separated by semicolons", () => {
		const text = '{"name":"insert_record","parameters":{"collection":"apps","data":"{\\"x\\":1}"}}; {"name":"write_memory","parameters":{"key":"k","type":"identity","content":"v"}}';
		const { calls } = parseToolCallsFromText(text);
		expect(calls).toHaveLength(2);
		expect(calls[0].name).toBe("insert_record");
		expect(calls[1].name).toBe("write_memory");
	});

	it("handles nested JSON in data fields", () => {
		const text = '{"name":"insert_record","parameters":{"collection":"applications","data":"{\\"company\\":\\"Kula AI\\",\\"url\\":\\"https://example.com\\",\\"status\\":\\"queued\\"}"}}';
		const { calls } = parseToolCallsFromText(text);
		expect(calls).toHaveLength(1);
		const data = JSON.parse(calls[0].arguments.data as string);
		expect(data.company).toBe("Kula AI");
		expect(data.url).toBe("https://example.com");
	});

	it("handles prose before tool call", () => {
		const text = 'I will now store the application.\n\n{"name":"insert_record","parameters":{"collection":"jobs","data":"{\\"x\\":1}"}}';
		const { calls } = parseToolCallsFromText(text);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("insert_record");
	});

	it("handles function.name format", () => {
		const text = '{"function":{"name":"write_memory","arguments":"{\\"key\\":\\"test\\"}"}}';
		const { calls } = parseToolCallsFromText(text);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("write_memory");
	});

	it("returns empty for no tool calls", () => {
		expect(parseToolCallsFromText("Hello world").calls).toHaveLength(0);
		expect(parseToolCallsFromText("").calls).toHaveLength(0);
		expect(parseToolCallsFromText('{"foo":"bar"}').calls).toHaveLength(0);
	});

	it("handles URLs with special chars in data", () => {
		const text = '{"name":"insert_record","parameters":{"collection":"apps","data":"{\\"url\\":\\"https://careers.example.com/job/123?src=LinkedIn&ref=456\\"}"}}';
		const { calls } = parseToolCallsFromText(text);
		expect(calls).toHaveLength(1);
		const data = JSON.parse(calls[0].arguments.data as string);
		expect(data.url).toContain("src=LinkedIn");
	});
});

describe("normalizeToolCalls", () => {
	it("normalizes OpenAI format (function.name)", () => {
		const calls = normalizeToolCalls([
			{ id: "1", type: "function", function: { name: "insert_record", arguments: '{"collection":"apps"}' } },
		]);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("insert_record");
		expect(calls[0].arguments.collection).toBe("apps");
	});

	it("normalizes flat format (name directly)", () => {
		const calls = normalizeToolCalls([
			{ name: "write_memory", arguments: { key: "test" } },
		]);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("write_memory");
		expect(calls[0].arguments.key).toBe("test");
	});

	it("filters out entries without name", () => {
		const calls = normalizeToolCalls([
			{ name: "valid", arguments: {} },
			{ foo: "bar" },
			{ name: "", arguments: {} },
		]);
		expect(calls).toHaveLength(1);
	});

	it("parses stringified arguments", () => {
		const calls = normalizeToolCalls([
			{ id: "1", type: "function", function: { name: "test", arguments: '{"key":"value"}' } },
		]);
		expect(calls[0].arguments.key).toBe("value");
	});

	it("skips ONE call with malformed JSON args without dropping the whole batch", () => {
		// Regression: a bare JSON.parse on the bad `arguments` used to throw and fail the
		// entire chat turn — losing the valid calls too.
		const calls = normalizeToolCalls([
			{ function: { name: "good_one", arguments: '{"a":1}' } },
			{ function: { name: "broken", arguments: "{not valid json" } },
			{ name: "flat_ok", arguments: { b: 2 } },
		]);
		expect(calls.map((c) => c.name)).toEqual(["good_one", "flat_ok"]);
		expect(calls[0].arguments.a).toBe(1);
		expect(calls[1].arguments.b).toBe(2);
	});

	it("reads empty-string arguments as no arguments — a no-parameter call, not a broken one (#853 finding 4)", () => {
		const calls = normalizeToolCalls([
			{ name: "read_terminal", arguments: "" },
			{ function: { name: "get_tasks", arguments: "   " } },
		]);
		expect(calls).toEqual([
			{ name: "read_terminal", arguments: {} },
			{ name: "get_tasks", arguments: {} },
		]);
	});

	it("splitToolCalls keeps a malformed call OUT of the executable list but names it, its id and why (#853 finding 4)", () => {
		const { calls, malformed } = splitToolCalls([
			{ id: "c1", function: { name: "good_one", arguments: '{"a":1}' } },
			{ id: "c2", function: { name: "send_to_cli", arguments: '{"message": "run the te' } },
		]);
		expect(calls.map((c) => c.name)).toEqual(["good_one"]);
		expect(malformed).toEqual([{ name: "send_to_cli", id: "c2", error: expect.stringMatching(/JSON/) }]);
	});

	it("passes the provider's tool_use id through, and omits it when there isn't one (#398)", () => {
		// The id is what ties a RESULT back to the call that asked for it. Without it, two calls to
		// the same tool with different arguments in one round come back as two results the model can
		// only tell apart by reading them — and when it cannot, it guesses.
		const calls = normalizeToolCalls([
			{ name: "repo_read_file", arguments: { path: "a.ts" }, id: "tu_1" },
			{ name: "repo_read_file", arguments: { path: "b.ts" }, id: "tu_2" },
			{ name: "no_id_here", arguments: {} },
			{ name: "blank_id", arguments: {}, id: "" },
		]);
		expect(calls.map((c) => c.id)).toEqual(["tu_1", "tu_2", undefined, undefined]);
		// Absent, not undefined-valued: a caller that branches on the structured protocol asks
		// whether the key is there.
		expect(Object.hasOwn(calls[2], "id")).toBe(false);
	});

	it("collapses non-object args (null / primitive) to {}", () => {
		const calls = normalizeToolCalls([
			{ name: "n1", arguments: null },
			{ function: { name: "n2", arguments: "42" } },
		]);
		expect(calls).toHaveLength(2);
		expect(calls[0].arguments).toEqual({});
		expect(calls[1].arguments).toEqual({});
	});
});

describe("parseToolCallsFromText — an object with a `name` key is not a tool call", () => {
	const allowed = new Set(["get_tasks", "write_memory", "search_knowledge"]);

	it("does not treat a package.json in the reply as a call — the answer-eating bug", () => {
		// A repo-chat agent asked "what's in package.json" answers with the file inline. With no
		// name check that object became a call to a tool named `@proagentstore/sdk`, so
		// `toolCalls.length > 0` skipped the "no tools → return the reply" early return and the
		// model's CORRECT answer was thrown away. The name then failed the allowlist, nothing ran,
		// the round broke, and the user got an answer regenerated from a transcript reading
		// "I called tools: [@proagentstore/sdk]: This tool isn't available to this agent".
		const reply = 'Here is the file:\n{"name":"@proagentstore/sdk","version":"0.4.0","type":"module"}';
		expect(parseToolCallsFromText(reply, allowed).calls).toEqual([]);
	});

	it("ignores any record carrying a name — a lead, a site, a person", () => {
		expect(parseToolCallsFromText('{"name":"Joe\'s Cafe","suburb":"Newtown"}', allowed).calls).toEqual([]);
	});

	it("still parses a REAL text-embedded call", () => {
		const { calls } = parseToolCallsFromText('I will check.\n{"name":"get_tasks"}', allowed);
		expect(calls).toEqual([{ name: "get_tasks", arguments: {} }]);
	});

	it("rejects a non-string name rather than coercing it", () => {
		expect(parseToolCallsFromText('{"name":42,"x":1}', allowed).calls).toEqual([]);
		expect(parseToolCallsFromText('{"name":{"a":1}}', allowed).calls).toEqual([]);
		expect(parseToolCallsFromText('{"name":["get_tasks"]}', allowed).calls).toEqual([]);
	});

	it("without an allowlist stays permissive — the old contract for callers that have none", () => {
		expect(parseToolCallsFromText('{"name":"anything"}').calls).toEqual([{ name: "anything", arguments: {} }]);
	});
});

describe("parseToolCallsFromText removes what it parsed (#395)", () => {
	const allowed = new Set(["get_tasks", "write_memory", "repo_remote"]);

	// The reported half of #395: the walker extracted the calls and nothing cleaned up after it,
	// so the raw markup was persisted and shown to the user as part of the agent's answer.
	it("returns the reply without the call it lifted out", () => {
		const out = parseToolCallsFromText('Let me check.\n{"name":"get_tasks"}\nOne moment.', allowed);
		expect(out.calls).toHaveLength(1);
		expect(out.text).not.toContain("get_tasks");
		expect(out.text).toContain("Let me check.");
		expect(out.text).toContain("One moment.");
	});

	it("removes every call it took, not only the first", () => {
		const out = parseToolCallsFromText('{"name":"get_tasks"} then {"name":"repo_remote"}', allowed);
		expect(out.calls.map((c) => c.name)).toEqual(["get_tasks", "repo_remote"]);
		expect(out.text.trim()).toBe("then");
	});

	it("leaves an object it did NOT treat as a call exactly where it was", () => {
		// The answer-eating regression's twin: a package.json in the reply is the ANSWER, so it must
		// survive verbatim — the walker may only remove what it actually took.
		const reply = 'Here is the file:\n{"name":"@proagentstore/sdk","version":"0.4.0"}';
		expect(parseToolCallsFromText(reply, allowed).text).toBe(reply);
	});

	it("leaves an ordinary reply byte-for-byte", () => {
		expect(parseToolCallsFromText("Nothing to do here.", allowed).text).toBe("Nothing to do here.");
	});
});

// #853 finding 3: Llama 3.x writes its documented custom-tool form, `<function=NAME>{…}</function>`. The
// inner object has no `name`, so the walker skipped it and the markup reached the owner's screen — a
// call that never happened, shown as if it had. It is reported and stripped like any call written as
// text; like them, it is never executed (#853 finding 1).
describe("parseToolCallsFromText — Llama's <function=NAME>{…}</function> form (#853 finding 3)", () => {
	const tools = new Set(["read_terminal", "send_to_cli", "write_memory"]);

	it("is recognised by the tag's name, and the whole span — tags included — leaves the reply", () => {
		expect(parseToolCallsFromText('<function=read_terminal>{"repo_name":"a"}</function>', tools)).toEqual({
			calls: [{ name: "read_terminal", arguments: { repo_name: "a" } }],
			text: "",
		});
	});

	it("keeps the prose around it", () => {
		const out = parseToolCallsFromText('Let me check the terminal. <function=read_terminal>{"repo_name":"a"}</function> Back soon.', tools);
		expect(out.calls.map((c) => c.name)).toEqual(["read_terminal"]);
		expect(out.text).toBe("Let me check the terminal.  Back soon.");
	});

	it("takes the closing tag as optional — Llama often leaves it off", () => {
		const out = parseToolCallsFromText('<function=send_to_cli>{"repo_name":"a","message":"run the tests"}', tools);
		expect(out).toEqual({ calls: [{ name: "send_to_cli", arguments: { repo_name: "a", message: "run the tests" } }], text: "" });
	});

	it("keeps text order across both forms, and several of each", () => {
		const out = parseToolCallsFromText(
			'<function=read_terminal>{"repo_name":"a"}</function>{"name":"write_memory","arguments":{"key":"k"}}<function=send_to_cli>{"message":"x"}</function>',
			tools,
		);
		expect(out.calls.map((c) => c.name)).toEqual(["read_terminal", "write_memory", "send_to_cli"]);
		expect(out.text).toBe("");
	});

	it("leaves a tag naming no real tool, or holding no valid object, where it was — it is prose, not a call", () => {
		for (const text of ['<function=rm_rf>{"path":"/"}</function>', '<function=read_terminal>{"repo_name": "a"</function>', "<function=read_terminal>no object here</function>"]) {
			expect(parseToolCallsFromText(text, tools)).toEqual({ calls: [], text });
		}
	});
});

// #853 finding 6: removing each call's span left what surrounded the calls — `[,]` from a JSON array
// of two, `;` from semicolon-separated calls, a bare `<|python_tag|>` — as the owner's reply, and as
// the assistant turn the correction round hands back to the model.
describe("parseToolCallsFromText — no residue where the calls were (#853 finding 6)", () => {
	const tools = new Set(["a", "b", "read_terminal"]);
	const A = '{"name":"a","arguments":{}}';
	const B = '{"name":"b","arguments":{}}';

	it("the issue's three probes leave nothing behind", () => {
		expect(parseToolCallsFromText(`[${A},${B}]`, tools)).toEqual({ calls: [{ name: "a", arguments: {} }, { name: "b", arguments: {} }], text: "" });
		expect(parseToolCallsFromText(`${A};${B}`, tools).text).toBe("");
		expect(parseToolCallsFromText(`<|python_tag|>${A}`, tools).text).toBe("");
	});

	it("with spacing and newlines too, and a lone call in brackets", () => {
		expect(parseToolCallsFromText(`[\n  ${A},\n  ${B}\n]`, tools).text).toBe("");
		expect(parseToolCallsFromText(`${A} ; ${B}`, tools).text).toBe("");
		expect(parseToolCallsFromText(`<|python_tag|> ${A}; ${B}`, tools).text).toBe("");
		expect(parseToolCallsFromText(`[${A}]`, tools).text).toBe("");
	});

	it("keeps the prose around them", () => {
		expect(parseToolCallsFromText(`Checking now. [${A}, ${B}] Back soon.`, tools).text).toBe("Checking now.  Back soon.");
	});

	it("never eats prose punctuation or a bracket that is not wrapping the calls", () => {
		// A list of numbers, a sentence's own semicolon, and brackets that hold more than calls stay.
		expect(parseToolCallsFromText(`Totals: [1, 2]; then ${A}`, tools).text).toBe("Totals: [1, 2]; then ");
		expect(parseToolCallsFromText(`[see ${A}]`, tools).text).toBe("[see ]");
		expect(parseToolCallsFromText(`Done; ${A}`, tools).text).toBe("Done; ");
		expect(parseToolCallsFromText(`(${A})`, tools).text).toBe("()");
	});
});

// #853 finding 5: a call cut off at the output cap never closes, so the walker never matched it and
// the raw fragment stayed in the owner's reply.
describe("parseToolCallsFromText — a call cut off at the end of the reply (#853 finding 5)", () => {
	const tools = new Set(["send_to_cli"]);

	it("is removed from the reply — it is not a call, and never run", () => {
		expect(parseToolCallsFromText('Running it. {"name":"send_to_cli","parameters":{"message":"run the te', tools)).toEqual({ calls: [], text: "Running it. " });
	});

	it("takes a <|python_tag|> in front of it too, and keeps a complete call before it reported", () => {
		expect(parseToolCallsFromText('<|python_tag|>{"name":"send_to_cli","parameters":{"message":"x', tools).text).toBe("");
		const out = parseToolCallsFromText('{"name":"send_to_cli","parameters":{"message":"a"}} {"name":"send_to_cli","parameters":{"message":"b', tools);
		expect(out.calls).toEqual([{ name: "send_to_cli", arguments: { message: "a" } }]);
		expect(out.text.trim()).toBe("");
	});

	it("an unfinished object naming no real tool, or a stray brace, stays as written", () => {
		for (const text of ['{"name":"lead","email":"a@b.c', "if (x) {", '{"name":"send_to_cli" is how it is called']) {
			expect(parseToolCallsFromText(text, tools).text).toBe(text);
		}
	});
});

