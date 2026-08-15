import { describe, expect, it } from "vitest";
import { BASE, toolNamesFor } from "../agent-do-tools.js";
import type { AgentCapabilities } from "./agent-capabilities.js";
import { connectorToolsPrompt, type PromptTool } from "./connector-tool-prompt.js";
import { CONNECTOR_CONSTRAINTS } from "./surface-options.js";
import { constrainedConnectorOf, templatePreviewNote, withholdConstrainedConnectorTools } from "./template-preview-tools.js";
import { registryConnectorGroups, registryTools } from "./tool-registry.js";

const caps = (tools?: string[]): AgentCapabilities => ({
	surfaces: [],
	runtime: null,
	workflow: null,
	// `boardColumns` is required on `AgentCapabilities`; the `as AgentCapabilities` cast that used to
	// stand here hid its absence, and nothing compiled this file until #599. Empty is right for these
	// cases — every assertion in this file is about the TOOL set, and no board is involved.
	boardColumns: [],
	...(tools ? { tools } : {}),
});

/** The tmux Operator's declaration as migration 0117 writes it — every tool it has is `tmux_*`. */
const TMUX_OPERATOR = [
	"tmux_list_sessions",
	"tmux_capture_pane",
	"tmux_run_command",
	"tmux_send_keys",
	"tmux_send_message",
	"tmux_new_session",
	"tmux_kill_session",
];

describe("#517 step 3 — a tool refused by decision is not offered on the surface that refuses it", () => {
	it("withholds every tmux tool on the agent-template surface, and names the connector", () => {
		const out = withholdConstrainedConnectorTools(caps(TMUX_OPERATOR));
		expect(out.previewWithheld).toEqual(["tmux"]);
		expect(out.capabilities.tools).not.toContain("tmux_list_sessions");
		expect(out.capabilities.tools?.some((t) => t.startsWith("tmux_"))).toBe(false);
	});

	it("keeps the tools of connectors that have no ceiling, in the same declaration", () => {
		// A mixed agent must lose only what is refused. Anything else would be a bigger hammer than
		// the defect: the github half of this agent works on a template preview exactly as before.
		const out = withholdConstrainedConnectorTools(caps(["github_read_issue", "tmux_run_command", "web_search"]));
		expect(out.capabilities.tools).toEqual(["github_read_issue", "web_search"]);
		expect(out.previewWithheld).toEqual(["tmux"]);
	});

	it("never lets a fully-withheld agent fall through to the FULL toolset", () => {
		// The trap. `toolNamesFor` treats an empty `tools` array exactly like an absent one and
		// resolves FULL — so a naive filter would hand the tmux Operator every knowledge, file and
		// collection tool on the platform, on the surface this ticket is about.
		const out = withholdConstrainedConnectorTools(caps(TMUX_OPERATOR));
		expect(out.capabilities.tools).toEqual([...BASE]);
		expect([...toolNamesFor(out.capabilities)].sort()).toEqual([...BASE].sort());
		expect(toolNamesFor(out.capabilities).has("search_knowledge")).toBe(false);
	});

	it("empties the CONNECTED TOOLS block for a tmux-only agent, so the false remedy cannot be emitted", () => {
		// This is the whole point of step 3, stated as the thing that becomes IMPOSSIBLE rather than
		// less likely. `listConsents` is keyed by instance id, so on this surface it returns nothing
		// and every write tool rendered "consent NOT granted" — after which CONSENT_RULE instructs
		// the model to point the owner at console → Settings → Connections, which is where the
		// invented remedy came from. With no connector tools left there is no block, no labels and
		// no phrase to reach for.
		const declared = withholdConstrainedConnectorTools(caps(TMUX_OPERATOR)).capabilities;
		const enabled = toolNamesFor(declared);
		const connectorTools: PromptTool[] = registryTools()
			.filter((t) => t.connector && enabled.has(t.name))
			.map((t) => ({ name: t.name, description: t.description, connector: t.connector, scope: t.scope, jsonSchema: t.jsonSchema }));
		expect(connectorTools).toEqual([]);
		const block = connectorToolsPrompt(connectorTools, []);
		expect(block).toBe("");
		expect(block).not.toContain("Settings → Connections");
		expect(block).not.toContain("consent NOT granted");
	});
});

describe("#517 step 3 — every other agent is byte-identical, asserted rather than inspected", () => {
	it("returns the SAME capabilities object when nothing is withheld", () => {
		// Reference equality, not deep equality: a subscribed instance's prompt cannot shift by a
		// character if the object it is built from is the one that was passed in.
		const unconstrained = caps(["github_read_issue", "search_knowledge"]);
		expect(withholdConstrainedConnectorTools(unconstrained).capabilities).toBe(unconstrained);
		const undeclared = caps();
		expect(withholdConstrainedConnectorTools(undeclared).capabilities).toBe(undeclared);
		const empty = caps([]);
		expect(withholdConstrainedConnectorTools(empty).capabilities).toBe(empty);
	});

	it("touches EXACTLY the connectors that have a constraint vocabulary — every registry connector checked", () => {
		// The blast radius, enumerated from the registry instead of trusted. Today that is `terminal`
		// and `tmux`; a connector that gains a ceiling tomorrow is picked up here automatically,
		// which is the property a hand-written second list would not have.
		const affected: string[] = [];
		for (const group of registryConnectorGroups()) {
			const declared = caps([...group.tools]);
			const out = withholdConstrainedConnectorTools(declared);
			if (out.capabilities !== declared) affected.push(group.connector);
			expect(out.previewWithheld).toEqual(out.capabilities === declared ? [] : [group.connector]);
		}
		expect(affected.sort()).toEqual(Object.keys(CONNECTOR_CONSTRAINTS).sort());
	});

	it("a non-connector tool name is never constrained, whatever it is called", () => {
		expect(constrainedConnectorOf("search_knowledge")).toBeNull();
		expect(constrainedConnectorOf("tmux_list_sessions")).toBe("tmux");
		expect(constrainedConnectorOf("terminal_list_targets")).toBe("terminal");
		expect(constrainedConnectorOf("github_read_issue")).toBeNull();
		expect(constrainedConnectorOf("not_a_tool_at_all")).toBeNull();
	});

	it("the instance surface adds NOTHING to the prompt", () => {
		// `resolveAgentCapabilities` returns `previewWithheld: []` on the instance join, and this is
		// what that has to mean: not a shorter note, no note.
		expect(templatePreviewNote([])).toBe("");
	});
});

describe("#517 step 3 — the sentence that replaces what was withheld", () => {
	it("names the connector and the only real action, which is to subscribe", () => {
		const note = templatePreviewNote(["tmux"]);
		expect(note).toContain("PREVIEWED from the agent template");
		expect(note).toContain("tmux tools are deliberately not available here");
		expect(note).toContain("from a subscribed instance of this agent");
	});

	it("names NO console location, and says there is nothing to switch on", () => {
		// The defect being closed: a remedy pointing at a control that does not exist. Withholding
		// the tools without saying why would leave the same vacuum the invention grew in, so the
		// sentence has to be explicit that this is not a setting anyone can flip.
		const note = templatePreviewNote(["terminal"]);
		expect(note).toContain("NOT a setting, permission or connection anyone can switch on");
		expect(note).toContain("there is no console page for it");
		expect(note).not.toMatch(/Settings/);
		expect(note).not.toMatch(/Connections/);
	});

	it("reads correctly when both constrained connectors are withheld at once", () => {
		expect(templatePreviewNote(["terminal", "tmux"])).toContain("Your terminal and tmux tools");
	});
});
