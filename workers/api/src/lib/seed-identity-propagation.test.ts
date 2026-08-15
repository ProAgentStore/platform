/**
 * A seed IDENTITY patch cannot reach an instance that already exists (#496).
 *
 * Instance identity is copied ONCE, at subscribe (`routes/instances.ts` → the DO's `/init` with
 * `personality`/`goal`/`guardrails`/`welcomeMessage`), and after that it lives in the Durable
 * Object. `agent_instances` has no personality column, so a migration — which can only write D1 —
 * physically cannot reach it. The migration runs, CI is green, the `agents` row is correct, and
 * every running instance is unchanged. That is the whole failure: it is invisible.
 *
 * Capabilities are the CONTRAST, and it is worth stating precisely because the two look alike in a
 * migration diff: `capabilitiesForInstance` JOINs the `agents` row at read time, so a capability
 * patch DOES reach live instances. Both properties are asserted below rather than described, since
 * "which half of the config am I editing" is exactly what the next author has to know.
 *
 * So this file is a ratchet, in the shape `pipelines/seed-drift.test.ts` already uses: any
 * migration that patches `$.identity.*` on an EXISTING agent row must be listed here with the
 * second route by which its content still reaches a live instance — or the list must record that
 * it deliberately does not. A new one fails this test until its author has answered that, which is
 * the only moment the answer is cheap.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentCapabilities, capabilitiesForInstance } from "./agent-capabilities.js";
import { TERMINAL_CLI_PROTOCOL, connectorToolsPrompt, type PromptTool } from "./connector-tool-prompt.js";
import { registryTools } from "./tool-registry.js";
import { toolNamesFor } from "../agent-do-tools.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url).href);
const readMigration = (name: string) => readFileSync(`${MIGRATIONS_DIR}/${name}`, "utf8");

/**
 * Every migration that patches an identity path on an agent row that may already have instances.
 *
 * The signature is a `json_set`/`json_patch` naming a `$.identity` path — an INSERT-shaped seed is
 * NOT one of these, and must not be: a brand-new agent has no instances to miss, and every future
 * subscriber gets the identity by the copy that already works.
 */
const IDENTITY_PATCHES = readdirSync(MIGRATIONS_DIR)
	.filter((f) => f.endsWith(".sql"))
	.filter((f) => /json_(set|patch)\([\s\S]*?\$\.identity/.test(readMigration(f)))
	.sort();

/**
 * The recorded answer for each one. Adding a migration means adding a line here, and the line has
 * to name a route that does not go through the subscribe-time copy — or say plainly that there
 * isn't one, which is a decision rather than an oversight.
 */
const PROPAGATION: Record<string, string> = {
	// #483 wrote the interactive-CLI protocol in two places on purpose: the seed personality AND
	// the CONNECTED TOOLS block. Only the second half reaches the two live tmux Operators, and it
	// reaches them because the tool list resolves from the `agents` row every turn. The test below
	// proves that rather than trusting it.
	"0118_operator_interactive_cli_protocol.sql": "connector-tool-prompt.ts TERMINAL_CLI_PROTOCOL",
};

describe("seed identity patches — each one records how it reaches an EXISTING instance (#496)", () => {
	it("has an entry for every migration that patches $.identity on an existing agent row", () => {
		// The failure this exists to produce: a new identity patch lands, this list does not know
		// it, and the author finds out here — before shipping — that a migration cannot reach the
		// instances the fix was written for.
		expect(IDENTITY_PATCHES).toEqual(Object.keys(PROPAGATION).sort());
	});

	it("does not count an INSERT-shaped seed, which has no instances to miss", () => {
		// Guard on the detector itself. If the regex ever started matching every `"identity"` key
		// in a seed's config blob, the list above would fill with rows that were never at risk and
		// the check would be noise rather than a boundary.
		expect(IDENTITY_PATCHES).not.toContain("0072_seed_tmux_operator_agent.sql");
		expect(IDENTITY_PATCHES).not.toContain("0112_seed_single_pane_operator_agent.sql");
		expect(IDENTITY_PATCHES).not.toContain("0087_seed_portal_watch_agent.sql");
	});

	it("does not count a CAPABILITY patch, because that one already reaches live instances", () => {
		// 0112 patches `$.capabilities.surfaceOptions.terminal.backends` on rows that DO have
		// instances, and is correct to: capabilities resolve from the agents row at read time. The
		// contrast is the point — the risky edit is identity, not "any json_set on agents".
		const sql = readMigration("0112_seed_single_pane_operator_agent.sql");
		expect(sql).toMatch(/json_set\([\s\S]*?\$\.capabilities/);
		expect(IDENTITY_PATCHES).not.toContain("0112_seed_single_pane_operator_agent.sql");
	});
});

describe("capabilities DO reach a live instance — the property identity lacks", () => {
	it("resolves an instance's capabilities by JOINing the agents row, not from a stored copy", async () => {
		// Asserted directly, because the whole design question in #496 is why one half of an
		// agent's declaration follows the template and the other half does not. A stored copy
		// would answer from `agent_instances`; this reads the CREATOR's row through the join, so
		// editing it is felt by instances that subscribed long before.
		const sqls: string[] = [];
		const env = {
			DB: {
				prepare(sql: string) {
					sqls.push(sql);
					return {
						bind: () => ({
							first: async () => ({
								slug: "tmux-operator",
								category: "coding",
								config: JSON.stringify({ capabilities: { surfaces: ["tmux"], runtime: "coding", workflow: null, tools: ["tmux_capture_pane"] } }),
							}),
						}),
					};
				},
			},
		} as unknown as { DB: D1Database };
		const caps = await capabilitiesForInstance(env as never, "i1", "u1");
		expect(sqls[0]).toMatch(/agent_instances i JOIN agents a/);
		expect(caps?.tools).toEqual(["tmux_capture_pane"]);
	});
});

/**
 * 0118's second route, proved end to end rather than asserted in a comment.
 *
 * The rule HEADINGS are extracted from both sides and compared. Full-text equality is not the
 * property — the two are worded for different readers, and the code side spells tool names in
 * backticks — but a rule that exists on one side and not the other is exactly the drift that made
 * half of #483 ship to nobody.
 */
describe("0118 — the protocol reaches an instance that subscribed before it (#483, #496)", () => {
	const SQL_0118 = readMigration("0118_operator_interactive_cli_protocol.sql");
	const SQL_0117 = readMigration("0117_tmux_operator_send_message_tool.sql");
	const headings = (text: string) => [...text.matchAll(/\n(\d+\. [A-Z][A-Z ]+):/g)].map((m) => m[1]);

	/** What a live tmux Operator's prompt actually contains, built from the real seed + registry. */
	const declaredTools: string[] = JSON.parse(/json\('(\[[\s\S]*?\])'\)/.exec(SQL_0117)?.[1] ?? "[]");
	const caps = agentCapabilities({
		slug: "tmux-operator",
		category: "coding",
		config: JSON.stringify({ capabilities: { surfaces: ["tmux"], runtime: "coding", workflow: null, tools: declaredTools } }),
	});
	const granted = toolNamesFor(caps);
	const operatorTools: PromptTool[] = registryTools()
		.filter((t) => granted.has(t.name) && t.connector)
		.map((t) => ({ name: t.name, description: t.description, connector: t.connector, scope: t.scope, jsonSchema: t.jsonSchema }));
	const block = connectorToolsPrompt(operatorTools, ["tmux"]);

	it("states three rules in the seed personality, and the same three in the code constant", () => {
		const seed = headings(SQL_0118);
		const code = headings(TERMINAL_CLI_PROTOCOL);
		expect(code).toEqual(["1. WAIT FOR READY", "2. SUBMIT WITH ENTER", "3. CONFIRM IT LANDED"]);
		// Two rows are patched (tmux-operator, single-pane-operator), so the seed side carries the
		// three headings twice. Both must match the code, or one operator quietly diverges.
		expect(seed).toEqual([...code, ...code]);
	});

	it("delivers those rules to an EXISTING instance, which the DO copy cannot", () => {
		// This is the mitigation #483 accidentally relied on: the tool list resolves from the
		// agents row every turn, so the block is rebuilt per message for instances that were
		// initialised long before the rules existed.
		for (const h of headings(TERMINAL_CLI_PROTOCOL)) expect(block).toContain(h);
	});

	it("would stop delivering them if the agent lost its terminal tools — so the guard is real", () => {
		// The second route is conditional (`hasTerminalTools`). Naming the condition here means a
		// future agent that carries the seed rules WITHOUT those tools is a known gap rather than a
		// surprise: for it, the personality copy would be the only route, and there isn't one.
		const noTerminal = connectorToolsPrompt(
			// `jsonSchema` is required by `PromptTool` but plays no part in what this case measures —
			// the point is a tool list with NO terminal connector in it.
			[{ name: "github_list_issues", description: "d", connector: "github", scope: "read", jsonSchema: {} }],
			[],
		);
		expect(noTerminal).not.toContain("INTERACTIVE CLI PROTOCOL");
	});
});
