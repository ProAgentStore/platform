import { describe, expect, it } from "vitest";
import {
	buildAgentToolDefinitions,
	CREATOR_SELECTABLE_TOOLS,
	storageToolNameSet,
	TOOL_CATALOG,
	toolNamesFor,
} from "./agent-do-tools.js";
import type { AgentCapabilities } from "./lib/agent-capabilities.js";

const caps = (surfaces: AgentCapabilities["surfaces"]): AgentCapabilities => ({
	surfaces,
	runtime: null,
	workflow: null,
	boardColumns: [],
});

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
		// Permission-gated tools are absent unless explicitly enabled.
		expect(names).not.toContain("find_confirmation_link");
		expect(buildAgentToolDefinitions({ emailEnabled: true }).map((t) => t.function.name)).toContain("find_confirmation_link");

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

	it("gives a Coder (coding surface) NO knowledge/file/collection tools — only base + coding", () => {
		const names = toolNamesFor(caps(["coding"]));
		// The core of the fix: a Coder can't call search_knowledge, so it can't hallucinate
		// an empty index. It also drops file/collection/apply tools it never uses.
		expect(names.has("search_knowledge")).toBe(false);
		expect(names.has("add_knowledge")).toBe(false);
		expect(names.has("upload_file")).toBe(false);
		expect(names.has("create_collection")).toBe(false);
		expect(names.has("submit_job_application")).toBe(false);
		// Keeps what it actually uses.
		expect(names.has("read_terminal")).toBe(true);
		expect(names.has("list_coding_repos")).toBe(true);
		expect(names.has("read_memory")).toBe(true);
		expect(names.has("fetch_url")).toBe(true);
	});

	it("every agent type can delete memory (needed to consolidate duplicate keys)", () => {
		for (const c of [caps([]), caps(["coding"]), caps(["repo"]), caps(["apply"]), undefined]) {
			expect(toolNamesFor(c).has("delete_memory")).toBe(true);
		}
	});

	it("gives Repo Chat (repo surface) read-only knowledge, no writes/coding", () => {
		const names = toolNamesFor(caps(["repo"]));
		expect(names.has("search_knowledge")).toBe(true);
		expect(names.has("read_knowledge")).toBe(true);
		// Read-only: ingestion is server-side via the Repo tab, not an agent tool.
		expect(names.has("add_knowledge")).toBe(false);
		expect(names.has("delete_knowledge")).toBe(false);
		expect(names.has("read_terminal")).toBe(false);
		expect(names.has("create_collection")).toBe(false);
	});

	it("gives apply/generic/unknown agents the full set (no regression)", () => {
		const full = toolNamesFor(caps([])); // generic
		const apply = toolNamesFor(caps(["apply"]));
		for (const n of ["search_knowledge", "add_knowledge", "upload_file", "create_collection", "submit_job_application", "read_terminal"]) {
			expect(full.has(n)).toBe(true);
			expect(apply.has(n)).toBe(true);
		}
		// undefined capabilities → full set too (safe permissive default).
		expect(toolNamesFor(undefined).has("search_knowledge")).toBe(true);
	});

	it("buildAgentToolDefinitions honours the capability gate", () => {
		const coderTools = buildAgentToolDefinitions({ capabilities: caps(["coding"]) }).map((t) => t.function.name);
		expect(coderTools).not.toContain("search_knowledge");
		expect(coderTools).toContain("read_terminal");
	});

	it("honours a declared tool allowlist over the per-surface default", () => {
		// A declared allowlist is authoritative: exactly these catalog tools + BASE.
		const names = toolNamesFor({ ...caps([]), tools: ["search_knowledge", "upload_file"] });
		expect(names.has("search_knowledge")).toBe(true);
		expect(names.has("upload_file")).toBe(true);
		// BASE facilities are always included.
		expect(names.has("read_memory")).toBe(true);
		expect(names.has("fetch_url")).toBe(true);
		// Not declared → absent, even though the generic default would include them.
		expect(names.has("create_collection")).toBe(false);
		expect(names.has("read_terminal")).toBe(false);
	});

	it("declared allowlist wins even against a surface (e.g. a coding agent opting into KB)", () => {
		const names = toolNamesFor({ ...caps(["coding"]), tools: ["search_knowledge"] });
		expect(names.has("search_knowledge")).toBe(true); // override
		expect(names.has("read_terminal")).toBe(false); // not declared → not granted
		expect(names.has("read_memory")).toBe(true); // BASE
	});

	it("ignores ungrantable names in a declared allowlist (permission-gated / legacy / unknown)", () => {
		const names = toolNamesFor({
			...caps([]),
			tools: ["find_confirmation_link", "submit_job_application", "not_a_real_tool", "list_knowledge"],
		});
		expect(names.has("find_confirmation_link")).toBe(false); // permission-gated, never declarable
		expect(names.has("submit_job_application")).toBe(false); // legacy, not in catalog
		expect(names.has("not_a_real_tool")).toBe(false);
		expect(names.has("list_knowledge")).toBe(true); // real catalog tool
	});

	it("an empty declared allowlist falls back to the surface default", () => {
		expect(toolNamesFor({ ...caps([]), tools: [] }).has("create_collection")).toBe(true);
	});

	it("the tool catalog is data: base group + selectable groups, no gated/legacy tools", () => {
		expect(TOOL_CATALOG.find((g) => g.tier === "base")?.tools).toContain("fetch_url");
		expect(TOOL_CATALOG.some((g) => g.id === "kb_read")).toBe(true);
		// Creator-selectable excludes BASE, permission-gated, and legacy tools.
		expect(CREATOR_SELECTABLE_TOOLS.has("search_knowledge")).toBe(true);
		expect(CREATOR_SELECTABLE_TOOLS.has("read_terminal")).toBe(true);
		expect(CREATOR_SELECTABLE_TOOLS.has("read_memory")).toBe(false); // BASE, always granted
		expect(CREATOR_SELECTABLE_TOOLS.has("find_confirmation_link")).toBe(false); // gated
		expect(CREATOR_SELECTABLE_TOOLS.has("submit_job_application")).toBe(false); // legacy
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
