import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeDeclaredCapabilities } from "./agent-capabilities.js";
import { registryToolNameSet } from "./tool-registry.js";

/**
 * Coder 2 parity (#160 / epic #58).
 *
 * The claim being tested is "a declared Coder is as capable as the hardcoded one". That is a
 * claim about DATA — the capabilities the templates declare — so it is checkable, and left
 * unchecked it is the kind of thing that quietly stops being true the next time someone edits
 * either side.
 *
 * Migration 0054 is the reference: it is what the hardcoded `coder` actually has today.
 */
const MIGRATIONS = join(import.meta.dirname, "..", "..", "migrations");

function configFromSeed(slug: string): Record<string, unknown> {
	const sql = readFileSync(join(MIGRATIONS, "0063_seed_coder2_agents.sql"), "utf8");
	// Each INSERT carries one single-quoted JSON config; find the one in this slug's statement.
	const marker = `'${slug}',`;
	const idx = sql.indexOf(marker);
	expect(idx, `seed for ${slug} not found`).toBeGreaterThan(-1);
	const rest = sql.slice(idx);
	const start = rest.indexOf("'{");
	const end = rest.indexOf("}',", start);
	return JSON.parse(rest.slice(start + 1, end + 1).replace(/''/g, "'")) as Record<string, unknown>;
}

function hardcodedCoderCapabilities(): Record<string, unknown> {
	const sql = readFileSync(join(MIGRATIONS, "0054_coder_github_tools.sql"), "utf8");
	const m = sql.match(/'(\{"surfaces".*?\})'/s);
	expect(m, "reference capabilities not found in 0054").toBeTruthy();
	return JSON.parse((m as RegExpMatchArray)[1]) as Record<string, unknown>;
}

describe("Repo Coder matches the hardcoded Coder", () => {
	it("declares byte-for-byte the same capabilities", () => {
		// If someone widens or narrows the hardcoded Coder without updating the declared one,
		// "as capable as" silently becomes false. This is the guard.
		const declared = configFromSeed("coder-repo").capabilities;
		expect(declared).toEqual(hardcodedCoderCapabilities());
	});

	it("keeps the local coding runtime and the durable Pilot", () => {
		const caps = configFromSeed("coder-repo").capabilities as Record<string, unknown>;
		expect(caps.runtime).toBe("coding"); // `pags up` drives a real CLI in tmux
		expect(caps.workflow).toBe("CODING_SESSION"); // the durable Pilot, not a client loop
		expect(caps.surfaces).toEqual(["coding"]); // the console renders the Coding tab
	});
});

describe("Coder Lead replaces the Overseer without inheriting its hardcoding", () => {
	const caps = () => configFromSeed("coder-lead").capabilities as Record<string, unknown>;

	it("is cloud-only — the lead delegates, it does not run a CLI", () => {
		expect(caps().runtime).toBeNull();
		expect(caps().workflow).toBeNull();
		expect(caps().surfaces).toEqual([]);
	});

	it("can actually delegate — the tool the hardcoded Overseer had to define inline", () => {
		// Everything else for a declared supervisor already existed; without a delegation TOOL a
		// supervisor could be wired perfectly and still be unable to supervise.
		const tools = caps().tools as string[];
		expect(tools).toContain("delegate_goal");
		expect(tools).toContain("list_subordinates");
		expect(tools).toContain("check_delegation");
	});

	it("declares no tool the registry does not actually provide", () => {
		// A declared name that resolves to nothing is a silently inert agent.
		const known = registryToolNameSet();
		for (const t of caps().tools as string[]) expect(known.has(t), `unknown tool: ${t}`).toBe(true);
	});
});

describe("both templates survive the platform's own validator", () => {
	// The seed must be acceptable to the same sanitizer the create/update route (#141) applies —
	// otherwise the agents are stampable only by SQL, which defeats the point.
	for (const slug of ["coder-repo", "coder-lead"]) {
		it(`${slug} passes sanitizeDeclaredCapabilities unchanged`, () => {
			const declared = configFromSeed(slug).capabilities as Record<string, unknown>;
			expect(sanitizeDeclaredCapabilities(declared)).toEqual(declared);
		});
	}

	for (const slug of ["coder-repo", "coder-lead"]) {
		it(`${slug} puts settingsSchema at the TOP level, where the registry reads it`, () => {
			// Nested under capabilities it parses fine and renders nothing — the exact bug that
			// made the site-builder's MCP endpoint unenterable.
			const cfg = configFromSeed(slug);
			expect(Array.isArray(cfg.settingsSchema)).toBe(true);
			expect((cfg.capabilities as Record<string, unknown>).settingsSchema).toBeUndefined();
		});
	}
});

describe("0067 — the Lead's declared tools stay real and never shrink", () => {
	// The existing parity tests read 0063 ONLY, so a tool added by a later migration is untested:
	// `capabilities.tools` is an authoritative allowlist, so a name the template does not declare
	// is invisible to the agent however well the registry provides it — and a name it declares
	// that the registry does NOT provide is a silently inert agent.
	const declared0067 = (): string[] => {
		const sql = readFileSync(join(MIGRATIONS, "0067_supervisor_observe.sql"), "utf8");
		const m = sql.match(/json\('(\[[^']*\])'\)/);
		if (!m) throw new Error("0067 no longer sets capabilities.tools via json('[…]')");
		return JSON.parse(m[1]) as string[];
	};

	it("grants the Lead subordinate_status — without it the tool exists and the agent cannot call it", () => {
		expect(declared0067()).toContain("subordinate_status");
	});

	it("declares no tool the registry does not actually provide", async () => {
		const { registryToolNameSet } = await import("./tool-registry.js");
		const known = registryToolNameSet();
		expect(declared0067().filter((n) => !known.has(n))).toEqual([]);
	});

	it("is a SUPERSET of 0063 — a later migration must not silently drop delegate_goal", () => {
		const sql = readFileSync(join(MIGRATIONS, "0063_seed_coder2_agents.sql"), "utf8");
		const lead = sql.slice(sql.indexOf("agent_coder_lead"));
		const before = [...lead.matchAll(/"(list_subordinates|delegate_goal|check_delegation)"/g)].map((m) => m[1]);
		const after = declared0067();
        for (const name of new Set(before)) expect(after).toContain(name);
	});
});

describe("0070 — the Repo Coder has ONE chat, and it can still do the job (#209)", () => {
	const sql0070 = (): string => readFileSync(join(MIGRATIONS, "0070_coder_repo_one_chat.sql"), "utf8");
	const declared0070 = (): string[] => {
		const m = sql0070().match(/json\('(\[[^']*\])'\)/);
		if (!m) throw new Error("0070 no longer sets capabilities.tools via json('[…]')");
		return JSON.parse(m[1]) as string[];
	};

	it("declares the Co-pilot OFF", () => {
		expect(sql0070()).toContain("$.capabilities.surfaceOptions.coding.copilot");
		expect(sql0070()).toMatch(/copilot['"\s,]*,\s*json\('false'\)/);
	});

	it("only ever touches coder-repo — the legacy hardcoded Coder must be byte-identical", () => {
		// The one hard constraint on this change. `coder` keeps its Co-pilot because it declares
		// nothing and the option defaults true; an UPDATE that caught it would silently delete a
		// view from a shipped agent.
		expect(sql0070()).toContain("WHERE slug = 'coder-repo'");
		expect(sql0070()).not.toMatch(/slug\s*=\s*'coder'/);
		expect(sql0070()).not.toMatch(/slug\s+IN\s*\(/i);
	});

	it("replaces the Co-pilot's capability rather than removing it", async () => {
		// The Co-pilot's read tools were: list_files, read_file, git_status/git_diff, list_issues,
		// read_issue, plus the terminal it was handed. Every one has a registry equivalent that
		// `repo-local`/`github`/`tmux` already publish — which is why deleting the second brain
		// costs nothing. If a future edit drops one of these, the chat quietly gets dumber than
		// the thing it replaced and no other test notices.
		const tools = declared0070();
		for (const n of ["repo_tree", "repo_read_file", "repo_git", "repo_remote", "github_list_issues", "github_read_issue"]) {
			expect(tools, n).toContain(n);
		}
		// The terminal is deliberately NOT a tool here: agent-think.ts already injects a fresh
		// capture of every active session's pane each turn. A tool would be a third copy.
		expect(tools).not.toContain("tmux_capture_pane");
	});

	it("declares nothing that is in the registry but NOT creator-selectable — the inert-tool trap", async () => {
		// registryToolNameSet() is a weaker check than it looks: `toolNamesFor` only honours a
		// declared name when CREATOR_SELECTABLE_TOOLS has it, so a real registry tool outside that
		// set is declared, invisible to the agent, and passes every other assertion here.
		const { CREATOR_SELECTABLE_TOOLS } = await import("../agent-do-tools.js");
		expect(declared0070().filter((n) => !CREATOR_SELECTABLE_TOOLS.has(n))).toEqual([]);
	});

	it("grants NO write tool that would make its chat a second way to drive the engine", () => {
		// `drive:false` already says the Lead steers a Repo Coder. Handing its chat
		// tmux_run_command would reintroduce exactly the overlapping drive-path #154 removed.
		for (const n of ["tmux_run_command", "tmux_send_keys", "tmux_kill_session", "tmux_new_session", "browser_act"]) {
			expect(declared0070(), n).not.toContain(n);
		}
	});

	it("declares no tool the registry does not actually provide", async () => {
		const { registryToolNameSet } = await import("./tool-registry.js");
		const known = registryToolNameSet();
		expect(declared0070().filter((n) => !known.has(n))).toEqual([]);
	});
});

describe("declared board vocabularies are fully claimed by the canonical bucketer", () => {
	it("every status a seeded agent declares resolves to one of its own columns", async () => {
		// The drift guard. `columnForStatus` falls back to catchAll and then null, so a future
		// agent inventing a status lands in a plausible-but-wrong bucket with no test failing —
		// quiet wrongness in a supervisor's status read is the failure docs/supervision.md warns
		// about. This turns that drift back into a loud failure.
		const { columnForStatus } = await import("./agent-capabilities.js");
		const files = ["0063_seed_coder2_agents.sql", "0057_seed_site_builder_agent.sql", "0032_seed_repo_chat_agent.sql"];
		for (const f of files) {
			let sql: string;
			try {
				sql = readFileSync(join(MIGRATIONS, f), "utf8");
			} catch {
				continue; // a seed that has been renamed is not this test's business
			}
			for (const m of sql.matchAll(/"boardColumns":(\[.*?\}\])/g)) {
				let cols: Array<{ id: string; title: string; color: string; statuses?: string[] }>;
				try {
					cols = JSON.parse(m[1].replace(/\\u0027/g, "'"));
				} catch {
					continue;
				}
				for (const c of cols) {
					for (const st of c.statuses ?? []) {
						expect(columnForStatus(cols, st)?.id, `${f}: "${st}" is claimed by no column`).toBe(c.id);
					}
				}
			}
		}
	});
});
