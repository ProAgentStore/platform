import { describe, expect, it, vi } from "vitest";
import type { MemoryEntry } from "../agent-types.js";
import { AGENT_TOOLS, executeTool } from "./tools.js";

/** Minimal DO storage mock — `delete` returns whether the key existed,
 *  matching the real DurableObjectStorage contract that delete_memory relies on. */
function mockDoStorage() {
	const store = new Map<string, unknown>();
	return {
		get: vi.fn(async <T>(key: string) => (store.get(key) as T) ?? null),
		put: vi.fn(async (key: string, value: unknown) => {
			store.set(key, value);
		}),
		delete: vi.fn(async (key: string) => store.delete(key)),
		list: vi.fn(async <T>(opts?: { prefix?: string }) => {
			const entries = [...store.entries()].filter(
				([k]) => !opts?.prefix || k.startsWith(opts.prefix),
			);
			return new Map(entries) as Map<string, T>;
		}),
	} as unknown as DurableObjectStorage;
}

describe("tool definitions", () => {
	it("defines 10 tools", () => {
		expect(AGENT_TOOLS).toHaveLength(10);
	});

	it("all tools have name, description, and parameters", () => {
		for (const tool of AGENT_TOOLS) {
			expect(tool.name).toBeTruthy();
			expect(tool.description).toBeTruthy();
			expect(tool.parameters).toBeDefined();
		}
	});

	it("includes memory tools", () => {
		const names = AGENT_TOOLS.map((t) => t.name);
		expect(names).toContain("read_memory");
		expect(names).toContain("write_memory");
		expect(names).toContain("delete_memory");
	});

	it("includes task tools", () => {
		const names = AGENT_TOOLS.map((t) => t.name);
		expect(names).toContain("get_tasks");
		expect(names).toContain("create_task");
		expect(names).toContain("update_task");
	});

	it("includes fetch and file tools", () => {
		const names = AGENT_TOOLS.map((t) => t.name);
		expect(names).toContain("fetch_url");
		expect(names).toContain("store_file");
		expect(names).toContain("read_file");
		expect(names).toContain("list_files");
	});

	it("required params are marked correctly", () => {
		const writeMem = AGENT_TOOLS.find((t) => t.name === "write_memory");
		if (!writeMem) throw new Error("write_memory tool not found");
		expect(writeMem.parameters.key.required).toBe(true);
		expect(writeMem.parameters.type.required).toBe(true);
		expect(writeMem.parameters.content.required).toBe(true);
	});

	it("write_memory description instructs reusing the exact existing key", () => {
		const writeMem = AGENT_TOOLS.find((t) => t.name === "write_memory");
		if (!writeMem) throw new Error("write_memory tool not found");
		expect(writeMem.description).toMatch(/exact key/i);
		expect(writeMem.description).toMatch(/overwrite/i);
	});
});

describe("memory tool execution", () => {
	const write = (key: string, content: string) => ({
		name: "write_memory",
		input: { key, type: "context", content },
	});

	it("write_memory result includes the full post-write key list", async () => {
		const storage = mockDoStorage();
		await executeTool(write("language", "Spanish"), storage, null, "agent-1");
		const second = await executeTool(
			write("user_language", "Chinese"),
			storage,
			null,
			"agent-1",
		);
		expect(second.success).toBe(true);
		expect(second.content).toContain("Stored memory: user_language");
		expect(second.content).toMatch(/All memory keys: language, user_language/);
	});

	it("write_memory to an existing key upserts instead of duplicating", async () => {
		const storage = mockDoStorage();
		await executeTool(write("language", "Spanish"), storage, null, "agent-1");
		const result = await executeTool(
			write("language", "German"),
			storage,
			null,
			"agent-1",
		);
		expect(result.content).toMatch(/All memory keys: language$/);
		const entry = (await storage.get("mem:language")) as MemoryEntry;
		expect(entry.content).toBe("German");
	});

	it("write_memory tags the entry as agent-written", async () => {
		const storage = mockDoStorage();
		await executeTool(write("language", "Spanish"), storage, null, "agent-1");
		const entry = (await storage.get("mem:language")) as MemoryEntry;
		expect(entry.source).toBe("agent");
	});

	it("delete_memory of an existing key succeeds and lists remaining keys", async () => {
		const storage = mockDoStorage();
		await executeTool(write("language", "Spanish"), storage, null, "agent-1");
		await executeTool(write("level", "beginner"), storage, null, "agent-1");
		const result = await executeTool(
			{ name: "delete_memory", input: { key: "level" } },
			storage,
			null,
			"agent-1",
		);
		expect(result.success).toBe(true);
		expect(result.content).toMatch(/Deleted memory: level\. All memory keys: language/);

		const last = await executeTool(
			{ name: "delete_memory", input: { key: "language" } },
			storage,
			null,
			"agent-1",
		);
		expect(last.content).toContain("Memory is now empty.");
	});

	it("delete_memory of a missing key fails instead of claiming success", async () => {
		const storage = mockDoStorage();
		await executeTool(write("language", "Spanish"), storage, null, "agent-1");
		const result = await executeTool(
			{ name: "delete_memory", input: { key: "user_language" } },
			storage,
			null,
			"agent-1",
		);
		expect(result.success).toBe(false);
		expect(result.content).toMatch(/No memory with key: user_language/);
		expect(result.content).toMatch(/All memory keys: language/);
	});
});
