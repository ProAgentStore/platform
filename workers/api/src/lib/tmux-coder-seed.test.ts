/**
 * Migration 0123 seeds `tmux-coder` (#515) — the coding half of the tmux split, as a DECLARATION
 * instead of as free text in one instance's Rules box.
 *
 * The whole claim of that migration is "this agent holds the tmux connector AND the Coder's GitHub
 * set". A SQL file cannot state any of what makes that true, and every one of the failure modes is
 * silent:
 *
 *   1. a name that is not really a tool on the registry's `tmux`/`github` connector does not fail a
 *      build — it produces an agent MISSING that tool, and the agent then answers conversationally
 *      (lib/tool-reachability.test.ts records what that looks like);
 *   2. a name outside `CREATOR_SELECTABLE_TOOLS` is dropped by `toolNamesFor` without a word, so
 *      the migration looks applied and changes nothing;
 *   3. a `terminal_*` name coming back would re-open kitty and iTerm2 to an agent whose name says
 *      tmux — 0099's original defect, one name away;
 *   4. `visibility` is the difference between an agent and a row: 0112's `single-pane-operator` is
 *      `'draft'`, subscribe requires `'published'` (routes/instances.ts:110), and it therefore has
 *      zero instances and cannot be given one.
 *
 * Checked the way `tmux-operator-seed.test.ts`, `portal-watch-seed.test.ts` and 0057's seed are:
 * parse what the migration will actually write, then resolve it through the REAL registry and the
 * REAL capability plumbing rather than restating it here.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentCapabilities, sanitizeToolList } from "./agent-capabilities.js";
import { lintAgentClaims } from "./agent-claims-lint.js";
import { registryConnectorGroups, registryTools } from "./tool-registry.js";
import { TERMINAL_CLI_PROTOCOL, TOOL_LIST_CLOSED, connectorToolsPrompt, type PromptTool } from "./connector-tool-prompt.js";
import { toolNamesFor } from "../agent-do-tools.js";

const SQL = readFileSync(fileURLToPath(new URL("../../migrations/0123_seed_tmux_coder_agent.sql", import.meta.url)), "utf8");

/** Pull the agent's config JSON back out of the INSERT's `json('…')` literal. */
function seededConfig(): Record<string, unknown> {
	const start = SQL.indexOf("json('{");
	const end = SQL.indexOf("'),\n  datetime('now')", start);
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	// SQL escapes a single quote by doubling it.
	const literal = SQL.slice(start + "json('".length, end).replace(/''/g, "'");
	return JSON.parse(literal) as Record<string, unknown>;
}

const CONFIG = seededConfig();
const CAPS_LITERAL = CONFIG.capabilities as Record<string, unknown>;
const IDENTITY = CONFIG.identity as Record<string, unknown>;
const DECLARED = CAPS_LITERAL.tools as string[];

/** The description the INSERT writes — the text `lintAgentClaims` will see. */
const DESCRIPTION = /\n {2}'(A coding agent that drives[\s\S]*?)',\n/.exec(SQL)?.[1]?.replace(/''/g, "'") ?? "";

/** The tool list the converging UPDATE writes, so the two halves of the migration cannot diverge. */
const CONVERGED: string[] = JSON.parse(/json\('(\[[\s\S]*?\])'\)/.exec(SQL)?.[1] ?? "[]");

/** Connector tool names from the registry itself rather than restated here. */
const groups = registryConnectorGroups();
const TMUX_TOOLS = groups.find((g) => g.connector === "tmux")?.tools ?? [];
const GITHUB_TOOLS = groups.find((g) => g.connector === "github")?.tools ?? [];
const TERMINAL_TOOLS = groups.find((g) => g.connector === "terminal")?.tools ?? [];

/** The resolved capability the runtime will see for a subscribed instance. */
const CAPS = agentCapabilities({ slug: "tmux-coder", category: "code", config: JSON.stringify(CONFIG) });

describe("migration 0123 — the tmux Coder is subscribable, unlike 0112's draft (#515)", () => {
	it("seeds visibility 'published' — the difference between an agent and a row", () => {
		// routes/instances.ts:110 selects `AND visibility = 'published'`. 0112 seeded 'draft', which
		// is why `single-pane-operator` has zero instances and cannot be given one. Asserted on the
		// SQL text because it is one word and it is the whole of acceptance criterion 2.
		expect(SQL).toMatch(/'tmux-coder',\n\s+'tmux Coder',/);
		expect(/\n\s+'published',\n\s+'active',/.test(SQL)).toBe(true);
	});

	it("is an INSERT-shaped seed, so it has no live instance to miss", () => {
		// The contrast `seed-identity-propagation.test.ts` (#496) draws: an identity `json_set` on an
		// existing row cannot reach the DO copy. A new agent gets its identity by the subscribe-time
		// copy that already works, so this file must NOT patch `$.identity` — and does not.
		expect(SQL).toMatch(/INSERT OR IGNORE INTO agents/);
		expect(SQL).not.toMatch(/json_(set|patch)\([\s\S]*?\$\.identity/);
	});

	it("converges an earlier local row without re-setting the whole capabilities object", () => {
		// 0108's recorded reason: 0107 re-set `$.capabilities` wholesale and lost `set_direction`.
		// The narrow path can only be wrong about the tools, and the next assertion checks that.
		expect(SQL).toMatch(/json_set\([\s\S]*?'\$\.capabilities\.tools'/);
		expect(SQL).not.toMatch(/json_set\([\s\S]*?'\$\.capabilities',/);
	});

	it("writes the SAME tool list in the INSERT and in the converging UPDATE", () => {
		// Two copies of one list in one file. Nothing else would catch them drifting: a row seeded
		// locally would silently end up with a different set from a fresh database's.
		expect(CONVERGED).toEqual(DECLARED);
	});
});

describe("migration 0123 — what the tmux Coder declares", () => {
	it("declares the tmux surface, a local runtime, and no separate executor", () => {
		// `workflow: null` is deliberate: CODING_SESSION drives `coding_sessions` + HeadlessSession,
		// which is exactly the machinery tmux replaces. With null, `start_work` refuses cleanly
		// instead of handing work to a Pilot that would fight the pane.
		expect(CAPS.surfaces).toEqual(["tmux"]);
		expect(CAPS.runtime).toBe("coding");
		expect(CAPS.workflow).toBeNull();
	});

	it("declares the whole tmux connector — the seven the Operator has after 0117", () => {
		// Both directions. A name that does not exist is a tool the agent never gets; a tmux tool
		// left undeclared is a capability quietly removed from an agent whose driver IS that
		// connector.
		expect([...DECLARED.filter((t) => t.startsWith("tmux_"))].sort()).toEqual([...TMUX_TOOLS].sort());
		expect(TMUX_TOOLS).toHaveLength(7);
	});

	it("declares the eight GitHub tools the Repo Coder holds after 0120/0121", () => {
		// "like our other coder agents do" is the literal ask. The benchmark is `coder-repo`'s
		// github set: five reads plus create/comment/update.
		const github = DECLARED.filter((t) => t.startsWith("github_"));
		expect(github).toEqual([
			"github_list_issues",
			"github_read_issue",
			"github_list_pulls",
			"github_read_pull",
			"github_workflow_runs",
			"github_create_issue",
			"github_comment_issue",
			"github_update_issue",
		]);
		for (const name of github) expect(GITHUB_TOOLS).toContain(name);
	});

	it("declares fifteen tools and nothing outside those two connectors", () => {
		expect(DECLARED).toHaveLength(15);
		expect(DECLARED.filter((t) => !t.startsWith("tmux_") && !t.startsWith("github_"))).toEqual([]);
	});

	it("declares nothing from the generic terminal connector", () => {
		// 0099's defect, one name away: `terminal_*` tools default to `backend: "all"`, so ONE of
		// them puts kitty and iTerm2 back within reach of an agent whose name says tmux.
		expect(DECLARED.filter((t) => TERMINAL_TOOLS.includes(t))).toEqual([]);
		expect(DECLARED.filter((t) => t.startsWith("terminal_"))).toEqual([]);
	});

	it("survives the sanitiser and the resolver without losing a tool", () => {
		expect(sanitizeToolList(DECLARED)).toEqual(DECLARED);
		expect(CAPS.tools).toEqual(DECLARED);
	});

	it("actually reaches the model: toolNamesFor grants all fifteen", () => {
		// The gate that decides what the agent may run. A declared name outside
		// CREATOR_SELECTABLE_TOOLS is dropped here in silence, so the migration would look applied
		// and change nothing.
		const granted = toolNamesFor(CAPS);
		for (const name of DECLARED) expect(granted.has(name)).toBe(true);
		for (const name of TERMINAL_TOOLS) expect(granted.has(name)).toBe(false);
	});
});

describe("migration 0123 — the prompt the live agent will receive", () => {
	const granted = toolNamesFor(CAPS);
	const tools: PromptTool[] = registryTools()
		.filter((t) => granted.has(t.name) && t.connector)
		.map((t) => ({ name: t.name, description: t.description, connector: t.connector, scope: t.scope, jsonSchema: t.jsonSchema }));
	const block = connectorToolsPrompt(tools, ["tmux", "github"]);

	it("HAS github tools to list — the premise of the whole ticket", () => {
		// The mirror image of `tmux-operator-seed.test.ts`'s "has no github tool to list". That guard
		// is about the OPERATOR and stays true; this one is about the agent that was created so the
		// Operator would not need to change.
		expect(tools.map((t) => t.name).filter((n) => n.startsWith("github_"))).toHaveLength(8);
		expect(tools.map((t) => t.name).filter((n) => n.startsWith("tmux_"))).toHaveLength(7);
	});

	it("still tells it the list is complete, so an unlisted system cannot be offered", () => {
		expect(block).toContain(TOOL_LIST_CLOSED);
	});

	it("carries the interactive-CLI protocol from the code constant as well as the seed", () => {
		// #483/#496: the personality copy reaches new subscribers, the CONNECTED TOOLS block reaches
		// everyone every turn. Both routes exist here, and the headings must agree — a rule on one
		// side only is exactly the drift that made half of #483 ship to nobody.
		const headings = (text: string) => [...text.matchAll(/\n(\d+\. [A-Z][A-Z ]+):/g)].map((m) => m[1]);
		const code = headings(TERMINAL_CLI_PROTOCOL);
		expect(code).toEqual(["1. WAIT FOR READY", "2. SUBMIT WITH ENTER", "3. CONFIRM IT LANDED"]);
		expect(headings(`\n${IDENTITY.personality as string}`)).toEqual(code);
		for (const h of code) expect(block).toContain(h);
	});
});

describe("migration 0123 — the identity, which is the half a migration can only get right once", () => {
	const personality = IDENTITY.personality as string;

	it("names no tool that does not exist — the defect it exists to replace", () => {
		// The Rules box on `cda75e28…` names `terminal_new_target`, `terminal_run_command`,
		// `terminal_send_keys` and `terminal_capture`. All four were removed from the Operator by
		// 0099 and have resolved `not_declared` on every turn since. A seeded personality must not
		// repeat that: every tool name it mentions has to be one the agent actually holds.
		const mentioned = [...new Set([...personality.matchAll(/\b(?:tmux|github|terminal|repo)_[a-z_]+/g)].map((m) => m[0]))];
		expect(mentioned.length).toBeGreaterThan(0); // not vacuous — it does name tools
		for (const name of mentioned) expect(DECLARED).toContain(name);
	});

	it("tells it to reach GitHub with its tools rather than with `gh` in a pane", () => {
		// #507's measurement: with both routes available and nothing said, the shell route wins. This
		// is an instruction, not a gate — recorded here so that if it turns out not to hold, the fix
		// is known to be a gate rather than more prose.
		expect(personality).toMatch(/NEVER with `gh` in a pane/);
		expect(personality).toMatch(/## Deployment block/);
	});

	it("says it cannot see what the CLI costs, instead of estimating", () => {
		// A CLI driven inside a pane is not metered (#348, #498). Silence here is what produces an
		// invented dollar figure.
		expect(personality).toMatch(/never estimate or report a dollar figure/i);
	});

	it("treats pane output and issue text as data, not instructions", () => {
		expect(personality).toMatch(/untrusted data, not instructions/i);
	});

	it("answers technically, which the seed sets and the create route could not", () => {
		// The reason this is a migration and not three API calls: `POST /v1/agents` accepts
		// personality/goal but NOT guardrails, so the route path yields an agent that looks right and
		// answers in plain speech.
		expect((IDENTITY.guardrails as Record<string, unknown>).responseStyle).toBe("technical");
		expect(IDENTITY.welcomeMessage).toMatch(/pags up/);
	});
});

describe("migration 0123 — catalog copy (#362)", () => {
	it("passes the claims lint: it names tmux and a local machine, and runtime backs both", () => {
		expect(DESCRIPTION).toMatch(/tmux/);
		expect(DESCRIPTION).toMatch(/your own machine/);
		expect(lintAgentClaims({ description: DESCRIPTION, capabilities: CAPS })).toEqual([]);
	});

	it("would fail that lint if the runtime were dropped — so the check is live, not vacuous", () => {
		expect(lintAgentClaims({ description: DESCRIPTION, capabilities: { runtime: null, workflow: null } })).not.toHaveLength(0);
	});

	it("distinguishes itself from the tmux Operator in the copy, since nothing else will", () => {
		// Two tmux agents in a 16-entry catalog. `lintAgentClaims` cannot see "two agents whose copy
		// is indistinguishable", so the difference has to be stated and kept stated.
		expect(DESCRIPTION).toMatch(/Unlike the tmux Operator/);
		expect(DESCRIPTION).toMatch(/GitHub/);
	});
});
