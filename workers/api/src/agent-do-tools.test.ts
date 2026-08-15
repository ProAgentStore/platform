import { describe, expect, it } from "vitest";
import {
	buildAgentToolDefinitions,
	CREATOR_SELECTABLE_TOOLS,
	storageToolNameSet,
	TOOL_CATALOG,
	toolNamesFor,
} from "./agent-do-tools.js";
import { registryToolNameSet } from "./lib/tool-registry.js";
import { agentCapabilities, type AgentCapabilities } from "./lib/agent-capabilities.js";

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

	it("passes a registry tool's jsonSchema through verbatim to the LLM-facing definition", () => {
		// A creator granting a connector tool: it appears in the built definitions with its
		// authored draft-07 schema (properties + required), NOT a rebuilt ad-hoc map.
		const declared: AgentCapabilities = { ...caps([]), tools: ["github_read_issue"] };
		const def = buildAgentToolDefinitions({ capabilities: declared }).find(
			(t) => t.function.name === "github_read_issue",
		);
		expect(def).toBeTruthy();
		expect(def?.function.parameters.type).toBe("object");
		expect(def?.function.parameters.properties).toHaveProperty("repo");
		expect(def?.function.parameters.properties).toHaveProperty("number");
		expect(def?.function.parameters.required).toEqual(["repo", "number"]);
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

	it("Coder with declared github tools (#130) gets them + keeps the coding invariant, no KB", () => {
		// The migration-0054 shape: coding surface + a declared allowlist of the GitHub
		// connector's issue tools. The co-pilot must be OFFERED the github tools so it can
		// file issues directly, while the #119 CODING delegation invariant still holds.
		const coder: AgentCapabilities = {
			...caps(["coding"]),
			runtime: "coding",
			workflow: "CODING_SESSION",
			tools: ["github_create_issue", "github_list_issues", "github_read_issue"],
		};
		const names = toolNamesFor(coder);
		// The gap #130 closes: the github tools are now available to the tool loop.
		expect(names.has("github_create_issue")).toBe(true);
		expect(names.has("github_list_issues")).toBe(true);
		expect(names.has("github_read_issue")).toBe(true);
		// The #119 coding delegation invariant is NON-negotiable, even under a declared list.
		expect(names.has("send_to_cli")).toBe(true);
		expect(names.has("read_terminal")).toBe(true);
		expect(names.has("list_coding_repos")).toBe(true);
		// Still no empty-index KB tools (declaring github must not reopen that hole).
		expect(names.has("search_knowledge")).toBe(false);
		// And the definitions build (create_issue's write schema passes through).
		const def = buildAgentToolDefinitions({ capabilities: coder }).find((t) => t.function.name === "github_create_issue");
		expect(def?.function.parameters.properties).toHaveProperty("repo");
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

	it("a declared allowlist governs other tools but NEVER drops coding delegation (CODER-008)", () => {
		// A coding agent can opt into KB via a declared allowlist, but the delegation tools
		// (send_to_cli / read_terminal / list_coding_repos) are a hard invariant for the
		// `coding` surface and are always present — losing them left the orchestrator unable
		// to drive its Engines (issue #119).
		const names = toolNamesFor({ ...caps(["coding"]), tools: ["search_knowledge"] });
		expect(names.has("search_knowledge")).toBe(true); // declared override still applies
		expect(names.has("read_terminal")).toBe(true); // invariant: always granted for coding
		expect(names.has("send_to_cli")).toBe(true); // invariant: delegation never dropped
		expect(names.has("list_coding_repos")).toBe(true);
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

	it("repo-chat declaring its tools as data resolves identically to the repo-surface default (migration 0050 dogfood)", () => {
		// The config shape migration 0050 produces: surface stays "repo", tools now
		// declared explicitly. The whole point of the dogfood is that this changes NO
		// behavior — it just moves the choice from a hardcoded special-case to data.
		const config = JSON.stringify({
			capabilities: {
				surfaces: ["repo"],
				runtime: null,
				workflow: null,
				tools: ["search_knowledge", "list_knowledge", "read_knowledge"],
			},
		});
		const declared = [...toolNamesFor(agentCapabilities({ slug: "repo-chat", config }))].sort();
		const surfaceDefault = [...toolNamesFor(caps(["repo"]))].sort();
		expect(declared).toEqual(surfaceDefault);
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

describe("surface options govern the drive tools (#154)", () => {
	const CODING = ["send_to_cli", "read_terminal", "list_coding_repos"];

	it("a plain coding agent KEEPS them — the #119 invariant is the default", () => {
		// Dropping these silently once left an orchestrator unable to send tasks, after which
		// it deflected or hallucinated success. Nothing about this changes for existing agents.
		const names = toolNamesFor(caps(["coding"]));
		for (const t of CODING) expect(names.has(t)).toBe(true);
	});

	it("keeps them even when a declared allowlist omits them", () => {
		const names = toolNamesFor({ ...caps(["coding"]), tools: ["github_list_issues"] });
		for (const t of CODING) expect(names.has(t)).toBe(true);
	});

	it("DROPS them for a supervised repo agent that declares drive:false", () => {
		// A Repo Coder is driven by its Lead. Carrying these makes its chat a third way to drive
		// an engine, alongside the Co-pilot and the Overseer — the overlapping drive-paths #154
		// exists to remove.
		const names = toolNamesFor({
			surfaces: ["coding"],
			runtime: "coding",
			workflow: null,
			surfaceOptions: { coding: { drive: false } },
		} as never);
		for (const t of CODING) expect(names.has(t)).toBe(false);
	});

	it("still gives that agent its declared tools and the universal base", () => {
		// Opting out of driving must not strip it of everything else.
		const names = toolNamesFor({
			surfaces: ["coding"],
			runtime: "coding",
			workflow: null,
			tools: ["github_list_issues"],
			surfaceOptions: { coding: { drive: false } },
		} as never);
		expect(names.has("github_list_issues")).toBe(true);
		expect(names.size).toBeGreaterThan(1);
	});

	it("is INERT on an agent that does not declare the coding surface", () => {
		// An option must never change a surface the agent does not have. Note the baseline: a
		// surface-less agent gets the FULL catalog by design, so the assertion is that the
		// option changes nothing — not that the tools are absent.
		const base = toolNamesFor(caps([]));
		const withOpt = toolNamesFor({ ...caps([]), surfaceOptions: { coding: { drive: false } } });
		expect([...withOpt].sort()).toEqual([...base].sort());
	});
});

describe("tool catalog reachability — a tool nobody can call is not a tool", () => {
	const caps = (over: Record<string, unknown> = {}) =>
		({ surfaces: [], runtime: null, workflow: null, boardColumns: [], ...over }) as never;

	it("exposes delete_record, so a collections agent can REMOVE a record", () => {
		// It has a declared def and a working, tested handler in STORAGE_TOOLS but was in NO
		// group. FULL is the union of the groups and CREATOR_SELECTABLE_TOOLS is built from
		// TOOL_CATALOG, so the name was unreachable through every path: never shown to the model,
		// refused if called from text, and silently dropped even from an explicit
		// `capabilities.tools:["delete_record"]`. Its own test passes by calling
		// executeStorageTool directly, past the gate. So the agent could create and update
		// records forever and never delete one.
		expect(CREATOR_SELECTABLE_TOOLS.has("delete_record")).toBe(true);
		expect(toolNamesFor(caps({ tools: ["delete_record"] })).has("delete_record")).toBe(true);
		// But NOT by default. Folding it into COLLECTIONS would put it in FULL, which is what
		// every agent declaring no allowlist gets — silently handing an irreversible delete to
		// every existing production agent, with no owner opt-in and no undo.
		expect(toolNamesFor(caps()).has("delete_record")).toBe(false);
	});

	it("every catalog name is reachable through the declared-tools path", () => {
		// The inverse failure: a catalog name `toolNamesFor` drops would be offered to a creator
		// and then refused at call time.
		const unreachable = [...CREATOR_SELECTABLE_TOOLS].filter((n) => !toolNamesFor(caps({ tools: [n] })).has(n));
		expect(unreachable).toEqual([]);
	});

	it("every catalog name has a real implementation behind it", () => {
		const known = new Set([...storageToolNameSet(), ...registryToolNameSet()]);
		const orphans = [...CREATOR_SELECTABLE_TOOLS].filter((n) => !known.has(n));
		// The coding/apply families are implemented in lib/tools.ts, not the two registries above.
		const implementedElsewhere = new Set(["list_coding_repos", "read_terminal", "send_to_cli", "submit_job_application", "find_confirmation_link"]);
		expect(orphans.filter((n) => !implementedElsewhere.has(n))).toEqual([]);
	});
});
