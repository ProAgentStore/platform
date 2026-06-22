import { describe, expect, it } from "vitest";
import type {
	AgentMessage,
	AgentState,
	AgentTask,
	MemoryEntry,
} from "./agent-do.js";
import { parseToolCallsFromText } from "./lib/parse-tool-calls.js";

describe("AgentDO types", () => {
	it("AgentMessage has required fields", () => {
		const msg: AgentMessage = {
			id: "123",
			role: "user",
			content: "hello",
			channel: "chat",
			createdAt: new Date().toISOString(),
		};
		expect(msg.id).toBe("123");
		expect(msg.role).toBe("user");
		expect(msg.content).toBe("hello");
		expect(msg.channel).toBe("chat");
		expect(msg.userId).toBeUndefined();
	});

	it("AgentMessage supports all roles", () => {
		const roles: AgentMessage["role"][] = ["user", "assistant", "system"];
		expect(roles).toHaveLength(3);
	});

	it("AgentTask has valid statuses", () => {
		const task: AgentTask = {
			id: "task-1",
			title: "Test task",
			description: "Do something",
			status: "pending",
			assignedBy: "user",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		expect(task.status).toBe("pending");
		const statuses: AgentTask["status"][] = [
			"pending",
			"in_progress",
			"blocked",
			"complete",
		];
		expect(statuses).toHaveLength(4);
	});

	it("AgentTask supports all assignedBy values", () => {
		const values: AgentTask["assignedBy"][] = ["user", "self", "system"];
		expect(values).toHaveLength(3);
	});

	it("MemoryEntry has valid types", () => {
		const entry: MemoryEntry = {
			key: "name",
			type: "identity",
			content: "I am a test agent",
			updatedAt: new Date().toISOString(),
		};
		expect(entry.type).toBe("identity");
		const types: MemoryEntry["type"][] = [
			"identity",
			"knowledge",
			"preference",
			"skill",
			"context",
		];
		expect(types).toHaveLength(5);
	});

	it("AgentState has valid statuses", () => {
		const state: AgentState = {
			agentId: "agent-1",
			name: "Test Agent",
			personality: "friendly",
			goal: "help users",
			model: "@cf/meta/llama-3.2-3b-instruct",
			status: "idle",
			systemPrompt: "You are Test Agent.",
		};
		expect(state.status).toBe("idle");
		const statuses: AgentState["status"][] = ["idle", "thinking", "error"];
		expect(statuses).toHaveLength(3);
	});
});

describe("parseToolCallsFromText", () => {
	it("parses single tool call from text", () => {
		const text = '{"name": "insert_record", "parameters": {"collection": "jobs", "data": "{\\"company\\": \\"Acme\\"}"}}';
		const calls = parseToolCallsFromText(text);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("insert_record");
		expect(calls[0].arguments.collection).toBe("jobs");
	});

	it("parses multiple tool calls separated by semicolons", () => {
		const text = '{"name": "insert_record", "parameters": {"collection": "apps", "data": "{\\"x\\": 1}"}}; {"name": "write_memory", "parameters": {"key": "k", "type": "identity", "content": "v"}}';
		const calls = parseToolCallsFromText(text);
		expect(calls).toHaveLength(2);
		expect(calls[0].name).toBe("insert_record");
		expect(calls[1].name).toBe("write_memory");
	});

	it("handles nested JSON in data field", () => {
		const text = '{"name": "insert_record", "parameters": {"collection": "applications", "data": "{\\"company\\": \\"Kula AI\\", \\"url\\": \\"https://example.com\\", \\"status\\": \\"queued\\"}"}}';
		const calls = parseToolCallsFromText(text);
		expect(calls).toHaveLength(1);
		expect(calls[0].arguments.collection).toBe("applications");
		const data = JSON.parse(calls[0].arguments.data as string);
		expect(data.company).toBe("Kula AI");
		expect(data.url).toBe("https://example.com");
	});

	it("handles prose before tool call", () => {
		const text = 'I will now store the application.\n\n{"name": "insert_record", "parameters": {"collection": "jobs", "data": "{\\"x\\": 1}"}}';
		const calls = parseToolCallsFromText(text);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("insert_record");
	});

	it("handles function.name format", () => {
		const text = '{"function": {"name": "write_memory", "arguments": "{\\"key\\": \\"test\\"}"}}';
		const calls = parseToolCallsFromText(text);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("write_memory");
	});

	it("returns empty for no tool calls", () => {
		expect(parseToolCallsFromText("Hello world")).toHaveLength(0);
		expect(parseToolCallsFromText("")).toHaveLength(0);
		expect(parseToolCallsFromText('{"foo": "bar"}')).toHaveLength(0);
	});
});

describe("AgentDO message key ordering", () => {
	it("ISO timestamps sort lexicographically", () => {
		const t1 = "2026-06-05T10:00:00.000Z";
		const t2 = "2026-06-05T10:00:01.000Z";
		const t3 = "2026-06-05T10:01:00.000Z";
		expect(t1 < t2).toBe(true);
		expect(t2 < t3).toBe(true);
		// This ensures DO storage list with prefix 'msg:' returns messages in chronological order
		const k1 = `msg:${t1}:abc`;
		const k2 = `msg:${t2}:def`;
		const k3 = `msg:${t3}:ghi`;
		expect(k1 < k2).toBe(true);
		expect(k2 < k3).toBe(true);
	});
});
