// The declared-tools gate for pipelines (#381) — the rule, and the whole-definition check.
//
// Every case below was ALLOWED before the fix: `runPipelineStep` built its registry context by
// hand and dispatched, so `capabilities.tools` bounded the chat, the /tools invoker and the
// supervision wiring — and not the one surface that runs on a timer with nobody present.
import { describe, expect, it } from "vitest";
import { declaredToolsFor, pipelineDeclarationError, undeclaredPipelineTools } from "./pipeline-tool-policy.js";
import { explainRefusal, undeclaredToolRefusal } from "./tool-refusal.js";
import { registryTools, runRegistryTool } from "./tool-registry.js";
import { CREATOR_SELECTABLE_TOOLS, toolNamesFor } from "../agent-do-tools.js";
import { agentCapabilities, type AgentCapabilities } from "./agent-capabilities.js";
import type { Env } from "../types.js";

/** A stand-in registry: `http_request` and `tmux_run_command` are connector-provided (declarable),
 *  `map` and `create_ticket` are not (the step library / first-party exemption). */
const lookup = (name: string) =>
	({
		http_request: { connector: "http" },
		tmux_run_command: { connector: "terminal" },
		map: {},
		create_ticket: {},
	})[name];

const caps = (tools?: string[]): AgentCapabilities => ({ surfaces: [], runtime: null, workflow: null, tools, boardColumns: [] });

describe("undeclaredToolRefusal — the rule", () => {
	it("refuses a connector tool the agent never declared", () => {
		expect(undeclaredToolRefusal("http_request", [], "http")).toBe(explainRefusal("http_request", "not_declared"));
	});

	it("allows a connector tool the agent declares", () => {
		expect(undeclaredToolRefusal("http_request", ["http_request"], "http")).toBeNull();
	});

	it("never gates a connector-less tool — no creator can declare one", () => {
		// The exemption. `map`/`create_ticket` are not in TOOL_CATALOG, so `capabilities.tools`
		// cannot name them; gating them would refuse every pipeline ever written.
		expect(undeclaredToolRefusal("map", [], undefined)).toBeNull();
		expect(undeclaredToolRefusal("create_ticket", [], undefined)).toBeNull();
	});

	it("asserts nothing when the caller resolved no allowlist", () => {
		// Both the surfaces that gate elsewhere (chat, /tools) and a failed capability read. Same
		// asymmetry `instanceToolPolicy` and `delegationDenial` document: refusing on evidence we
		// do not have turns a D1 blip into a stopped pipeline.
		expect(undeclaredToolRefusal("http_request", undefined, "http")).toBeNull();
		expect(undeclaredToolRefusal("http_request", null, "http")).toBeNull();
	});
});

describe("declaredToolsFor", () => {
	it("distinguishes 'declares nothing' from 'could not be read'", () => {
		// An empty array is a real assertion (no connector tools); undefined is the absence of one.
		expect(declaredToolsFor(caps(undefined))).toEqual([]);
		expect(declaredToolsFor(caps(["http_request"]))).toEqual(["http_request"]);
		expect(declaredToolsFor(null)).toBeUndefined();
	});
});

describe("undeclaredPipelineTools", () => {
	it("names a connector tool the agent never declared, ignoring the step library", () => {
		const def = { steps: [{ tool: "map" }, { tool: "http_request" }] };
		expect(undeclaredPipelineTools(def, caps(["web_search"]), lookup)).toEqual(["http_request"]);
	});

	it("treats an agent that declares no tools as declaring no CONNECTOR tools", () => {
		// `toolNamesFor`'s surface defaults contain no connector tool either, so the chat on this
		// same agent has never been able to call one.
		expect(undeclaredPipelineTools({ steps: [{ tool: "http_request" }] }, caps(undefined), lookup)).toEqual(["http_request"]);
	});

	it("reports each tool once, in first-use order", () => {
		const def = { steps: [{ tool: "tmux_run_command" }, { tool: "http_request" }, { tool: "tmux_run_command" }] };
		expect(undeclaredPipelineTools(def, caps([]), lookup)).toEqual(["tmux_run_command", "http_request"]);
	});

	it("allows everything when capabilities could not be read", () => {
		expect(undeclaredPipelineTools({ steps: [{ tool: "http_request" }] }, null, lookup)).toEqual([]);
	});
});

describe("pipelineDeclarationError", () => {
	it("names every undeclared tool and what to do about it", () => {
		const def = { steps: [{ tool: "http_request" }, { tool: "tmux_run_command" }] };
		const err = pipelineDeclarationError(def, caps([]), lookup);
		expect(err).toMatch(/http_request/);
		expect(err).toMatch(/tmux_run_command/);
		expect(err).toMatch(/capabilities\.tools/);
	});

	it("is null for a fully declared pipeline", () => {
		expect(pipelineDeclarationError({ steps: [{ tool: "http_request" }] }, caps(["http_request"]), lookup)).toBeNull();
	});

	it("resolves capabilities off an agent row the way the runtime does", () => {
		const row = { slug: "site-builder", category: "Sales", config: JSON.stringify({ capabilities: { surfaces: [], runtime: null, workflow: null, tools: ["http_request"] } }) };
		expect(pipelineDeclarationError({ steps: [{ tool: "http_request" }] }, agentCapabilities(row), lookup)).toBeNull();
		expect(pipelineDeclarationError({ steps: [{ tool: "tmux_run_command" }] }, agentCapabilities(row), lookup)).toMatch(/tmux_run_command/);
	});
});

// ── The gate itself, in the one dispatch path ───────────────────────────────────
describe("runRegistryTool honours ctx.declaredTools", () => {
	const env = {} as Env;

	it("refuses an undeclared connector tool before scope, consent or the handler", async () => {
		// `tmux_run_command` is write-scoped arbitrary shell on the owner's machine and was reachable
		// from any stored pipeline definition. Refused with no consent row and no runner in sight.
		const r = await runRegistryTool("tmux_run_command", { env, userId: "u1", instanceId: "i1", declaredTools: ["http_request"] }, {});
		expect(r.success).toBe(false);
		expect(r.content).toBe(explainRefusal("tmux_run_command", "not_declared"));
	});

	it("leaves a caller that asserts no allowlist exactly as it was", async () => {
		// Every existing surface. This one still reaches the write-consent gate and fails THERE.
		const r = await runRegistryTool("tmux_run_command", { env, userId: "u1", instanceId: "i1" }, {});
		expect(r.success).toBe(false);
		expect(r.content).not.toBe(explainRefusal("tmux_run_command", "not_declared"));
	});
});

// ── The derivation, pinned against the REAL catalog ──────────────────────────────
// The rule decides "declarable" from the tool's own `connector` field rather than from
// CREATOR_SELECTABLE_TOOLS, because importing the catalog closes an import cycle through the
// registry's own pipeline kick path. These two assertions are what make that shortcut safe: the
// moment the catalog and the connector field disagree about a REGISTRY tool, this fails.
describe("the connector-derived rule matches the real tool catalog", () => {
	it("every connector-provided registry tool is creator-selectable, and no other one is", () => {
		for (const t of registryTools()) {
			expect(CREATOR_SELECTABLE_TOOLS.has(t.name), `${t.name} (connector: ${t.connector ?? "none"})`).toBe(!!t.connector);
		}
	});

	it("`capabilities.tools` membership is what toolNamesFor resolves for a connector tool", () => {
		// The second shortcut: the rule reads `capabilities.tools` directly instead of calling
		// `toolNamesFor`. They agree for connector tools because BASE holds none — assert it rather
		// than assume it, or a connector tool promoted to BASE would be refused here while the chat
		// happily ran it.
		const connectorTools = registryTools().filter((t) => t.connector);
		expect(connectorTools.length).toBeGreaterThan(0);
		const declaredOne = toolNamesFor({ surfaces: [], runtime: null, workflow: null, tools: [connectorTools[0].name], boardColumns: [] });
		expect(declaredOne.has(connectorTools[0].name)).toBe(true);
		const declaredNone = toolNamesFor({ surfaces: [], runtime: null, workflow: null, boardColumns: [] });
		for (const t of connectorTools) expect(declaredNone.has(t.name), t.name).toBe(false);
	});
});
