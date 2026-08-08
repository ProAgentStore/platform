import { describe, expect, it } from "vitest";
import { parseToolCallsFromText, normalizeToolCalls } from "./parse-tool-calls.js";

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
