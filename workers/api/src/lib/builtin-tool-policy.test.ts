import { describe, expect, it } from "vitest";
import { BASE, TOOL_CATALOG, toolNamesFor } from "../agent-do-tools.js";
import { AGENT_TOOLS } from "./tools.js";
import { STORAGE_TOOLS } from "./storage-tools.js";
import { BUILTIN_TOOL_SCOPES, builtinToolPolicyInputs, isBuiltinTool, scopeOfBuiltin } from "./builtin-tool-policy.js";
import { allToolPolicyInputs, resolveToolPolicy } from "./instance-tool-policy.js";
import type { AgentCapabilities } from "./agent-capabilities.js";

const caps = (over: Partial<AgentCapabilities>): AgentCapabilities =>
	({ surfaces: [], runtime: null, workflow: null, ...over }) as AgentCapabilities;

/** The capability shapes `toolNamesFor` branches on — one per branch, so none is left unaudited. */
const REPRESENTATIVE: Array<[string, AgentCapabilities]> = [
	["declares nothing (FULL)", caps({})],
	["repo surface", caps({ surfaces: ["repo"] })],
	["coding surface", caps({ surfaces: ["coding"] })],
	["coding, drive:false", caps({ surfaces: ["coding"], surfaceOptions: { coding: { drive: false } } })],
	["declared allowlist", caps({ tools: ["repo_tree", "github_create_issue"] })],
	["apply surface", caps({ surfaces: ["apply"] })],
];

describe("the listing covers what the agent can actually run (#525)", () => {
	// THE invariant. `list_instance_tools` told an operator that a tool absent from the allowed set
	// cannot be invoked, by chat or by call_instance_tool — while the listing enumerated the
	// registry only and the chat ran `write_memory` and `fetch_url` from a collection it never
	// walked. This is the assertion that would have failed the day that sentence was written.
	it.each(REPRESENTATIVE)("every tool the chat resolves for %s is in the listing, and allowed", (_label, capabilities) => {
		const listed = new Map(resolveToolPolicy(capabilities, [], allToolPolicyInputs()).map((t) => [t.name, t]));
		for (const name of toolNamesFor(capabilities)) {
			const entry = listed.get(name);
			expect(entry, `${name} runs in chat but is absent from GET /v1/instances/:id/tools`).toBeDefined();
			expect(entry?.allowed, `${name} runs in chat but the listing reports it as not runnable`).toBe(true);
		}
	});

	// The eleven names measured as missing on instance bd43f4de-… , written out rather than derived,
	// because the issue's evidence is about these exact tools — two of which were observed running.
	it("carries the eleven BASE names the audit found missing", () => {
		const listed = new Set(allToolPolicyInputs().map((t) => t.name));
		for (const name of [
			"read_memory",
			"write_memory",
			"delete_memory",
			"get_tasks",
			"create_task",
			"update_task",
			"fetch_url",
			"get_activity",
			"get_user_context",
			"set_user_preference",
			"configure_board",
		]) {
			expect(listed.has(name), `${name} missing from the tool listing`).toBe(true);
		}
	});

	it("reports the six writes among them as writes", () => {
		const p = new Map(resolveToolPolicy(caps({}), [], allToolPolicyInputs()).map((t) => [t.name, t]));
		for (const name of ["write_memory", "delete_memory", "create_task", "update_task", "set_user_preference", "configure_board"]) {
			expect(p.get(name)?.scope, name).toBe("write");
		}
		// `fetch_url` is scope:"read" for the same reason `http_request` is — the CALLER picks the
		// verb — and its schema, carried on the same row, is what says it can POST.
		expect(p.get("fetch_url")?.scope).toBe("read");
		expect((p.get("fetch_url")?.jsonSchema as { properties: Record<string, unknown> }).properties.method).toBeDefined();
	});

	it("says which surface can reach each one", () => {
		const p = new Map(resolveToolPolicy(caps({}), [], allToolPolicyInputs()).map((t) => [t.name, t]));
		// A built-in runs in the agent's chat and nowhere else: `POST /tools/:name` dispatches
		// through `getRegistryTool`, which has no path to the instance's Durable Object.
		expect(p.get("write_memory")?.invocableBy).toEqual(["chat"]);
		expect(p.get("write_memory")?.tier).toBe("base");
		// A registry tool answers to both, which is the half of the old claim that was true.
		expect(p.get("github_create_issue")?.invocableBy).toEqual(["chat", "call_instance_tool"]);
		expect(p.get("github_create_issue")?.tier).toBe("connector");
	});

	it("lets the owner switch a built-in tool off, and reports it as off", () => {
		// The listing and the veto have to agree: `agent-think.ts` already subtracts
		// `config.disabledTools` from every resolved name, built-ins included.
		const p = resolveToolPolicy(caps({}), ["write_memory"], allToolPolicyInputs());
		const entry = p.find((t) => t.name === "write_memory");
		expect(entry?.allowed).toBe(false);
		expect(entry?.disabled).toBe(true);
		expect(entry?.reason).toBe("disabled_by_owner");
	});

	it("does not duplicate a name between the registry and the built-ins", () => {
		const names = allToolPolicyInputs().map((t) => t.name);
		expect(names.length).toBe(new Set(names).size);
	});
});

describe("builtinToolPolicyInputs", () => {
	// A definition with no scope entry would otherwise be listed as a read by default, which is the
	// exact direction of the bug. Failing here forces the decision when a tool is added.
	it("classifies every built-in definition explicitly", () => {
		const unclassified = [...AGENT_TOOLS, ...STORAGE_TOOLS].map((t) => t.name).filter((n) => BUILTIN_TOOL_SCOPES[n] === undefined);
		expect(unclassified, "add these to BUILTIN_TOOL_SCOPES with a read/write decision").toEqual([]);
	});

	it("fails closed for a name nobody classified", () => {
		expect(scopeOfBuiltin("some_tool_added_tomorrow")).toBe("write");
	});

	it("describes the storage engine's read_file, not the shadowed legacy one", () => {
		// `buildAgentToolDefinitions` merges AGENT_TOOLS then STORAGE_TOOLS by name, later winning,
		// and `agent-think` checks the storage executor first — so the storage version is the one
		// that runs, and must be the one the listing describes.
		const readFile = builtinToolPolicyInputs().find((t) => t.name === "read_file");
		expect(readFile?.description).toBe(STORAGE_TOOLS.find((t) => t.name === "read_file")?.description);
	});

	it("takes each tool's tier from the catalog rather than restating it", () => {
		const tiers = new Map(TOOL_CATALOG.flatMap((g) => g.tools.map((t) => [t, g.tier])));
		for (const input of builtinToolPolicyInputs()) {
			if (tiers.has(input.name)) expect(input.tier, input.name).toBe(tiers.get(input.name));
		}
		expect(BASE.every((n) => tiers.get(n) === "base")).toBe(true);
	});

	it("lists the permission-gated email tool rather than omitting it", () => {
		// It is granted by `permissions.email`, not by declaration, so with the permission off it is
		// not runnable — but an auditor asking "can this agent read my mail" gets a row instead of
		// silence.
		//
		// The reason is `needs_permission`, not `not_declared`, since #721. `not_declared` means
		// "belongs to some other agent", which was false about the one tool in the catalog that no
		// agent can declare: it is this agent's the moment one checkbox is ticked. The granted half
		// of the pair, and the containment that keeps it honest, are in instance-tool-policy.test.ts.
		expect(isBuiltinTool("find_confirmation_link")).toBe(true);
		const entry = resolveToolPolicy(caps({}), [], allToolPolicyInputs()).find((t) => t.name === "find_confirmation_link");
		expect(entry?.allowed).toBe(false);
		expect(entry?.reason).toBe("needs_permission");
	});

	it("knows a registry name is not a built-in", () => {
		expect(isBuiltinTool("github_create_issue")).toBe(false);
		expect(isBuiltinTool("write_memory")).toBe(true);
	});
});
