/**
 * Migration 0099 (#403) makes the tmux Operator a tmux agent BY CONSTRUCTION: it declares the six
 * backend-exclusive `tmux_*` tools instead of the generic `terminal_*` ones, which default to
 * `backend: "all"` and had it reading the owner's iTerm2 windows.
 *
 * That claim is only true while three things hold, none of which a SQL file can state:
 *
 *   1. every declared name is really a tool on the registry's `tmux` connector — a typo does not
 *      fail a build, it produces an agent with no terminal tools at all;
 *   2. every declared name survives `toolNamesFor` — a name outside CREATOR_SELECTABLE_TOOLS is
 *      silently dropped, which is the same tool-less agent by a quieter route (see the
 *      `delete_record` note in agent-do-tools.ts for the last time that happened);
 *   3. nothing generic came back. The whole point is that there is no iTerm2 code path behind
 *      these tools, so "tmux only" is a fact rather than an instruction the model may ignore.
 *
 * Checked the way 0087's and 0057's seeds are: parse what the migration will actually write, then
 * resolve it through the REAL registry and the REAL capability plumbing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentCapabilities, sanitizeToolList } from "./agent-capabilities.js";
import { lintAgentClaims } from "./agent-claims-lint.js";
import { registryConnectorGroups } from "./tool-registry.js";
import { toolNamesFor } from "../agent-do-tools.js";

const SQL = readFileSync(fileURLToPath(new URL("../../migrations/0099_tmux_operator_backend_exclusive_tools.sql", import.meta.url)), "utf8");
const SEED_0072 = readFileSync(fileURLToPath(new URL("../../migrations/0072_seed_tmux_operator_agent.sql", import.meta.url)), "utf8");

/** The tool list 0099 writes into `$.capabilities.tools`. */
const DECLARED: string[] = JSON.parse(/json\('(\[[\s\S]*?\])'\)/.exec(SQL)?.[1] ?? "[]");

/** The connector tool names, from the registry itself rather than restated here. */
const groups = registryConnectorGroups();
const TMUX_TOOLS = groups.find((g) => g.connector === "tmux")?.tools ?? [];
const TERMINAL_TOOLS = groups.find((g) => g.connector === "terminal")?.tools ?? [];

/**
 * The row as it will stand after 0099: 0072/0073 set surfaces + runtime and this migration
 * replaces only the tool list, so this is the resolved capability the runtime will see.
 */
const CAPS = agentCapabilities({
	slug: "tmux-operator",
	category: "coding",
	config: JSON.stringify({ capabilities: { surfaces: ["tmux"], runtime: "coding", workflow: null, tools: DECLARED } }),
});

describe("migration 0099 — the tmux Operator's declared tools (#403)", () => {
	it("declares the six tmux tools the issue names", () => {
		expect(DECLARED).toEqual([
			"tmux_list_sessions",
			"tmux_capture_pane",
			"tmux_run_command",
			"tmux_send_keys",
			"tmux_new_session",
			"tmux_kill_session",
		]);
	});

	it("declares names that exist on the registry's tmux connector, and all of them", () => {
		// Both directions on purpose. A name that does not exist is a tool the agent will never
		// get; a tmux tool left undeclared is a capability quietly removed from an agent whose
		// whole job is that connector.
		expect([...DECLARED].sort()).toEqual([...TMUX_TOOLS].sort());
	});

	it("declares nothing from the generic terminal connector", () => {
		// The defect itself: `terminal_list_targets` defaults to `backend: "all"`, so ONE of these
		// names is enough to put kitty and iTerm2 back within reach.
		expect(DECLARED.filter((t) => TERMINAL_TOOLS.includes(t))).toEqual([]);
	});

	it("survives the sanitiser and the resolver without losing a tool", () => {
		expect(sanitizeToolList(DECLARED)).toEqual(DECLARED);
		expect(CAPS.tools).toEqual(DECLARED);
	});

	it("actually reaches the model: toolNamesFor grants all six and no terminal_*", () => {
		// The gate that decides what the agent may run. A declared name outside
		// CREATOR_SELECTABLE_TOOLS is dropped here without a word, so the migration would look
		// applied and change nothing.
		const granted = toolNamesFor(CAPS);
		for (const name of DECLARED) expect(granted.has(name)).toBe(true);
		for (const name of TERMINAL_TOOLS) expect(granted.has(name)).toBe(false);
	});

	it("keeps the write decision the owner already made", () => {
		// Consent is keyed by connector, so changing connector silently revokes it. 0073 carried
		// tmux → terminal; this carries it back, scoped to this agent's instances.
		expect(SQL).toMatch(/INSERT OR IGNORE INTO instance_connector_consent/);
		expect(SQL).toMatch(/a\.slug = 'tmux-operator'/);
	});
});

describe("migration 0099 — kitty and iTerm2 cannot be fixed this way, so they say so", () => {
	const kitty = /slug = 'kitty-operator'/.test(SQL) ? /SET description = '(Test agent for the kitty[\s\S]*?)',/.exec(SQL)?.[1] ?? "" : "";
	const iterm = /slug = 'iterm-operator'/.test(SQL) ? /SET description = '(Test agent for the iTerm2[\s\S]*?)',/.exec(SQL)?.[1] ?? "" : "";

	it("has no kitty or iterm2 connector to declare — which is the point", () => {
		// If either ever appears, this test is the reminder that these two rows can now be fixed
		// the same way the tmux Operator was, instead of waiting on #402.
		expect(groups.map((g) => g.connector)).not.toContain("kitty");
		expect(groups.map((g) => g.connector)).not.toContain("iterm2");
	});

	it("tells the reader the agent is not limited to the backend in its name", () => {
		for (const description of [kitty, iterm]) {
			expect(description).toMatch(/reach tmux, kitty and iTerm2 alike/);
			expect(description).toMatch(/every local terminal/);
		}
	});
});

describe("what the claims lint (#362) can and cannot see", () => {
	// Recorded, not aspirational. All three rows pass the lint before AND after this migration,
	// because it asks whether a RUNTIME claim is backed by `runtime`/`workflow` — and all three
	// genuinely declare `runtime: "coding"`. What they overstate is WHICH RESOURCE the runtime
	// reaches, which no amount of description-vs-runtime checking can detect. Widening the lint
	// is not the fix either: the fix is #404, after which the constraint is declared data the
	// lint could read. This test exists so the green tick is never mistaken for a verdict on the
	// defect #403 is about.
	const backed = { runtime: "coding", workflow: null };
	const tmuxDescription = /\n {2}'(Control tmux sessions[\s\S]*?)',\n/.exec(SEED_0072)?.[1] ?? "";

	it("finds nothing wrong with the tmux Operator — it never did", () => {
		expect(tmuxDescription).toMatch(/tmux/);
		expect(lintAgentClaims({ description: tmuxDescription, capabilities: backed })).toEqual([]);
	});

	it("finds nothing wrong with a description that names a backend it cannot be limited to", () => {
		expect(lintAgentClaims({ description: "Test agent for the kitty backend of the generic ProAgentStore terminal connector.", capabilities: backed })).toEqual([]);
		expect(lintAgentClaims({ description: "Test agent for the iTerm2 backend of the generic ProAgentStore terminal connector.", capabilities: backed })).toEqual([]);
	});

	it("still fires on the claim it is actually about — an unbacked runtime", () => {
		expect(lintAgentClaims({ description: tmuxDescription, capabilities: { runtime: null, workflow: null } })).not.toHaveLength(0);
	});
});
