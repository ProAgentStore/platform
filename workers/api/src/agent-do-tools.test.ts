import { describe, expect, it } from "vitest";
import {
	buildAgentToolDefinitions,
	storageToolNameSet,
} from "./agent-do-tools.js";

describe("agent tool definition helpers", () => {
	it("builds unique OpenAI function tool definitions for core agent tools", () => {
		const tools = buildAgentToolDefinitions();
		const names = tools.map((tool) => tool.function.name);

		expect(new Set(names).size).toBe(names.length);
		expect(names).toEqual(
			expect.arrayContaining([
				"read_memory",
				"write_memory",
				"search_knowledge",
				"create_collection",
				"submit_job_application",
			]),
		);
		expect(names).not.toContain("delete_file");

		for (const tool of tools) {
			expect(tool.type).toBe("function");
			expect(tool.function.description).toEqual(expect.any(String));
			expect(tool.function.parameters.type).toBe("object");
			expect(tool.function.parameters.properties).toEqual(expect.any(Object));
			expect(tool.function.parameters.required).toEqual(expect.any(Array));
		}
	});

	it("prefers storage tool schemas when storage and base tools share a name", () => {
		const searchKnowledge = buildAgentToolDefinitions().find(
			(tool) => tool.function.name === "search_knowledge",
		);

		expect(searchKnowledge?.function.parameters.properties).toHaveProperty("query");
		expect(searchKnowledge?.function.parameters.properties).toHaveProperty("top_k");
		expect(searchKnowledge?.function.parameters.required).toEqual(["query"]);
	});

	it("returns the complete storage tool name set", () => {
		const names = storageToolNameSet();

		expect(names.has("search_knowledge")).toBe(true);
		expect(names.has("upload_file")).toBe(true);
		expect(names.has("create_collection")).toBe(true);
		expect(names.has("submit_job_application")).toBe(true);
		expect(names.has("read_memory")).toBe(false);
	});
});
