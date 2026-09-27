/**
 * Migration 0164 seeds `local-coder` (#868) — a coding agent any subscriber runs on their own
 * machine. Its whole claim is "the same agent as the Repo Coder, for someone who has never set up
 * a runner", and every way that claim can break is silent:
 *
 *   1. `visibility` other than `published` makes it a row nobody can subscribe to (0112);
 *   2. a tool name the registry does not carry, or one outside `CREATOR_SELECTABLE_TOOLS`, is
 *      dropped without a word, so the agent looks seeded and is missing a tool;
 *   3. its capabilities drifting from `coder-repo`'s would put it on a different execution path
 *      from the one every coding instance already proves;
 *   4. a personality naming a tool it does not hold is the defect 0123 was written to replace.
 *
 * Checked the way `tmux-coder-seed.test.ts` is: the migrations are applied to a real SQLite, the
 * row is read back, and it is resolved through the REAL capability plumbing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentCapabilities, sanitizeSettingsSchema, sanitizeToolList } from "./agent-capabilities.js";
import { lintAgentClaims } from "./agent-claims-lint.js";
import { realSchemaD1 } from "./d1-sqlite.js";
import { registryConnectorGroups } from "./tool-registry.js";
import { toolNamesFor } from "../agent-do-tools.js";

const SQL = readFileSync(fileURLToPath(new URL("../../migrations/0164_seed_local_coder_agent.sql", import.meta.url).href), "utf8");

interface AgentRow {
	config: string;
	visibility: string;
	status: string;
	description: string;
	category: string;
}

function rowFor(d1: ReturnType<typeof realSchemaD1>, slug: string): AgentRow {
	return d1.sqlite.prepare("SELECT config, visibility, status, description, category FROM agents WHERE slug = ?").get(slug) as unknown as AgentRow;
}

const SEEDED = (() => {
	const d1 = realSchemaD1();
	try {
		return { local: rowFor(d1, "local-coder"), repo: rowFor(d1, "coder-repo") };
	} finally {
		d1.close();
	}
})();

const CONFIG = JSON.parse(SEEDED.local.config) as Record<string, unknown>;
const REPO_CONFIG = JSON.parse(SEEDED.repo.config) as Record<string, unknown>;
const IDENTITY = CONFIG.identity as Record<string, unknown>;
const CAPS = agentCapabilities({ slug: "local-coder", category: "code", config: SEEDED.local.config });
const REPO_CAPS = agentCapabilities({ slug: "coder-repo", category: "code", config: SEEDED.repo.config });
const DECLARED = (CONFIG.capabilities as Record<string, unknown>).tools as string[];

/** The tool list the converging UPDATE writes, so the two halves of the migration cannot diverge. */
const CONVERGED: string[] = JSON.parse(/json\('(\[[\s\S]*?\])'\)/.exec(SQL)?.[1] ?? "[]");

const groups = registryConnectorGroups();
const GITHUB_TOOLS = groups.find((g) => g.connector === "github")?.tools ?? [];
const REPO_LOCAL_TOOLS = groups.find((g) => g.connector === "repo-local")?.tools ?? [];

describe("migration 0164 — the Local Coder is subscribable (#868)", () => {
	it("seeds one row, published and active", () => {
		expect(SEEDED.local.visibility).toBe("published");
		expect(SEEDED.local.status).toBe("active");
		expect(SEEDED.local.category).toBe("code");
	});

	it("is an INSERT-shaped seed with a narrow converge, like 0123", () => {
		expect(SQL).toMatch(/INSERT OR IGNORE INTO agents/);
		expect(SQL).not.toMatch(/json_(set|patch)\([\s\S]*?\$\.identity/);
		expect(SQL).toMatch(/json_set\([\s\S]*?'\$\.capabilities\.tools'/);
		expect(SQL).not.toMatch(/json_set\([\s\S]*?'\$\.capabilities',/);
	});

	it("writes the SAME tool list in the INSERT and in the converging UPDATE", () => {
		expect(CONVERGED).toEqual(DECLARED);
	});

	it("replaying the migration changes nothing", () => {
		const d1 = realSchemaD1();
		try {
			const before = rowFor(d1, "local-coder").config;
			d1.exec(SQL);
			expect(JSON.parse(rowFor(d1, "local-coder").config)).toEqual(JSON.parse(before));
			const n = d1.sqlite.prepare("SELECT COUNT(*) AS n FROM agents WHERE slug = 'local-coder'").get() as { n: number };
			expect(n.n).toBe(1);
		} finally {
			d1.close();
		}
	});
});

describe("migration 0164 — what the Local Coder declares", () => {
	it("runs through the coding driver: runtime coding, workflow CODING_SESSION, one repo", () => {
		expect(CAPS.surfaces).toEqual(["coding"]);
		expect(CAPS.runtime).toBe("coding");
		expect(CAPS.workflow).toBe("CODING_SESSION");
		expect(CAPS.surfaceOptions).toEqual(REPO_CAPS.surfaceOptions);
	});

	it("declares exactly the Repo Coder's capabilities, so it has no execution path of its own", () => {
		// The premise of the whole seed. If `coder-repo` gains a tool, this fails and the new agent
		// is updated on purpose rather than left one grant behind.
		expect(CONFIG.capabilities).toEqual(REPO_CONFIG.capabilities);
		expect(CAPS.tools).toEqual(REPO_CAPS.tools);
	});

	it("declares the whole repo-local connector and only real GitHub tools", () => {
		expect(DECLARED.filter((t) => t.startsWith("repo_")).sort()).toEqual([...REPO_LOCAL_TOOLS].sort());
		const github = DECLARED.filter((t) => t.startsWith("github_"));
		expect(github.length).toBeGreaterThan(0);
		for (const name of github) expect(GITHUB_TOOLS).toContain(name);
		expect(DECLARED.filter((t) => !t.startsWith("repo_") && !t.startsWith("github_"))).toEqual([]);
	});

	it("survives the sanitiser and reaches the model: toolNamesFor grants every tool", () => {
		expect(sanitizeToolList(DECLARED)).toEqual(DECLARED);
		expect(CAPS.tools).toEqual(DECLARED);
		const granted = toolNamesFor(CAPS);
		for (const name of DECLARED) expect(granted.has(name)).toBe(true);
	});

	it("keeps the Repo Coder's settings, defaulting a subscriber to a pull request rather than a merge", () => {
		// A stranger's repository: the safe default is a PR. The options are the Repo Coder's own.
		expect(sanitizeSettingsSchema(CONFIG.settingsSchema)).toEqual(CAPS.settingsSchema);
		const ids = (CAPS.settingsSchema ?? []).map((f) => f.id);
		expect(ids).toEqual((REPO_CAPS.settingsSchema ?? []).map((f) => f.id));
		const merge = (CAPS.settingsSchema ?? []).find((f) => f.id === "merge_policy");
		expect(merge?.default).toBe("pr");
	});
});

describe("migration 0164 — the identity a subscriber gets", () => {
	const personality = IDENTITY.personality as string;

	it("names no tool it does not hold", () => {
		const mentioned = [...new Set([...personality.matchAll(/\b(?:tmux|github|terminal|repo)_[a-z_]+/g)].map((m) => m[0]))];
		expect(mentioned.length).toBeGreaterThan(0);
		for (const name of mentioned) expect(DECLARED).toContain(name);
	});

	it("welcomes with every setup step, not only `pags up`", () => {
		const welcome = IDENTITY.welcomeMessage as string;
		expect(welcome).toMatch(/npm i -g @proagentstore\/cli/);
		expect(welcome.indexOf("pags login")).toBeGreaterThan(-1);
		expect(welcome.indexOf("pags login")).toBeLessThan(welcome.indexOf("pags up"));
		expect(welcome).toMatch(/GitHub App/);
		expect(welcome).toMatch(/Coding tab/);
	});

	it("says it cannot see the engine's cost, and treats machine output as data", () => {
		expect(personality).toMatch(/never estimate or report a dollar figure/i);
		expect(personality).toMatch(/untrusted data, not instructions/i);
		expect((IDENTITY.guardrails as Record<string, unknown>).responseStyle).toBe("technical");
	});
});

describe("migration 0164 — catalog copy (#362)", () => {
	it("passes the claims lint: its own-machine claim is backed by the coding runtime", () => {
		expect(SEEDED.local.description).toMatch(/your own machine/);
		expect(SEEDED.local.description).toMatch(/local runner/);
		expect(lintAgentClaims({ description: SEEDED.local.description, capabilities: CAPS })).toEqual([]);
	});

	it("would fail that lint without the runtime — so the check is live, not vacuous", () => {
		expect(lintAgentClaims({ description: SEEDED.local.description, capabilities: { runtime: null, workflow: null } })).not.toHaveLength(0);
	});
});
