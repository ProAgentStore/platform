import { describe, expect, it } from "vitest";
import { classifyMessage, isToolCallMessage, messageKey, toolCallSummary } from "./chat-message.js";

const m = (role: string, content: string, over: Record<string, unknown> = {}) => ({ role, content, ...over });

describe("classifyMessage", () => {
	it("treats a ✅/❌ system message as a tool call", () => {
		expect(classifyMessage(m("system", "✅ **get_tasks** []"))).toBe("tool");
		expect(classifyMessage(m("system", "❌ **github_list_issues** No access"))).toBe("tool");
	});

	it("keeps an ordinary system message VISIBLE rather than collapsing it", () => {
		// Loop status ("Loop 3/10: …") is a system message too. Classifying on role alone would
		// hide it inside a chip nobody opens.
		expect(classifyMessage(m("system", "Loop complete: objective met."))).toBe("system");
		expect(classifyMessage(m("system", "Stopping the loop…"))).toBe("system");
	});

	it("does not treat a user message starting with ✅ as a tool call", () => {
		// The marker is only meaningful on a system message.
		expect(classifyMessage(m("user", "✅ done, thanks"))).toBe("user");
	});

	it("maps everything non-user to assistant", () => {
		expect(classifyMessage(m("assistant", "hi"))).toBe("assistant");
		expect(classifyMessage(m("model", "hi"))).toBe("assistant");
	});

	it("survives a missing content field", () => {
		expect(() => isToolCallMessage({ role: "system" } as never)).not.toThrow();
		expect(isToolCallMessage({ role: "system" } as never)).toBe(false);
	});
});

describe("toolCallSummary", () => {
	it("lists one or two names", () => {
		expect(toolCallSummary("✅ **get_tasks** []")).toBe("get_tasks");
		expect(toolCallSummary("✅ **get_tasks** [] ✅ **get_activity** x")).toBe("get_tasks, get_activity");
	});

	it("collapses to a count beyond two", () => {
		expect(toolCallSummary("**a** **b** **c**")).toBe("3 tools");
	});

	it("falls back to 'tools' rather than rendering an empty chip", () => {
		// "Used " with nothing after it looks broken; the marker can appear without a name.
		expect(toolCallSummary("✅ something happened")).toBe("tools");
		expect(toolCallSummary("")).toBe("tools");
	});

	it("ignores bold that is not a bare identifier", () => {
		// `**get tasks**` has a space, so it is prose, not a tool name.
		expect(toolCallSummary("**get tasks**")).toBe("tools");
	});
});

describe("messageKey", () => {
	it("prefers the id", () => {
		expect(messageKey(m("user", "x", { id: "abc", createdAt: "t" }), 3)).toBe("abc");
	});

	it("disambiguates messages sharing a timestamp", () => {
		// Both copies keyed on `id || createdAt || index`. A tool call and its reply are written
		// in the same millisecond, so a bare timestamp collides and React can reuse the wrong node.
		const a = messageKey(m("system", "x", { createdAt: "2026-08-04T11:17:09Z" }), 0);
		const b = messageKey(m("assistant", "y", { createdAt: "2026-08-04T11:17:09Z" }), 1);
		expect(a).not.toBe(b);
	});

	it("falls back to the index when there is nothing else", () => {
		expect(messageKey(m("user", "x"), 7)).toBe("i7");
	});
});
