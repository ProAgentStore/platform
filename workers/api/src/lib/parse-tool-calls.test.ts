import { describe, expect, it } from "vitest";
import { parseToolCallsFromText, normalizeToolCalls } from "./parse-tool-calls.js";

describe("parseToolCallsFromText", () => {
	it("parses single tool call", () => {
		const calls = parseToolCallsFromText('{"name":"write_memory","parameters":{"key":"test","type":"identity","content":"val"}}');
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("write_memory");
		expect(calls[0].arguments.key).toBe("test");
	});

	it("parses multiple tool calls separated by semicolons", () => {
		const text = '{"name":"insert_record","parameters":{"collection":"apps","data":"{\\"x\\":1}"}}; {"name":"write_memory","parameters":{"key":"k","type":"identity","content":"v"}}';
		const calls = parseToolCallsFromText(text);
		expect(calls).toHaveLength(2);
		expect(calls[0].name).toBe("insert_record");
		expect(calls[1].name).toBe("write_memory");
	});

	it("handles nested JSON in data fields", () => {
		const text = '{"name":"insert_record","parameters":{"collection":"applications","data":"{\\"company\\":\\"Kula AI\\",\\"url\\":\\"https://example.com\\",\\"status\\":\\"queued\\"}"}}';
		const calls = parseToolCallsFromText(text);
		expect(calls).toHaveLength(1);
		const data = JSON.parse(calls[0].arguments.data as string);
		expect(data.company).toBe("Kula AI");
		expect(data.url).toBe("https://example.com");
	});

	it("handles prose before tool call", () => {
		const text = 'I will now store the application.\n\n{"name":"insert_record","parameters":{"collection":"jobs","data":"{\\"x\\":1}"}}';
		const calls = parseToolCallsFromText(text);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("insert_record");
	});

	it("handles function.name format", () => {
		const text = '{"function":{"name":"write_memory","arguments":"{\\"key\\":\\"test\\"}"}}';
		const calls = parseToolCallsFromText(text);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("write_memory");
	});

	it("returns empty for no tool calls", () => {
		expect(parseToolCallsFromText("Hello world")).toHaveLength(0);
		expect(parseToolCallsFromText("")).toHaveLength(0);
		expect(parseToolCallsFromText('{"foo":"bar"}')).toHaveLength(0);
	});

	it("handles URLs with special chars in data", () => {
		const text = '{"name":"insert_record","parameters":{"collection":"apps","data":"{\\"url\\":\\"https://careers.example.com/job/123?src=LinkedIn&ref=456\\"}"}}';
		const calls = parseToolCallsFromText(text);
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
