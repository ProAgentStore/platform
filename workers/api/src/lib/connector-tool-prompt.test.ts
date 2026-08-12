import { describe, expect, it } from "vitest";
import {
	CONSENT_RULE,
	TERMINAL_CLI_PROTOCOL,
	TOOL_LIST_CLOSED,
	TOOL_REFUSAL_RELAY,
	connectorToolsPrompt,
	consentLabel,
	type PromptTool,
} from "./connector-tool-prompt.js";
import { registryToolDefs, registryTools } from "./tool-registry.js";

/** The four write tools from the reported instance, as the registry declares them. */
const TERMINAL_WRITES: PromptTool[] = [
	{ name: "terminal_run_command", description: "WRITE: run a command.", connector: "terminal", scope: "write", jsonSchema: {} },
	{ name: "terminal_send_keys", description: "WRITE: send keys.", connector: "terminal", scope: "write", jsonSchema: {} },
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

describe("#419 — no tool description restates the consent rule", () => {
	// The half of #399 that was diagnosed and not fixed. The label above each line is resolved per
	// instance per turn by `writeConsentOf`; a static sentence in the description can only ever
	// repeat it — and when the label says GRANTED and the sentence says a consent is required, the
	// model's plainest reading is that it is blocked. Twelve of these accumulated by copy-paste from
	// the previous connector, which is why the guard is a test and not a review note.
	it("NO registry tool description contains the phrase 'write consent'", () => {
		const offenders = registryToolDefs()
			.filter((t) => t.description.toLowerCase().includes("write consent"))
			.map((t) => t.name);
		expect(offenders).toEqual([]);
	});

	// The two tools that legitimately say something about consent in their own description. Neither
	// is this gate, so neither may be swept up by a future blanket edit — asserted POSITIVELY so the
	// sweep fails here rather than silently flattening a distinction that was filed for.
	it("mcp_call_tool keeps its PER-SERVER wording (#262) — a finer gate than the connector grant", () => {
		// Outbound MCP consent is per (instance, endpoint, tool), so "the connector is granted" is
		// not the answer to "may I call this". `consentLabel`'s `per_call` branch words the label
		// correctly; the description carries the part the label cannot: WHICH server and tool.
		const mcp = registryToolDefs().find((t) => t.name === "mcp_call_tool");
		expect(mcp?.description).toContain("that specific server and tool");
	});

	it("http_request stays scope:'read' with its per-CALL method caveat (#307)", () => {
		// Its gate is the HTTP method the caller chose, not a connector grant, so `consentLabel`
		// cannot express it and the description is the right place. A GET must never need write
		// consent — demanding it for a pipeline that only looks things up trains an owner to grant
		// blanket write.
		const http = registryTools().find((t) => t.name === "http_request");
		expect(http?.scope).toBe("read");
		expect(http?.description).toContain("HTTPS-only, SSRF-guarded");
	});

	// Acceptance, stated end-to-end against the REAL registry rather than the fixtures above: the
	// block a granted tmux/terminal agent actually receives.
	it("a rendered block for a granted terminal agent says GRANTED and never asks for consent", () => {
		const terminalTools: PromptTool[] = registryTools()
			.filter((t) => t.connector === "terminal")
			.map((t) => ({ name: t.name, description: t.description, connector: t.connector, scope: t.scope, jsonSchema: t.jsonSchema }));
		expect(terminalTools.length).toBeGreaterThan(0);

		const block = connectorToolsPrompt(terminalTools, ["terminal"]);
		expect(block).toContain("consent GRANTED");
		expect(block).not.toMatch(/requires[^.]*write consent/i);
		// CONSENT_RULE is the one place the block is allowed to talk about a consent NOT being
		// granted; nothing on a tool line may.
		const toolLines = block.split("\n").filter((l) => l.startsWith("- "));
		for (const line of toolLines) expect(line.toLowerCase()).not.toContain("write consent");
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

describe("#493 — the tool list is CLOSED, so an absent system cannot be offered", () => {
	// The production incident: a tmux Operator with seven `tmux_*` tools and no `github_*` at any
	// scope was asked four times for the open GitHub issues, and answered "tell me the repo name so
	// I can pull up the issues right now". It was given the repo. It asked again. Nothing in the
	// prompt had ever said the list it was reading was the whole list.
	it("states the list is complete", () => {
		expect(TOOL_LIST_CLOSED).toContain("COMPLETE");
		expect(TOOL_LIST_CLOSED).toContain("every external system you are connected to");
	});

	it("forbids the exact move that wasted three turns — asking for a detail only a missing tool could use", () => {
		expect(TOOL_LIST_CLOSED).toContain("Never ask for a detail");
		expect(TOOL_LIST_CLOSED).toMatch(/a repo, an org, an account, a URL/);
		expect(TOOL_LIST_CLOSED).toContain("never offer to look something up in a system that is not listed");
	});

	it("forbids the promise itself, which is the part that survives every other guard", () => {
		// #395/#398/#406 and `invented-results.ts` all police an invented RESULT. This was a
		// promise about a FUTURE call, which none of them can see: there was no result to strip.
		expect(TOOL_LIST_CLOSED).toContain("never promise a lookup you have not made");
		expect(TOOL_LIST_CLOSED).toContain("call it in the SAME reply and report what it returned");
	});

	it("does NOT claim the agent has no way at all to reach an unlisted system", () => {
		// The issue proposed "you have no way to reach it". That is false: `fetch_url` is in BASE
		// and BASE is seeded even under a declared `capabilities.tools` allowlist, so every agent
		// can fetch a public URL. Closing the list on an absolute the platform cannot honour would
		// install the very class of false statement this ticket is about. The true, sufficient
		// claim is the narrower one: no DEDICATED tool.
		expect(TOOL_LIST_CLOSED).toContain("you have no tool for");
		expect(TOOL_LIST_CLOSED).not.toMatch(/no way to reach/i);
		expect(TOOL_LIST_CLOSED).toContain("a general-purpose tool you DO hold");
	});

	it("does not send the owner to Settings for a tool that is not there to be switched on", () => {
		// It sits next to CONSENT_RULE, which ends by pointing at Settings → Connections. That is
		// right for a LISTED tool whose consent is ungranted and wrong here: a subscriber can
		// disable a tool but cannot add one, so "ask your owner to connect GitHub" is the same
		// dead errand as the original by a different route.
		expect(TOOL_LIST_CLOSED).toContain("do NOT send the owner to Settings");
		expect(TOOL_LIST_CLOSED).toContain("fixed by the agent's definition");
	});

	it("is injected into every CONNECTED TOOLS block, granted or not", () => {
		expect(connectorToolsPrompt(TERMINAL_WRITES, ["terminal"])).toContain(TOOL_LIST_CLOSED);
		expect(connectorToolsPrompt(TERMINAL_WRITES, [])).toContain(TOOL_LIST_CLOSED);
		expect(connectorToolsPrompt([TERMINAL_READ], [])).toContain(TOOL_LIST_CLOSED);
	});

	it("closes the tool list the way selfDescriptionPrompt already closes the TAB list", () => {
		// The asymmetry IS the mechanism: one enumeration in the prompt carried an explicit NEVER
		// and the other carried nothing, so the model read the open one as illustrative.
		const prompt = connectorToolsPrompt([TERMINAL_READ], []);
		expect(prompt).toMatch(/NOT on it/);
		expect(prompt).toMatch(/no tool for/);
	});
});

describe("#483 — TERMINAL_CLI_PROTOCOL injected for terminal/tmux agents", () => {
	// The production incident: the Operator reported "up and ready" the instant claude launched,
	// before the TUI painted, then silently dropped the first message because the pane was not
	// at the CLI's input prompt. The three protocol rules close the three failure points.
	it("is present in TERMINAL_CLI_PROTOCOL constant", () => {
		expect(TERMINAL_CLI_PROTOCOL).toContain("WAIT FOR READY");
		expect(TERMINAL_CLI_PROTOCOL).toContain("SUBMIT WITH ENTER");
		expect(TERMINAL_CLI_PROTOCOL).toContain("CONFIRM IT LANDED");
		expect(TERMINAL_CLI_PROTOCOL).toContain("tmux_send_message");
		expect(TERMINAL_CLI_PROTOCOL).toContain("changed is false");
	});

	it("is injected into the CONNECTED TOOLS block for a terminal-connector agent", () => {
		const prompt = connectorToolsPrompt([...TERMINAL_WRITES, TERMINAL_READ], ["terminal"]);
		expect(prompt).toContain(TERMINAL_CLI_PROTOCOL);
	});

	it("is injected for a tmux-connector agent too", () => {
		const tmuxTool: PromptTool = { name: "tmux_list_sessions", description: "List sessions.", connector: "tmux", scope: "read", jsonSchema: {} };
		const prompt = connectorToolsPrompt([tmuxTool], []);
		expect(prompt).toContain(TERMINAL_CLI_PROTOCOL);
	});

	it("is NOT injected for agents with only non-terminal tools (e.g. github)", () => {
		const githubTool: PromptTool = { name: "github_create_issue", description: "Create issue.", connector: "github", scope: "write", jsonSchema: {} };
		const prompt = connectorToolsPrompt([githubTool], ["github"]);
		expect(prompt).not.toContain("INTERACTIVE CLI PROTOCOL");
	});
});

describe("#517 — a REFUSED tool's own remedy may not be swapped for an invented one", () => {
	// The production incident: a creator's tmux Operator, asked on the agent page to list tmux
	// sessions, was refused by the capability-constraint gate — whose result ends with the true
	// remedy, "run this from a subscribed instance" — and answered "go to Settings → Connections in
	// the console and connect a tmux instance". No console screen links a tmux instance. 5/5 across
	// two agents and two connectors, including a first turn on an empty conversation.
	it("names the trigger #493 left open: a tool that IS on the list, was called, and was refused", () => {
		// TOOL_LIST_CLOSED's trigger is "a system that is NOT on it", so the model was outside that
		// sentence rather than in breach of it. This one has to say CALLED and REFUSED.
		expect(TOOL_REFUSAL_RELAY).toMatch(/CALLED/);
		expect(TOOL_REFUSAL_RELAY).toMatch(/refused or failed/);
		expect(TOOL_REFUSAL_RELAY).toContain("relay THAT");
	});

	it("forbids the substitution itself — a location the refusal did not name", () => {
		expect(TOOL_REFUSAL_RELAY).toContain("Never name a console page, tab, section, setting or switch that the refusal itself did not name");
		expect(TOOL_REFUSAL_RELAY).toContain("never offer a fix you were not told works");
	});

	it("says what to do when the refusal names no location, rather than leaving a gap to fill", () => {
		// A prohibition with nothing in its place is how the previous invention got composed. The
		// refusal's own final clause IS the answer, so the clause states it as the example.
		expect(TOOL_REFUSAL_RELAY).toContain("there is no switch to flip");
		expect(TOOL_REFUSAL_RELAY).toContain("from a subscribed instance");
	});

	it("scopes the CONSENT remedy to a consent refusal, which is where the invented phrase came from", () => {
		// Not incidental: on the agent-template surface `listConsents` is handed an agent id and
		// consent rows are keyed by instance id, so every write tool renders "consent NOT granted"
		// and CONSENT_RULE — directly above — points at console → Settings → Connections. The
		// authorised remedy for a case that did not apply was the nearest thing to hand.
		const tmuxTools: PromptTool[] = [
			{ name: "tmux_list_sessions", description: "List sessions.", connector: "tmux", scope: "read", jsonSchema: {} },
			{ name: "tmux_run_command", description: "WRITE: run a command.", connector: "tmux", scope: "write", jsonSchema: {} },
		];
		const templateSurface = connectorToolsPrompt(tmuxTools, []);
		expect(templateSurface).toContain("consent NOT granted");
		expect(templateSurface).toContain("Settings → Connections");
		expect(TOOL_REFUSAL_RELAY).toContain("the remedy for a CONSENT refusal only");
		expect(TOOL_REFUSAL_RELAY).toContain("not fixed by enabling write access");
	});

	it("is NOT a blocklist of the word 'Settings' — a consent refusal is genuinely fixed there", () => {
		// #517's stated regression risk. TmuxTab tells a user to grant kill access in Settings and
		// the write-consent refusal names "the instance's Connections settings" itself, so a rule
		// worded against the string would forbid the one case where it is right — and would rot the
		// first time the console renames a tab.
		expect(TOOL_REFUSAL_RELAY).not.toMatch(/never (mention|say) Settings/i);
		expect(CONSENT_RULE).toContain("Settings → Connections");
	});

	it("is injected into every CONNECTED TOOLS block, and after the two rules it narrows", () => {
		const prompt = connectorToolsPrompt(TERMINAL_WRITES, []);
		expect(prompt).toContain(TOOL_REFUSAL_RELAY);
		expect(connectorToolsPrompt([TERMINAL_READ], ["terminal"])).toContain(TOOL_REFUSAL_RELAY);
		// Order is the point: CONSENT_RULE names a console location and TOOL_LIST_CLOSED forbids
		// naming one; this decides which applies to a present-but-refused tool, so it reads last.
		expect(prompt.indexOf(TOOL_REFUSAL_RELAY)).toBeGreaterThan(prompt.indexOf(CONSENT_RULE));
		expect(prompt.indexOf(TOOL_REFUSAL_RELAY)).toBeGreaterThan(prompt.indexOf(TOOL_LIST_CLOSED));
	});

	it("emits nothing for an agent with no connector tools", () => {
		expect(connectorToolsPrompt([], [])).toBe("");
	});
});
