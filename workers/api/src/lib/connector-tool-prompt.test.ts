import { describe, expect, it } from "vitest";
import { CONSENT_RULE, connectorToolsPrompt, consentLabel, type PromptTool } from "./connector-tool-prompt.js";

/** The four write tools from the reported instance, as the registry declares them. */
const TERMINAL_WRITES: PromptTool[] = [
	{ name: "terminal_run_command", description: "WRITE: run a command. Requires terminal write consent.", connector: "terminal", scope: "write", jsonSchema: {} },
	{ name: "terminal_send_keys", description: "WRITE: send keys. Requires terminal write consent.", connector: "terminal", scope: "write", jsonSchema: {} },
	{ name: "terminal_new_target", description: "WRITE: open a target.", connector: "terminal", scope: "write", jsonSchema: {} },
	{ name: "terminal_kill_target", description: "WRITE: kill a target.", connector: "terminal", scope: "write", jsonSchema: {} },
];
const TERMINAL_READ: PromptTool = { name: "terminal_list_targets", description: "List targets.", connector: "terminal", scope: "read", jsonSchema: {} };

describe("#399 — the prompt states the RESOLVED consent, never the bare rule", () => {
	// The guard the issue asks for by name. An instance with write consent GRANTED must not be told
	// its tools need a consent: that sentence is what made a working agent refuse the work, invent a
	// reason, and send its owner to switch on a setting that was already on.
	it("a granted write tool is never labelled as needing consent", () => {
		const prompt = connectorToolsPrompt([...TERMINAL_WRITES, TERMINAL_READ], ["terminal"]);
		expect(prompt).not.toContain("needs the connector's consent");
		expect(prompt).not.toMatch(/NOT granted/);
		for (const t of TERMINAL_WRITES) expect(prompt).toContain(`- ${t.name} [write — consent GRANTED, you may call this]`);
	});

	it("says what the agent may DO, not merely that a check passed", () => {
		// "consent ok" is still a permission note, and a permission note is what the model read as a
		// reason to stop. The label has to be an instruction.
		expect(consentLabel("granted", "write", "terminal")).toContain("you may call this");
	});

	it("an UNgranted write tool says so, and names the connector — not the surface", () => {
		// The surface and the consent key are not always the same word: a `tmux` surface is served by
		// the `terminal` connector, and granting `tmux` write looks right and does nothing (#351). An
		// agent that names the wrong one sends its owner on the same dead errand by another route.
		const prompt = connectorToolsPrompt(TERMINAL_WRITES, []);
		expect(prompt).toContain("consent NOT granted");
		expect(prompt).toContain("write access for the terminal connector");
	});

	it("reads carry no consent label at all", () => {
		// A label on every line is a label that stops being read — which is how the unconditional
		// suffix became invisible-yet-obeyed in the first place.
		const prompt = connectorToolsPrompt([TERMINAL_READ], []);
		expect(prompt).toContain("- terminal_list_targets: List targets.");
		expect(prompt).not.toMatch(/\[write/);
	});

	it("distinguishes the two per-call gates instead of flattening them to 'blocked'", () => {
		// MCP is granted per (server, tool) even when the connector row exists (#262); http_request
		// is a READ tool whose verb decides (#307). Both are "sometimes yes" and neither is a reason
		// to refuse outright.
		const mcp: PromptTool = { name: "mcp_call_tool", description: "Call a remote tool.", connector: "mcp", scope: "write", jsonSchema: {} };
		expect(connectorToolsPrompt([mcp], ["mcp"])).toContain("granted per server");

		const http: PromptTool = {
			name: "http_request",
			description: "Call any REST API.",
			connector: "http",
			scope: "read",
			jsonSchema: { properties: { method: { type: "string" } } },
		};
		expect(connectorToolsPrompt([http], [])).toContain("CHANGES anything");
		expect(connectorToolsPrompt([http], ["http"])).not.toMatch(/\[/);
	});
});

describe("#399 item 2 — the remedy is stated once, by the platform", () => {
	it("every connector-tool prompt carries the rule, granted or not", () => {
		// Left to itself each agent composes its own version; the reported message named the right
		// console tab by luck. Present in BOTH states because the two failure directions are
		// opposite: without it a granted tool is still read as gated, and a genuinely blocked one is
		// explained by invention.
		expect(connectorToolsPrompt(TERMINAL_WRITES, ["terminal"])).toContain(CONSENT_RULE);
		expect(connectorToolsPrompt(TERMINAL_WRITES, [])).toContain(CONSENT_RULE);
	});

	it("forbids both halves of the reported failure", () => {
		expect(CONSENT_RULE).toContain("Never decline a granted tool");
		expect(CONSENT_RULE).toContain("without a line above saying it is not granted");
		expect(CONSENT_RULE).toContain("Settings → Connections");
	});

	it("tells the agent the labels are ITS current permissions, not a general rule", () => {
		// The model has a strong prior that a documented gate applies to it. Saying "resolved" and
		// "current" is what makes the granted label outrank that prior.
		expect(CONSENT_RULE).toMatch(/resolved/);
		expect(CONSENT_RULE).toMatch(/CURRENT/);
	});
});

describe("connectorToolsPrompt shape", () => {
	it("emits nothing for an agent with no connector tools", () => {
		expect(connectorToolsPrompt([], ["terminal"])).toBe("");
	});

	it("still tells the agent to act directly rather than delegate to the human or a CLI", () => {
		// Pre-existing behaviour (#254's neighbour): the Coder ran `gh issue create` in a terminal
		// instead of calling its own github tool. #399 must not drop it.
		const prompt = connectorToolsPrompt(TERMINAL_WRITES, ["terminal"]);
		expect(prompt).toContain("never tell the user to do it themselves");
		expect(prompt).toContain("never route it through a terminal/CLI");
	});
});
