import { describe, expect, it } from "vitest";
import { AGENT_TOOLS } from "./tools.js";

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
		const writeMem = AGENT_TOOLS.find((t) => t.name === "write_memory")!;
		expect(writeMem.parameters.key.required).toBe(true);
		expect(writeMem.parameters.type.required).toBe(true);
		expect(writeMem.parameters.content.required).toBe(true);
	});
});
