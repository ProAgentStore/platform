/**
 * A seed patch on an INSTANCE-COPIED config key cannot reach an instance that already exists
 * (#496, and #394 one field over).
 *
 * Two keys are copied at subscribe and never re-read — `$.identity` and `$.pipelines`. They are
 * enumerated in `instance-copied-config.ts`, from the subscribe path itself, together with the
 * decision that makes this file a ratchet rather than a preference: an instance is a SNAPSHOT, not
 * a view, so a migration that patches one of those keys fixes the catalog and reaches nobody who is
 * already running the agent. The migration applies, CI is green, the `agents` row is correct, and
 * every live instance is unchanged. That is the whole failure: it is invisible.
 *
 * How a patch must reach the existing copies depends on ONE property, which the key list carries:
 *
 *   * `$.identity` lives in the instance's Durable Object. `agent_instances` has no personality
 *     column, so a migration — which can only write D1 — physically CANNOT reach it. The second
 *     route has to be code that resolves live, or an owner-initiated `PUT …/state`.
 *   * `$.pipelines` lives in `agent_instances.config`. A migration CAN reach it, so for that key
 *     the recorded route must be a migration that actually does — asserted below, not trusted.
 *
 * Capabilities are the CONTRAST, and it is worth stating precisely because the two look alike in a
 * migration diff: `capabilitiesForInstance` JOINs the `agents` row at read time, so a capability
 * patch DOES reach live instances. `0117` (a tool grant) and `0118` (a personality rule) shipped
 * twenty minutes apart to the same agent and only one arrived. Both properties are asserted below
 * rather than described, since "which half of the config am I editing" is exactly what the next
 * author has to know.
 *
 * So: any migration that patches an instance-copied key on an EXISTING agent row must be listed
 * here with the second route by which its content still reaches a live instance — or the list must
 * record that it deliberately does not. A new one fails this test until its author has answered
 * that, which is the only moment the answer is cheap.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentCapabilities, capabilitiesForInstance } from "./agent-capabilities.js";
import { TERMINAL_CLI_PROTOCOL, connectorToolsPrompt, type PromptTool } from "./connector-tool-prompt.js";
import { INSTANCE_COPIED_CONFIG_KEYS, instanceCopiedKey, instanceCopiedPatchPaths, migrationDdl } from "./instance-copied-config.js";
import { registryTools } from "./tool-registry.js";
import { toolNamesFor } from "../agent-do-tools.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url).href);
const readMigration = (name: string) => readFileSync(`${MIGRATIONS_DIR}/${name}`, "utf8");
const MIGRATIONS = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

/**
 * Every migration that patches an instance-copied path on an agent row that may already have
 * instances, with the paths it patches. The detector's three properties — a `json_set`/`json_patch`,
 * a quoted path literal, in a statement writing `agents` — live in the module, so the list of keys
 * being watched is one greppable thing rather than a regex buried in a test.
 */
const CONFIG_PATCHES: Array<[string, string[]]> = MIGRATIONS.map(
	(f) => [f, instanceCopiedPatchPaths(readMigration(f))] as [string, string[]],
).filter(([, paths]) => paths.length > 0);

const PATCHED_MIGRATIONS = CONFIG_PATCHES.map(([f]) => f);

/**
 * The recorded answer for each one. Adding a migration means adding a line here, and the line has
 * to name a route that does not go through the subscribe-time copy — or say plainly that there
 * isn't one, which is a decision rather than an oversight.
 *
 * A value ending in `.sql` names a migration that writes the instance copy, and is checked as one:
 * the file must exist and must actually write `agent_instances` at that path. Anything else names a
 * code route, which is the only possible answer for a key whose copy is in the Durable Object.
 */
const PROPAGATION: Record<string, string> = {
	// #394: 0111 seeded the fixed 10-step definition onto the agents row, which fixes the catalog
	// for a future subscriber and left the ONE live Lead Finder on the 8-step copy that crashes at
	// 1MiB. This is the shape the guard exists to catch, in a field it was not watching — it sailed
	// through because the detector only knew `$.identity`. 0130 is the remedy: it copies the seeded
	// definition into the instance config, shape-gated so a subscriber's own edit is untouched.
	"0111_seed_lead_finder_pipeline.sql": "lead_finder_pipeline_reaches_live_instances.sql",
	// #483 wrote the interactive-CLI protocol in two places on purpose: the seed personality AND
	// the CONNECTED TOOLS block. Only the second half reaches the two live tmux Operators, and it
	// reaches them because the tool list resolves from the `agents` row every turn. The test below
	// proves that rather than trusting it. There is no migration answer here and there cannot be:
	// identity is DO state.
	"0118_operator_interactive_cli_protocol.sql": "connector-tool-prompt.ts TERMINAL_CLI_PROTOCOL",
	// #706: the Lead Outreach agent's `draft_outreach` definition existed ONLY as instance data, so
	// the seed and its route ship in one file and the route is that file — the second statement
	// writes `agent_instances`. It differs from 0130 in one deliberate way: it FILLS an instance
	// that has no copy and can never overwrite one that has. The definition was read back OFF the
	// one live instance, so that instance is already correct by construction; overwriting it could
	// only discard tuning in exchange for a copy of its own value. Splitting the halves into two
	// files, as 0111 → 0130 had to nineteen migrations apart, would be re-creating the gap on
	// purpose.
	"0132_seed_lead_outreach_pipeline.sql": "seed_lead_outreach_pipeline.sql",
	// #722: 0138 corrects a promise nothing implemented — "It never sends or archives anything
	// until you have seen exactly what it is about to do." The half that the STORE published is
	// the description, a plain column on `agents`, so the catalog, the agent detail page and every
	// future subscriber are corrected the moment the migration applies. The half in `$.identity`
	// (welcomeMessage + goal) is the DO snapshot, and no migration can reach it.
	//
	// There is deliberately no code route, and inventing one would be the wrong trade: identity is
	// precisely what a subscriber may edit on their own copy, so resolving it live from the
	// template would overwrite somebody's edited welcome message in order to fix wording. A live
	// Inbox Chat instance therefore keeps the old welcome until its owner resets state.
	//
	// The residue is named rather than waved away: a stale copy repeats a promise the platform does
	// not keep, on an agent that can send mail. It is bounded — Inbox Chat was seeded by 0136/0137
	// one day before this fix, so the population is small, though the count is NOT measured here
	// (this lane cannot query production). #722's Step 2, a real per-call gate, is what would make
	// the sentence true instead of merely stale.
	"0138_inbox_chat_honest_safety_copy.sql": "owner-initiated PUT /v1/instances/:id/state — the catalog column carries the correction; the DO copy is the owner's",
	// #515 step 2: 0140 gives `tmux-coder` the six read-only `repo-local` tools so that reading a
	// file stops costing a `tmux_run_command` — write-scope arbitrary shell doing a read. That half
	// is `$.capabilities.tools` plus `$.settingsSchema`, and it needs no entry here: both resolve
	// through `capabilitiesForInstance`'s JOIN, so the one live instance
	// (`25501ef7-306b-4a02-ae35-683424344423`) holds the six tools on its very next turn.
	//
	// The half that lands here is the personality section telling it to USE them instead of `cat`
	// and `grep` in a pane. That is DO state, so no migration can reach the existing copy and
	// claiming one would be claiming something impossible. #507 is why the sentence exists at all:
	// with two routes to one outcome and nothing said, the shell route wins — measured, on this
	// agent's own sibling, with `github_create_issue` already granted.
	//
	// The residue is deliberately accepted rather than waved away, and it is small in a way that is
	// checkable rather than hoped: that instance has had no activity since the day it was created
	// (2026-08-12), so what goes stale is one paragraph on an agent nobody has run yet, while the
	// capability it steers arrives anyway. Trading every future subscriber's steering away to avoid
	// it would be the worse deal. The route named is the only real one — and, exactly as on 0138,
	// identity is what a subscriber may edit on their own copy, so resolving it live from the
	// template would overwrite somebody's edit in order to fix wording.
	"0140_tmux_coder_reads_without_the_shell.sql": "owner-initiated PUT /v1/instances/:id/state — the six tools reach the live instance through capabilitiesForInstance; only the sentence steering them does not",
};

describe("seed config patches — each one records how it reaches an EXISTING instance (#496, #394)", () => {
	it("has an entry for every migration that patches an instance-copied key on an existing agent row", () => {
		// The failure this exists to produce: a new patch lands, this list does not know it, and the
		// author finds out here — before shipping — that a migration cannot reach the instances the
		// fix was written for.
		expect(PATCHED_MIGRATIONS).toEqual(Object.keys(PROPAGATION).sort());
	});

	it("watches $.pipelines as well as $.identity — the field 0111 slipped through", () => {
		// The regression #496 reported: the detector was keyed on `$.identity`, 0111 patched
		// `$.pipelines`, and a migration that could not reach the only instance that runs the agent
		// passed the guard written to catch exactly that.
		expect(INSTANCE_COPIED_CONFIG_KEYS.map((k) => k.path).sort()).toEqual(["$.identity", "$.pipelines"]);
		expect(CONFIG_PATCHES).toContainEqual(["0111_seed_lead_finder_pipeline.sql", ["$.pipelines"]]);
		expect(CONFIG_PATCHES).toContainEqual(["0118_operator_interactive_cli_protocol.sql", ["$.identity"]]);
	});

	it("makes a D1-reachable key name a migration that actually writes the instance copy", () => {
		// `$.pipelines` is a column, so "recorded a route" is not enough — the route has to be a
		// migration that writes `agent_instances` at that path. Checked by SUFFIX so renumbering a
		// migration (which happens whenever two lanes land at once) does not need this string edited.
		for (const [file, paths] of CONFIG_PATCHES) {
			if (!paths.some((p) => instanceCopiedKey(p)?.store === "d1")) continue;
			const route = PROPAGATION[file];
			expect(route, `${file} patches a D1-reachable key and must name a migration`).toMatch(/\.sql$/);
			const target = MIGRATIONS.find((m) => m.endsWith(route));
			expect(target, `${file}'s recorded route ${route} is not a migration in this directory`).toBeDefined();
			const ddl = migrationDdl(readMigration(target as string));
			expect(ddl).toMatch(/UPDATE\s+agent_instances/);
			for (const p of paths.filter((p) => instanceCopiedKey(p)?.store === "d1")) expect(ddl).toContain(`'${p}`);
		}
	});

	it("does not let a Durable-Object key claim a migration as its route", () => {
		// A migration cannot write DO state. Recording one for `$.identity` would be a claim that is
		// impossible rather than merely unproven, and it would read as reassuring.
		for (const [file, paths] of CONFIG_PATCHES) {
			if (!paths.some((p) => instanceCopiedKey(p)?.store === "durable-object")) continue;
			if (paths.some((p) => instanceCopiedKey(p)?.store === "d1")) continue;
			expect(PROPAGATION[file], `${file} patches DO-held identity; a .sql route would be impossible`).not.toMatch(/\.sql$/);
		}
	});

	it("does not count an INSERT-shaped seed, which has no instances to miss", () => {
		// Guard on the detector itself. If it ever started matching every `"identity"` key in a
		// seed's config blob, the list above would fill with rows that were never at risk and the
		// check would be noise rather than a boundary.
		expect(PATCHED_MIGRATIONS).not.toContain("0072_seed_tmux_operator_agent.sql");
		expect(PATCHED_MIGRATIONS).not.toContain("0112_seed_single_pane_operator_agent.sql");
		expect(PATCHED_MIGRATIONS).not.toContain("0087_seed_portal_watch_agent.sql");
		// 0057 seeds site-builder's two pipeline definitions in an INSERT — the same key 0111
		// patches, and correctly not a finding: a brand-new agent has no instances to miss.
		expect(PATCHED_MIGRATIONS).not.toContain("0057_seed_site_builder_agent.sql");
	});

	it("does not count the REMEDY, which writes agent_instances rather than agents", () => {
		// 0130 names `'$.pipelines.lead_finder'` in a json_set too. A detector that could not tell
		// the tables apart would flag the fix as another instance of the defect, and the list would
		// grow one entry every time somebody closed one.
		const remedy = MIGRATIONS.find((m) => m.endsWith("lead_finder_pipeline_reaches_live_instances.sql"));
		expect(remedy, "the #394 remedy migration is missing").toBeDefined();
		expect(readMigration(remedy as string)).toContain("'$.pipelines.lead_finder'");
		expect(PATCHED_MIGRATIONS).not.toContain(remedy);
	});

	it("does not count a CAPABILITY patch, because that one already reaches live instances", () => {
		// 0112 patches `$.capabilities.surfaceOptions.terminal.backends` on rows that DO have
		// instances, and is correct to: capabilities resolve from the agents row at read time. The
		// contrast is the point — the risky edit is an instance-copied key, not "any json_set on
		// agents".
		const sql = readMigration("0112_seed_single_pane_operator_agent.sql");
		expect(sql).toMatch(/json_set\([\s\S]*?\$\.capabilities/);
		expect(PATCHED_MIGRATIONS).not.toContain("0112_seed_single_pane_operator_agent.sql");
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

describe("the detector itself — the three properties, on SQL written to test them", () => {
	// Every case above is a real migration, which is the right way round: the guard has to be true
	// of the files that exist. These are the cases no migration happens to be today, and each one
	// is a way the detector could go quietly wrong later.
	it("survives a semicolon inside an embedded JSON literal", () => {
		// 0111's seeded definition contains prose, and prose contains semicolons. Splitting the DDL
		// into statements without masking the literals first would put `UPDATE agents` and a path
		// named after the blob in different fragments, and the patch would stop being detected for a
		// reason invisible in the diff.
		const sql = `UPDATE agents SET config = json_set(config, '$.identity.personality', json('"a; b"')), other = json_set(config, '$.pipelines.x', json('{}')) WHERE slug = 's';`;
		expect(instanceCopiedPatchPaths(sql).sort()).toEqual(["$.identity", "$.pipelines"]);
	});

	it("ignores the path when it is only a key inside an inserted blob", () => {
		// An INSERT-shaped seed carries `"identity"` and `"pipelines"` as object keys. It is not a
		// patch, and counting it would fill the recorded list with agents that had no instances.
		const sql = `INSERT INTO agents (id, config) VALUES ('a', json('{"identity":{"personality":"x"},"pipelines":{}}'));`;
		expect(instanceCopiedPatchPaths(sql)).toEqual([]);
	});

	it("ignores a patch that is only in a comment", () => {
		// These migrations explain themselves at length and routinely discuss the hazard by name. A
		// detector over the raw text would flag a file for describing what it took care not to do.
		expect(instanceCopiedPatchPaths(`-- json_set(config, '$.identity.personality', …) would not reach an instance\nSELECT 1;`)).toEqual([]);
	});
});
