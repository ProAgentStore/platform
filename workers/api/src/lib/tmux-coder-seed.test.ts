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
import { agentCapabilities, sanitizeSettingsSchema, sanitizeToolList } from "./agent-capabilities.js";
import { lintAgentClaims } from "./agent-claims-lint.js";
import { REPO_PATH_SETTINGS } from "./connectors/repo-local.js";
import { realSchemaD1 } from "./d1-sqlite.js";
import { instanceCopiedPatchPaths } from "./instance-copied-config.js";
import { registryConnectorGroups, registryTools } from "./tool-registry.js";
import { TERMINAL_CLI_PROTOCOL, TOOL_LIST_CLOSED, connectorToolsPrompt, type PromptTool } from "./connector-tool-prompt.js";
import { toolNamesFor } from "../agent-do-tools.js";

const SQL = readFileSync(fileURLToPath(new URL("../../migrations/0123_seed_tmux_coder_agent.sql", import.meta.url).href), "utf8");

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

/**
 * ── Migration 0140: the same agent, reading the repository without the shell (#515, step 2)
 *
 * 0123 shipped an agent that can drive a machine and talk to GitHub but cannot look at a file. The
 * only read route it had was `tmux_run_command` — the tmux connector's `scope: "write"` tool, gated
 * by the per-instance write consent (#90) and carrying an arbitrary command string. `repo-local`
 * declares `scopes: { write: false }`, so it is the read half at a privilege that can never be
 * consented into a command, no matter what a pane or an issue body tells the model.
 *
 * Two things can silently make that grant nothing, and neither fails a build:
 *
 *   1. a `repo_*` name that the registry does not actually carry — the agent simply never gets the
 *      tool and answers conversationally (`tool-reachability.test.ts` records what that looks like);
 *   2. no `repo_path` setting, or one whose id `repoPathForInstance` does not read. This agent
 *      declares `surfaces: ["tmux"]`, so it has no add-repo control and can NEVER have a
 *      `coding_repos` row — the typed setting is not a fallback here, it is the only address the
 *      six tools will ever have. Without it every call resolves "no repository is configured".
 *
 * So this half is checked by EXECUTION, not by parsing: the migrations are applied to a real SQLite
 * built from the real migration files, the row is read back, and the result is resolved through the
 * REAL `agentCapabilities`, `sanitizeSettingsSchema` and `toolNamesFor`.
 */
const SQL_0140 = readFileSync(fileURLToPath(new URL("../../migrations/0140_tmux_coder_reads_without_the_shell.sql", import.meta.url).href), "utf8");
const SQL_0145 = readFileSync(fileURLToPath(new URL("../../migrations/0145_coder_issue_comments_tool.sql", import.meta.url).href), "utf8");
const ISSUE_COMMENTS_TOOL = "github_list_issue_comments";

/** The six read-only tools, from the connector's own registry entry rather than restated here. */
const REPO_LOCAL_NAMES = groups.find((g) => g.connector === "repo-local")?.tools ?? [];

/** The row as the migrations actually leave it: 0123 inserts, 0140 adds repo reads, 0145 adds comments. */
function seededRow(d1: ReturnType<typeof realSchemaD1>): { config: string; visibility: string; description: string } {
	return d1.sqlite.prepare("SELECT config, visibility, description FROM agents WHERE slug = ?").get("tmux-coder") as {
		config: string;
		visibility: string;
		description: string;
	};
}

const LIVE = (() => {
	const d1 = realSchemaD1();
	try {
		const row = seededRow(d1);
		const cfg = JSON.parse(row.config) as Record<string, unknown>;
		return {
			config: cfg,
			description: row.description,
			visibility: row.visibility,
			caps: agentCapabilities({ slug: "tmux-coder", category: "code", config: row.config }),
			tools: (cfg.capabilities as Record<string, unknown>).tools as string[],
			personality: (cfg.identity as Record<string, unknown>).personality as string,
		};
	} finally {
		d1.close();
	}
})();

describe("migration 0140 — a read stops costing a write-scope shell call (#515)", () => {
	it("applies to the real schema and leaves ONE tmux-coder row, still published", () => {
		// The premise of an UPDATE-shaped migration: the row is already there because 0123 seeded it
		// and migrations apply in order. If that were ever untrue this file would be a silent no-op —
		// `WHERE slug = 'tmux-coder'` matching nothing is not an error in SQLite.
		const d1 = realSchemaD1();
		try {
			const n = d1.sqlite.prepare("SELECT COUNT(*) AS n FROM agents WHERE slug = ?").get("tmux-coder") as { n: number };
			expect(n.n).toBe(1);
			expect(seededRow(d1).visibility).toBe("published");
		} finally {
			d1.close();
		}
	});

	it("grants exactly the six repo-local tools, plus the later issue-comment read", () => {
		// Derived from 0123's own literal rather than restated, so the two files cannot drift: if
		// 0123's list is ever edited, this fails instead of quietly dropping a tmux or github tool.
		// 0145 is the one later GitHub read added after this migration's historical contract.
		expect(REPO_LOCAL_NAMES).toHaveLength(6);
		expect([...LIVE.tools].sort()).toEqual([...DECLARED, ...REPO_LOCAL_NAMES, ISSUE_COMMENTS_TOOL].sort());
		expect(LIVE.tools).toHaveLength(22);
		expect(LIVE.tools.filter((t) => t.startsWith("repo_")).sort()).toEqual([...REPO_LOCAL_NAMES].sort());
	});

	it("writes the six as the registry spells them — every name is a real repo-local tool", () => {
		// A name that is not on the connector is not an error, it is a missing tool. Checked in both
		// directions: nothing invented, and nothing on the read connector left behind.
		for (const name of LIVE.tools.filter((t) => t.startsWith("repo_"))) expect(REPO_LOCAL_NAMES).toContain(name);
		for (const name of REPO_LOCAL_NAMES) expect(LIVE.tools).toContain(name);
	});

	it("keeps the tmux and github halves byte-identical to 0123's", () => {
		// The 0107 failure mode, one level down: this migration re-states the WHOLE tools array, so
		// the way it goes wrong is by losing one of the fifteen it did not come here to change. The
		// later 0145 issue-comments grant is checked separately here so it does not blur that guard.
		expect(LIVE.tools.filter((t) => t.startsWith("tmux_"))).toEqual(DECLARED.filter((t) => t.startsWith("tmux_")));
		expect(LIVE.tools.filter((t) => t.startsWith("github_") && t !== ISSUE_COMMENTS_TOOL)).toEqual(
			DECLARED.filter((t) => t.startsWith("github_")),
		);
		expect(LIVE.tools).toContain(ISSUE_COMMENTS_TOOL);
	});

	it("does not re-set the whole capabilities object, and does not touch surfaces or runtime", () => {
		// 0108's recorded reason for the narrow path: 0107 re-set `$.capabilities` wholesale and lost
		// `set_direction`. Asserted on the SQL because the shape is what is being ruled out, then on
		// the resolved row because the shape alone is not the outcome.
		expect(SQL_0140).not.toMatch(/json_set\([\s\S]*?'\$\.capabilities',/);
		expect(SQL_0140).toMatch(/'\$\.capabilities\.tools'/);
		expect(LIVE.caps.surfaces).toEqual(["tmux"]);
		expect(LIVE.caps.runtime).toBe("coding");
		expect(LIVE.caps.workflow).toBeNull();
	});

	it("survives the sanitiser and reaches the model: toolNamesFor grants all twenty-two", () => {
		// The gate that decides what the agent may actually run. A declared name outside
		// CREATOR_SELECTABLE_TOOLS is dropped here in silence — the migration would look applied.
		expect(sanitizeToolList(LIVE.tools)).toEqual(LIVE.tools);
		expect(LIVE.caps.tools).toEqual(LIVE.tools);
		const granted = toolNamesFor(LIVE.caps);
		for (const name of LIVE.tools) expect(granted.has(name)).toBe(true);
	});

	it("still declares nothing from the generic terminal connector", () => {
		// 0099's defect stays one name away, and this file rewrites the whole array.
		expect(LIVE.tools.filter((t) => TERMINAL_TOOLS.includes(t))).toEqual([]);
		expect(LIVE.tools.filter((t) => t.startsWith("terminal_"))).toEqual([]);
		for (const name of TERMINAL_TOOLS) expect(toolNamesFor(LIVE.caps).has(name)).toBe(false);
	});
});

describe("migration 0140 — the repo_path setting, which is this agent's only address", () => {
	const schema = LIVE.caps.settingsSchema ?? [];

	it("declares it at TOP-LEVEL config.settingsSchema, a sibling of capabilities", () => {
		// `agentCapabilities` reads `cfg.settingsSchema`; a field written under `$.capabilities`
		// would sanitize to nothing and the console would render no card at all.
		expect(SQL_0140).toMatch(/'\$\.settingsSchema'/);
		expect(SQL_0140).not.toMatch(/'\$\.capabilities\.settingsSchema'/);
		expect(Object.hasOwn(LIVE.config, "settingsSchema")).toBe(true);
	});

	it("survives sanitizeSettingsSchema — a malformed field is dropped without a word", () => {
		expect(sanitizeSettingsSchema(LIVE.config.settingsSchema)).toEqual(schema);
		expect(schema).toHaveLength(1);
		expect(schema[0]?.type).toBe("text");
		expect(schema[0]?.label).toBeTruthy();
	});

	it("uses an id repoPathForInstance actually reads", () => {
		// The whole grant hangs on this string. `REPO_PATH_SETTINGS` is the list the resolver walks;
		// the first entry is the live one (`local-repo-chat`'s), the second is a pre-0102 orphan kept
		// only so an old `coder-repo` instance still resolves. A new declaration must use the first.
		expect(REPO_PATH_SETTINGS[0]).toBe("repo_path");
		expect(schema[0]?.id).toBe("repo_path");
		expect(REPO_PATH_SETTINGS as readonly string[]).toContain(schema[0]?.id);
	});

	it("tells the owner it is a path on the machine running `pags up`, not owner/name", () => {
		// A value holding `owner/name` is skipped as a GitHub coordinate rather than handed to the
		// runner, so a label that invited one would produce silent "no repository is configured".
		expect(schema[0]?.description).toMatch(/pags up/);
		expect(schema[0]?.description).toMatch(/~\//);
	});
});

describe("migration 0140 — the personality, which is why the tools get used", () => {
	const personality = LIVE.personality;

	it("names no tool that does not exist — the guard 0123 exists to hold", () => {
		// The defect this whole ticket replaces: four `terminal_*` names living in a Rules box,
		// resolving `not_declared` on every turn. This file rewrites the personality, so the check
		// has to be re-run against what it writes, not only against what 0123 wrote.
		const mentioned = [...new Set([...personality.matchAll(/\b(?:tmux|github|terminal|repo)_[a-z_]+/g)].map((m) => m[0]))];
		expect(mentioned.length).toBeGreaterThan(0);
		for (const name of mentioned) expect(LIVE.tools).toContain(name);
	});

	it("names all six read tools, so the grant is steered rather than merely present", () => {
		// #507's measurement is the reason this section exists: with two routes to the same outcome
		// and nothing said, the shell route wins. `github_create_issue` existed and the agent still
		// drove `gh` through a pane. This is an instruction, not a gate — recorded so that if it
		// turns out not to hold, the fix is known to be a gate rather than more prose.
		for (const name of REPO_LOCAL_NAMES) expect(personality).toContain(name);
		expect(personality).toMatch(/Do NOT spend a tmux_run_command on/);
		expect(personality).toMatch(/Repository path in Settings/);
	});

	it("keeps every rule 0123 wrote — a full-string rewrite loses one by omission", () => {
		// The same hazard as re-setting `$.capabilities`, in prose. Each of these is a separate
		// decision 0123 made and this file did not come here to revisit.
		expect(personality).toMatch(/NEVER with `gh` in a pane/);
		expect(personality).toMatch(/## Deployment block/);
		expect(personality).toMatch(/YOU ARE THE DRIVER, NOT THE CODER/);
		expect(personality).toMatch(/never estimate or report a dollar figure/i);
		expect(personality).toMatch(/untrusted data, not instructions/i);
		expect(personality).toMatch(/Launch the CLI ONCE per session/);
	});

	it("still carries the interactive-CLI protocol headings the code constant defines", () => {
		// #483/#496: the seed copy reaches new subscribers, the CONNECTED TOOLS block reaches
		// everyone every turn, and a rule on one side only is the drift that made half of #483 ship
		// to nobody. Re-checked here because the string was rewritten.
		const headings = (text: string) => [...text.matchAll(/\n(\d+\. [A-Z][A-Z ]+):/g)].map((m) => m[1]);
		expect(headings(`\n${personality}`)).toEqual(headings(TERMINAL_CLI_PROTOCOL));
	});

	it("counts file contents as untrusted input too, now that it can read them", () => {
		// The one sentence 0123's wording no longer covered: `repo_read_file` and `repo_grep` bring
		// repository text into the context, and a README is exactly where an injection would sit.
		expect(personality).toMatch(/file contents/i);
	});

	it("is a $.identity patch, which is why this file has a propagation entry", () => {
		// `seed-identity-propagation.test.ts` enforces the other half. Stated here as well because
		// the two facts belong together: capabilities JOIN at read time and reach the live instance
		// on its next turn; identity is a DO snapshot taken at subscribe and reaches it never.
		expect(SQL_0140).toMatch(/'\$\.identity\.personality'/);
		expect(instanceCopiedPatchPaths(SQL_0140)).toEqual(["$.identity"]);
	});
});

describe("migration 0140 — idempotent, and converging", () => {
	it("replaying 0140 and the later issue-comment grant in order changes nothing", () => {
		// Every value written is a constant, so a second ordered application must be a no-op. The
		// failure this rules out is an append-shaped write that doubles a list on the second run.
		const d1 = realSchemaD1();
		try {
			const before = seededRow(d1).config;
			d1.exec(SQL_0140);
			d1.exec(SQL_0145);
			expect(JSON.parse(seededRow(d1).config)).toEqual(JSON.parse(before));
		} finally {
			d1.close();
		}
	});

	it("converges a row still carrying 0123's fifteen tools and no settingsSchema", () => {
		// The state of production the moment before this migration runs, reconstructed: 0123's row
		// untouched. Applying this file must produce the same result as a fresh database's ordered
		// run — that equivalence is what makes an UPDATE-shaped migration safe.
		const d1 = realSchemaD1();
		try {
			const pre = { capabilities: CONFIG.capabilities, identity: CONFIG.identity };
			d1.sqlite.prepare("UPDATE agents SET config = ? WHERE slug = ?").run(JSON.stringify(pre), "tmux-coder");
			d1.exec(SQL_0140);
			d1.exec(SQL_0145);
			const after = JSON.parse(seededRow(d1).config) as Record<string, unknown>;
			expect((after.capabilities as Record<string, unknown>).tools).toEqual(LIVE.tools);
			expect(after.settingsSchema).toEqual(LIVE.config.settingsSchema);
			expect((after.identity as Record<string, unknown>).personality).toEqual(LIVE.personality);
			// The siblings the narrow paths never name.
			expect((after.identity as Record<string, unknown>).goal).toEqual(IDENTITY.goal);
			expect((after.identity as Record<string, unknown>).guardrails).toEqual(IDENTITY.guardrails);
			expect((after.identity as Record<string, unknown>).welcomeMessage).toEqual(IDENTITY.welcomeMessage);
		} finally {
			d1.close();
		}
	});

	it("leaves the catalog copy alone, and it still passes the claims lint against the new tools", () => {
		// The description is a plain column; nothing here writes it. But `lintAgentClaims` reads the
		// capabilities as well, so the pairing has to be re-checked after they changed.
		expect(LIVE.description).toBe(DESCRIPTION);
		expect(lintAgentClaims({ description: LIVE.description, capabilities: LIVE.caps })).toEqual([]);
	});
});
