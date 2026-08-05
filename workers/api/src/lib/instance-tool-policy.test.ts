import { describe, expect, it } from "vitest";
import { explainRefusal, readDisabledTools, resolveToolPolicy } from "./instance-tool-policy.js";
import type { AgentCapabilities } from "./agent-capabilities.js";

const caps = (over: Partial<AgentCapabilities>): AgentCapabilities =>
	({ surfaces: [], runtime: null, workflow: null, ...over }) as AgentCapabilities;

/** A stand-in registry so these assertions don't move when the real catalog grows. */
const TOOLS = [
	{ name: "repo_tree", connector: "repo-local", scope: "read" as const, description: "d", jsonSchema: {} },
	{ name: "repo_read_file", connector: "repo-local", scope: "read" as const, description: "d", jsonSchema: {} },
	{ name: "tmux_run_command", connector: "tmux", scope: "write" as const, description: "d", jsonSchema: {} },
	{ name: "tmux_capture_pane", connector: "tmux", scope: "read" as const, description: "d", jsonSchema: {} },
	{ name: "sheets_read", connector: "google_sheets", scope: "read" as const, description: "d", jsonSchema: {} },
];
const byName = (p: ReturnType<typeof resolveToolPolicy>, n: string) => p.find((t) => t.name === n)!;

describe("resolveToolPolicy — the declared gate", () => {
	const declared = caps({ tools: ["repo_tree", "repo_read_file"] });

	it("allows exactly the declared tools", () => {
		const p = resolveToolPolicy(declared, [], TOOLS);
		expect(byName(p, "repo_tree").allowed).toBe(true);
		expect(byName(p, "repo_read_file").allowed).toBe(true);
	});

	// The hole this whole module exists to close: owning the instance used to be authority to
	// run anything in the registry, so a read-only agent's instance could still be driven to
	// read the owner's terminals or spreadsheets from the REST invoker / MCP.
	it("refuses every undeclared tool, reads included", () => {
		const p = resolveToolPolicy(declared, [], TOOLS);
		for (const n of ["tmux_run_command", "tmux_capture_pane", "sheets_read"]) {
			expect(byName(p, n).allowed).toBe(false);
			expect(byName(p, n).reason).toBe("not_declared");
		}
	});

	it("reports on EVERY tool, not just the allowed ones — 'what can it do' needs the negatives", () => {
		expect(resolveToolPolicy(declared, [], TOOLS)).toHaveLength(TOOLS.length);
	});

	it("carries scope through so a caller can assert an instance has no write tool at all", () => {
		const p = resolveToolPolicy(declared, [], TOOLS);
		expect(p.filter((t) => t.allowed && t.scope === "write")).toEqual([]);
	});
});

describe("resolveToolPolicy — the owner's off-switch", () => {
	const declared = caps({ tools: ["repo_tree", "repo_read_file"] });

	it("blocks a declared tool the owner switched off, and says why", () => {
		const p = resolveToolPolicy(declared, ["repo_read_file"], TOOLS);
		expect(byName(p, "repo_read_file").allowed).toBe(false);
		expect(byName(p, "repo_read_file").disabled).toBe(true);
		expect(byName(p, "repo_read_file").reason).toBe("disabled_by_owner");
		expect(byName(p, "repo_tree").allowed).toBe(true);
	});

	// An off-switch naming a tool the agent never had must not be reported as "the owner
	// disabled this" — it was already refused, and mislabelling it hides the real reason.
	it("keeps not_declared as the reason when a disabled name was never declared anyway", () => {
		const p = resolveToolPolicy(declared, ["sheets_read"], TOOLS);
		expect(byName(p, "sheets_read").allowed).toBe(false);
		expect(byName(p, "sheets_read").reason).toBe("not_declared");
	});

	it("an agent with everything declared can still be reduced to nothing by the owner", () => {
		const all = caps({ tools: TOOLS.map((t) => t.name) });
		const p = resolveToolPolicy(all, TOOLS.map((t) => t.name), TOOLS);
		expect(p.every((t) => !t.allowed)).toBe(true);
	});
});

describe("resolveToolPolicy — agents that declare nothing", () => {
	// A legacy agent with no declared list falls back to the per-surface default (FULL), which
	// deliberately contains NO connector tools — a legacy agent never had them in chat. The
	// REST invoker used to hand them out anyway, which is precisely the gap being closed, so
	// the gate matches chat rather than preserving the invoker's wider reach.
	//
	// This is a real behaviour change for `call_instance_tool` against a legacy agent: to use
	// a connector tool there, the agent must now DECLARE it (capabilities.tools). That is the
	// point — "which tools does this agent have" should have one answer, not one per surface.
	it("gives a legacy agent the same connector-free default the chat runtime gives it", () => {
		const legacy = caps({});
		const p = resolveToolPolicy(legacy, [], TOOLS);
		expect(byName(p, "sheets_read").allowed).toBe(false);
		expect(byName(p, "tmux_run_command").allowed).toBe(false);
	});

	it("still lets the owner switch off whatever a legacy agent does have", () => {
		const legacy = caps({});
		const withKb = [{ name: "search_knowledge", scope: "read" as const, description: "d", jsonSchema: {} }];
		expect(resolveToolPolicy(legacy, [], withKb)[0].allowed).toBe(true);
		const off = resolveToolPolicy(legacy, ["search_knowledge"], withKb);
		expect(off[0].allowed).toBe(false);
		expect(off[0].reason).toBe("disabled_by_owner");
	});
});

describe("readDisabledTools", () => {
	it("reads the list, and survives junk without throwing", () => {
		expect(readDisabledTools(JSON.stringify({ disabledTools: ["a", "b"] }))).toEqual(["a", "b"]);
		expect(readDisabledTools(JSON.stringify({ disabledTools: "nope" }))).toEqual([]);
		expect(readDisabledTools(JSON.stringify({ disabledTools: [1, "a", null] }))).toEqual(["a"]);
		expect(readDisabledTools("{not json")).toEqual([]);
		expect(readDisabledTools(null)).toEqual([]);
		expect(readDisabledTools(undefined)).toEqual([]);
	});
});

describe("explainRefusal", () => {
	it("distinguishes 'never had it' from 'you turned it off' — they need different fixes", () => {
		expect(explainRefusal("x", "not_declared")).toContain("not one of this agent's tools");
		expect(explainRefusal("x", "disabled_by_owner")).toContain("switched off");
		expect(explainRefusal("x", "disabled_by_owner")).toContain("Settings → Tools");
	});
});
