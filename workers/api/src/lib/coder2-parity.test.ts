import { readFileSync, readdirSync } from "node:fs";
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

/**
 * The tools a slug ACTUALLY declares today.
 *
 * Reading ONE migration by name is how these assertions go stale: they keep passing while
 * describing a declaration a later migration has superseded, which is the same expired-premise
 * trap the migrations themselves are careful about. So this walks every migration in filename
 * order — the order wrangler applies them in — and keeps the LAST statement that writes either
 * `$.capabilities` (whole object, 0054's shape) or `$.capabilities.tools` (path, 0067/0070's)
 * for that slug. A new migration is picked up with no test edit at all.
 *
 * The seeding INSERTs are deliberately not parsed: every slug asserted here has at least one
 * later UPDATE, and `configFromSeed` already covers what the seed itself declared.
 */
function effectiveDeclared(slug: string): { file: string; tools: string[] } {
	const slugRe = new RegExp(`slug\\s*=\\s*'${slug}'`);
	let found: { file: string; tools: string[] } | null = null;
	for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
		const sql = readFileSync(join(MIGRATIONS, f), "utf8");
		if (!slugRe.test(sql)) continue;
		for (const stmt of sql.split(/;\s*\n/)) {
			if (!slugRe.test(stmt) || !stmt.includes("$.capabilities")) continue;
			const tools = toolsFromStatement(stmt);
			if (tools) found = { file: f, tools };
		}
	}
	if (!found) throw new Error(`no migration sets capabilities.tools for ${slug}`);
	return found;
}

/**
 * The last WHOLE-`$.capabilities` object written for a slug, or null if only path-sets ever were.
 *
 * Statement-scoped, and that is the entire point. The original of this read the whole FILE with
 * `/'\$\.capabilities'\s*,\s*json\('(\{[\s\S]*?\})'\)[\s\S]*?slug = 'coder-repo'/`, which anchors
 * on the FIRST object in the file and then merely requires the slug to appear somewhere after it.
 * It passed on 0101 by luck — `coder-repo` happened to be the first of that file's three
 * statements. 0108 puts it second, and the same regex silently graded `coder-lead`'s object as
 * `coder-repo`'s: a guard passing for the wrong reason, which is #444's own subject.
 */
function effectiveWholeCapabilities(slug: string): { file: string; caps: Record<string, unknown> } | null {
	const slugRe = new RegExp(`slug\\s*=\\s*'${slug}'`);
	let found: { file: string; caps: Record<string, unknown> } | null = null;
	for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
		const sql = readFileSync(join(MIGRATIONS, f), "utf8");
		if (!slugRe.test(sql)) continue;
		for (const stmt of sql.split(/;\s*\n/)) {
			if (!slugRe.test(stmt)) continue;
			const obj = stmt.match(/'\$\.capabilities'\s*,\s*json\('(\{[\s\S]*?\})'\)/);
			if (obj) found = { file: f, caps: JSON.parse(obj[1]) as Record<string, unknown> };
		}
	}
	return found;
}

function toolsFromStatement(stmt: string): string[] | null {
	const arr = stmt.match(/'\$\.capabilities\.tools'\s*,\s*json\('(\[[\s\S]*?\])'\)/);
	if (arr) return JSON.parse(arr[1]) as string[];
	const obj = stmt.match(/'\$\.capabilities'\s*,\s*json\('(\{[\s\S]*?\})'\)/);
	if (obj) return (JSON.parse(obj[1]) as { tools?: string[] }).tools ?? null;
	return null;
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
		expect(caps.runtime).toBe("coding"); // `pags up` spawns a real CLI as a child process
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

describe("the Repo Coder has ONE chat, and it can still do the job (0070 / #209)", () => {
	// 0070 made the decision; a LATER migration may be what states it today. So the two kinds of
	// assertion are kept apart on purpose: what 0070 itself did (frozen text, safe to read by
	// name) versus what the Repo Coder currently declares (resolved, so it cannot go stale). The
	// original of this block read 0070 for BOTH, and 0101 (#415) is exactly the edit that would
	// have left it passing while describing a superseded list.
	const sql0070 = (): string => readFileSync(join(MIGRATIONS, "0070_coder_repo_one_chat.sql"), "utf8");
	const declared0070 = (): string[] => {
		const m = sql0070().match(/json\('(\[[^']*\])'\)/);
		if (!m) throw new Error("0070 no longer sets capabilities.tools via json('[…]')");
		return JSON.parse(m[1]) as string[];
	};
	const declared = (): string[] => effectiveDeclared("coder-repo").tools;

	it("declares the Co-pilot OFF", () => {
		expect(sql0070()).toContain("$.capabilities.surfaceOptions.coding.copilot");
		expect(sql0070()).toMatch(/copilot['"\s,]*,\s*json\('false'\)/);
	});

	it("has not had the Co-pilot switched back on by a later capabilities rewrite", () => {
		// A migration that re-sets the WHOLE `$.capabilities` object (0054's shape, which 0101
		// follows) drops any surfaceOption it does not restate. Silently getting a second chat back
		// is not something the tools assertions below would notice.
		const last = effectiveWholeCapabilities("coder-repo");
		if (!last) return; // only path-sets: none of them can have touched surfaceOptions
		const caps = last.caps as { surfaceOptions?: { coding?: Record<string, unknown> } };
		expect(caps.surfaceOptions?.coding, `${last.file} dropped the Repo Coder's coding surfaceOptions`).toEqual({
			repos: "single",
			drive: false,
			copilot: false,
		});
	});

	it("never loses a tool 0070 granted — a later re-set must be a superset", () => {
		// Same guard 0067 has against 0063. A rewrite that restates the object from memory is the
		// realistic way `repo_read_file` disappears, and nothing else here would fail.
		for (const n of declared0070()) expect(declared(), n).toContain(n);
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
		const tools = declared();
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
		expect(declared().filter((n) => !CREATOR_SELECTABLE_TOOLS.has(n))).toEqual([]);
	});

	it("grants NO write tool that would make its chat a second way to drive the engine", () => {
		// `drive:false` already says the Lead steers a Repo Coder. Handing its chat
		// tmux_run_command would reintroduce exactly the overlapping drive-path #154 removed.
		for (const n of ["tmux_run_command", "tmux_send_keys", "tmux_kill_session", "tmux_new_session", "browser_act"]) {
			expect(declared(), n).not.toContain(n);
		}
	});

	it("declares no tool the registry does not actually provide", async () => {
		const { registryToolNameSet } = await import("./tool-registry.js");
		const known = registryToolNameSet();
		expect(declared().filter((n) => !known.has(n))).toEqual([]);
	});
});

describe("0101 — the Coders can read pull requests (#415)", () => {
	// #401 shipped github_list_pulls/github_read_pull into the registry AND the console's Pulls
	// panel, but `capabilities.tools` is an authoritative allowlist, so a tool no agent declares is
	// a tool no agent has: production reported `allowed:false, reason:"not_declared"` on every
	// instance. The registry half being complete is what makes that invisible — nothing fails, the
	// agent just declines. This is the assertion that the two halves stay joined.
	const PULLS = ["github_list_pulls", "github_read_pull"] as const;

	for (const slug of ["coder-repo", "coder", "coder-lead"]) {
		it(`${slug} declares both pull tools`, () => {
			const { tools } = effectiveDeclared(slug);
			for (const n of PULLS) expect(tools, n).toContain(n);
		});

		it(`${slug} stays inside MAX_DECLARED_TOOLS`, () => {
			// sanitizeToolList truncates at 40 SILENTLY — the tail of the list simply stops existing.
			expect(effectiveDeclared(slug).tools.length).toBeLessThanOrEqual(40);
		});

		it(`${slug} declares nothing the registry cannot serve, and nothing outside the creator set`, async () => {
			const { CREATOR_SELECTABLE_TOOLS } = await import("../agent-do-tools.js");
			const { tools } = effectiveDeclared(slug);
			const known = registryToolNameSet();
			expect(tools.filter((n) => !known.has(n))).toEqual([]);
			expect(tools.filter((n) => !CREATOR_SELECTABLE_TOOLS.has(n))).toEqual([]);
		});
	}

	it("the Lead keeps everything it could already do — pulls are additive, not a replacement", () => {
		// 0101 restates the Lead's whole capabilities object, so delegation is one typo from gone.
		const tools = effectiveDeclared("coder-lead").tools;
		for (const n of ["list_subordinates", "subordinate_status", "delegate_goal", "check_delegation"]) {
			expect(tools, n).toContain(n);
		}
	});

	it("leaves repo-chat knowledge-only", () => {
		// 0050's declared set is deliberately knowledge-only. Giving it connector tools is a product
		// decision, and #415 is not it — a pass that quietly widened it would be the same class of
		// unasked-for grant the auto-grant alternative was rejected for.
		const { tools } = effectiveDeclared("repo-chat");
		for (const n of PULLS) expect(tools, n).not.toContain(n);
		expect(tools.filter((n) => n.startsWith("github_"))).toEqual([]);
	});

	it("passes the same validator the create/update routes apply", () => {
		// A seeded capabilities object that the platform's own sanitizer would rewrite is an agent
		// only SQL can stamp out, which defeats the point of declaring capabilities as data (#141).
		const sql = readFileSync(join(MIGRATIONS, "0101_coder_github_pull_tools.sql"), "utf8");
		const objs = [...sql.matchAll(/'\$\.capabilities'\s*,\s*json\('(\{[\s\S]*?\})'\)/g)];
		expect(objs.length, "0101 no longer re-sets whole capabilities objects").toBe(3);
		for (const m of objs) {
			const caps = JSON.parse(m[1]) as Record<string, unknown>;
			expect(sanitizeDeclaredCapabilities(caps)).toEqual(caps);
		}
	});
});

describe("0107 — the Lead can actually hand you over (#279)", () => {
	// The same trap as 0101, sprung again three days later by the commit that BUILT the tool.
	// `697f605` shipped `transfer_conversation` end to end — registry tool, response field, console
	// consumer, "go back", tests — and declared it nowhere, so `toolNamesFor` (which REPLACES the
	// per-surface default with the declared list) gave it to nobody. Nothing errored; the Lead just
	// answered conversationally, which for THIS feature is the worst available outcome, because a
	// reply that sounds like a transfer happened leaves a hands-free user talking into the wrong
	// agent. These assertions are what keep the two halves joined.
	it("the Lead declares it, and toolNamesFor therefore hands it over", async () => {
		const { toolNamesFor } = await import("../agent-do-tools.js");
		const { tools } = effectiveDeclared("coder-lead");
		expect(tools).toContain("transfer_conversation");
		// The declaration is necessary but not sufficient: a name outside CREATOR_SELECTABLE_TOOLS
		// is declared and still invisible, which is the failure this line would catch.
		expect(toolNamesFor({ surfaces: [], runtime: null, workflow: null, tools } as never).has("transfer_conversation")).toBe(true);
	});

	it("keeps everything the Lead could already do — 0107 restates the whole object", () => {
		const { tools } = effectiveDeclared("coder-lead");
		for (const n of ["list_subordinates", "subordinate_status", "delegate_goal", "check_delegation", "github_list_pulls"]) {
			expect(tools, n).toContain(n);
		}
	});

	it("grants it to nobody else — every other seeded agent has no subordinates to resolve", () => {
		// The tool refuses any destination outside the caller's supervision graph, so declaring it
		// on an agent without one is a capability that cannot resolve a single target. It would also
		// be the first agent able to move the person, granted by a migration nobody read.
		for (const slug of ["coder", "coder-repo", "repo-chat"]) {
			expect(effectiveDeclared(slug).tools, slug).not.toContain("transfer_conversation");
		}
	});

	it("passes the validator the create/update routes apply, like every seeded object", () => {
		const sql = readFileSync(join(MIGRATIONS, "0107_coder_lead_transfer_conversation.sql"), "utf8");
		const objs = [...sql.matchAll(/'\$\.capabilities'\s*,\s*json\('(\{[\s\S]*?\})'\)/g)];
		expect(objs.length, "0107 no longer re-sets a whole capabilities object").toBe(1);
		const caps = JSON.parse(objs[0][1]) as Record<string, unknown>;
		expect(sanitizeDeclaredCapabilities(caps)).toEqual(caps);
	});
});

describe("0108 — the Lead can propose a direction, the Repo Coder can read CI (#444)", () => {
	// The fourth instance of #415's class, and the one that proves a per-slug guard cannot catch it:
	// 0107 was written YESTERDAY to fix `transfer_conversation`, re-set the Lead's entire
	// `$.capabilities` object, and did not include `set_direction` — because a guard for names it
	// already knows cannot see a new one. `lib/tool-reachability.test.ts` is the guard that can; the
	// assertions here are the per-slug half it deliberately does not do (that a restated object
	// never LOSES a name).
	it("the Lead declares set_direction, and toolNamesFor therefore grants it", async () => {
		const { toolNamesFor } = await import("../agent-do-tools.js");
		const { tools } = effectiveDeclared("coder-lead");
		expect(tools).toContain("set_direction");
		// Declaration is necessary, not sufficient: a name outside CREATOR_SELECTABLE_TOOLS is
		// declared and still invisible. That is the second leg of the same trap.
		expect(toolNamesFor({ surfaces: [], runtime: null, workflow: null, tools } as never).has("set_direction")).toBe(true);
	});

	it("the Repo Coder declares github_workflow_runs", async () => {
		const { toolNamesFor } = await import("../agent-do-tools.js");
		const { tools } = effectiveDeclared("coder-repo");
		expect(tools).toContain("github_workflow_runs");
		expect(toolNamesFor({ surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION", tools } as never).has("github_workflow_runs")).toBe(true);
	});

	it("neither agent lost anything — 0108 restates both whole objects", () => {
		const lead = effectiveDeclared("coder-lead").tools;
		for (const n of ["list_subordinates", "subordinate_status", "delegate_goal", "check_delegation", "transfer_conversation", "github_list_pulls"]) {
			expect(lead, n).toContain(n);
		}
		const repo = effectiveDeclared("coder-repo").tools;
		for (const n of ["repo_tree", "repo_read_file", "repo_git", "repo_remote", "github_create_issue", "github_read_pull"]) {
			expect(repo, n).toContain(n);
		}
	});

	it("the Repo Coder still has ONE chat — the surfaceOption a whole-object set would drop", () => {
		// Covered generically above by "has not had the Co-pilot switched back on", pinned here too
		// because 0108 is the migration that would do it: `{repos,drive,copilot}` is not in the
		// tools array, so every tools assertion in this file passes while the Repo Coder silently
		// regains a second way to drive its engine (#154/#209).
		const last = effectiveWholeCapabilities("coder-repo");
		expect(last?.file, "the pin below names the migration that must be re-checked when it moves").toBe(
			"0121_repo_search_tools.sql",
		);
		const caps = last?.caps as { surfaceOptions?: { coding?: Record<string, unknown> } };
		expect(caps.surfaceOptions?.coding).toEqual({ repos: "single", drive: false, copilot: false });
	});

	it("passes the validator the create/update routes apply, like every seeded object", () => {
		const sql = readFileSync(join(MIGRATIONS, "0108_declare_unreachable_registry_tools.sql"), "utf8");
		const objs = [...sql.matchAll(/'\$\.capabilities'\s*,\s*json\('(\{[\s\S]*?\})'\)/g)];
		expect(objs.length, "0108 no longer re-sets three whole capabilities objects").toBe(3);
		for (const m of objs) {
			const caps = JSON.parse(m[1]) as Record<string, unknown>;
			expect(sanitizeDeclaredCapabilities(caps)).toEqual(caps);
		}
	});

	it("grants set_direction to nobody else — it can only resolve a subordinate", () => {
		// Same reasoning as 0107's `transfer_conversation`: the tool resolves its target inside the
		// caller's supervision graph, so on an agent without one it is a capability that cannot name
		// a single destination.
		for (const slug of ["coder", "coder-repo", "repo-chat"]) {
			expect(effectiveDeclared(slug).tools, slug).not.toContain("set_direction");
		}
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

describe("0119 — the Lead can FILE an issue, not just read one (#506)", () => {
	// The Lead was asked to file a GitHub issue, said it could not, fell back to `delegate_goal`,
	// and — when that failed for an unrelated reason (the repo's single-flight) — wrote the bug
	// report into `write_memory` with a promise to file it later. Nothing enforces such a promise.
	// Production agreed with the agent: `github_create_issue` read `not_declared` on that instance.
	//
	// Worth stating once, because it is why THIS file carries the assertion and not
	// `tool-reachability.test.ts`: that guard's question is "does SOME agent declare this tool",
	// and `coder-repo` declares `github_create_issue`, so it was green throughout. A per-agent gap
	// is invisible to a catalog-wide denominator.
	it("the Lead declares github_create_issue, and toolNamesFor therefore grants it", async () => {
		const { toolNamesFor } = await import("../agent-do-tools.js");
		const { tools } = effectiveDeclared("coder-lead");
		expect(tools).toContain("github_create_issue");
		// Declaration is necessary, not sufficient — a name outside CREATOR_SELECTABLE_TOOLS is
		// declared and still invisible. Same second leg as 0107/0108.
		expect(toolNamesFor({ surfaces: [], runtime: null, workflow: null, tools } as never).has("github_create_issue")).toBe(true);
	});

	it("keeps everything the Lead could already do — 0119 restates the whole object", () => {
		// The realistic way this migration goes wrong. 0107 restated this exact object and lost
		// `set_direction`; no tools assertion elsewhere would have noticed.
		const { tools } = effectiveDeclared("coder-lead");
		for (const n of [
			"list_subordinates",
			"subordinate_status",
			"delegate_goal",
			"check_delegation",
			"github_list_issues",
			"github_read_issue",
			"github_list_pulls",
			"github_read_pull",
			"transfer_conversation",
			"set_direction",
		]) {
			expect(tools, n).toContain(n);
		}
	});

	it("the Lead stays cloud-only — filing an issue is not a reason to grow a runtime", () => {
		// A whole-object set can drop or change `runtime`/`workflow`/`surfaces` as easily as a tool
		// name, and the Lead having neither is what makes it a delegator rather than a doer.
		const last = effectiveWholeCapabilities("coder-lead");
		expect(last?.caps.runtime, `${last?.file} gave the Lead a runtime`).toBeNull();
		expect(last?.caps.workflow, `${last?.file} gave the Lead a workflow`).toBeNull();
		expect(last?.caps.surfaces, `${last?.file} gave the Lead a console surface`).toEqual([]);
	});

	it("passes the validator the create/update routes apply, like every seeded object", () => {
		const sql = readFileSync(join(MIGRATIONS, "0119_coder_lead_file_issues.sql"), "utf8");
		const objs = [...sql.matchAll(/'\$\.capabilities'\s*,\s*json\('(\{[\s\S]*?\})'\)/g)];
		expect(objs.length, "0119 no longer re-sets a whole capabilities object").toBe(1);
		const caps = JSON.parse(objs[0][1]) as Record<string, unknown>;
		expect(sanitizeDeclaredCapabilities(caps)).toEqual(caps);
	});

	it("touches only coder-lead — no other agent gains a GitHub write by this migration", () => {
		const sql = readFileSync(join(MIGRATIONS, "0119_coder_lead_file_issues.sql"), "utf8");
		expect(sql).toContain("WHERE slug = 'coder-lead'");
		expect(sql).not.toMatch(/slug\s+IN\s*\(/i);
		expect([...sql.matchAll(/WHERE slug = '/g)].length).toBe(1);
	});
});

/**
 * Every slug any migration declares `capabilities` for.
 *
 * `effectiveDeclared` answers "what does THIS slug declare" and every caller above names its slug
 * literally, which is right for an assertion about a specific agent and wrong for an invariant that
 * must hold for agents nobody has written yet. This walks the migrations for the slugs themselves,
 * so a Coder-equivalent stamped out next month is covered with no test edit.
 */
function slugsDeclaredByAnyMigration(): string[] {
	const slugs = new Set<string>();
	for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
		const sql = readFileSync(join(MIGRATIONS, f), "utf8");
		for (const stmt of sql.split(/;\s*\n/)) {
			if (!stmt.includes("$.capabilities")) continue;
			const m = stmt.match(/slug\s*=\s*'([^']+)'/);
			if (m) slugs.add(m[1]);
		}
	}
	return [...slugs].sort();
}

describe("0120 — an agent that can OPEN an issue can follow it up (#507)", () => {
	const FOLLOW_UP = "github_comment_issue";

	/**
	 * THE PER-AGENT COHESION RULE, and an honest statement of how narrow it is.
	 *
	 * #444's guard (`tool-reachability.test.ts`) asks "does SOME agent declare this tool". It was
	 * green through both of the gaps this pair of issues is about — `coder-repo` declares
	 * `github_create_issue`, so the Lead having no way to file an issue (#506) was invisible to it,
	 * and nothing at all noticed that every Coder could open a ticket it could never touch again.
	 * A catalog-wide denominator cannot see a per-agent hole; that is a limit of the question, not
	 * a bug in the guard.
	 *
	 * The general fix — a statement of what each agent SHOULD hold — is not derivable from the
	 * catalog: it is a product decision per agent. So this does the small, checkable part instead.
	 * It encodes ONE relationship between two tools: opening a ticket you cannot comment on is an
	 * incomplete capability, and the transcripts show what that incompleteness costs (a Pilot run
	 * and an Engine session to write one sentence). It does NOT claim to close #444's blind spot in
	 * general, and it should not be read as though it does.
	 */
	it("every agent declaring github_create_issue also declares github_comment_issue", () => {
		let checked = 0;
		for (const slug of slugsDeclaredByAnyMigration()) {
			// A slug whose migrations set `$.capabilities` without a `tools` array (surfaces-only
			// edits, board columns) has no declaration to be incoherent — skip it rather than throw.
			let declared: { file: string; tools: string[] };
			try {
				declared = effectiveDeclared(slug);
			} catch {
				continue;
			}
			const { tools, file } = declared;
			if (!tools.includes("github_create_issue")) continue;
			checked++;
			expect(
				tools,
				`${slug} (last declared in ${file}) can OPEN a GitHub issue and then never touch it again. ` +
					`Declare ${FOLLOW_UP} for it, or take github_create_issue away — an agent that can only file ` +
					`is one whose follow-up costs a whole coding run (#507).`,
			).toContain(FOLLOW_UP);
		}
		// A cohesion rule that matched no agent would pass forever while meaning nothing.
		expect(checked, "no agent declares github_create_issue — the walk or the parser is broken").toBeGreaterThanOrEqual(3);
	});

	it("covers the agents it claims to — the walk is not silently empty", () => {
		// The way this assertion gets neutered is a migration shape the slug walk cannot read, not
		// someone editing the expectation.
		const slugs = slugsDeclaredByAnyMigration();
		expect(slugs.length).toBeGreaterThan(3);
		for (const s of ["coder", "coder-repo", "coder-lead"]) expect(slugs).toContain(s);
	});

	it("the Repo Coder and the legacy Coder can close, relabel and assign", async () => {
		const { toolNamesFor } = await import("../agent-do-tools.js");
		for (const slug of ["coder-repo", "coder"]) {
			const { tools } = effectiveDeclared(slug);
			for (const n of [FOLLOW_UP, "github_update_issue"]) {
				expect(tools, `${slug} is missing ${n}`).toContain(n);
				// Declaration is necessary, not sufficient — a name outside CREATOR_SELECTABLE_TOOLS is
				// declared and still invisible.
				expect(
					toolNamesFor({ surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION", tools } as never).has(n),
					`${slug}: ${n} declared but not granted`,
				).toBe(true);
			}
		}
	});

	it("the Lead can comment and deliberately CANNOT close", () => {
		// A Lead learns that work is done second-hand, from `check_delegation` — the field it has
		// already been observed over-trusting. Leaving the record on a ticket is reporting; closing
		// it is a claim about someone else's work. One extra name in a new migration reverses this
		// if the owner decides otherwise, which is the point of it being data.
		const { tools } = effectiveDeclared("coder-lead");
		expect(tools).toContain(FOLLOW_UP);
		expect(tools).not.toContain("github_update_issue");
	});

	it("nobody lost anything — 0120 restates three whole objects", () => {
		const repo = effectiveDeclared("coder-repo").tools;
		for (const n of ["repo_tree", "repo_read_file", "repo_git", "repo_remote", "github_create_issue", "github_read_pull", "github_workflow_runs"]) {
			expect(repo, n).toContain(n);
		}
		const lead = effectiveDeclared("coder-lead").tools;
		for (const n of ["list_subordinates", "subordinate_status", "delegate_goal", "check_delegation", "transfer_conversation", "set_direction", "github_create_issue"]) {
			expect(lead, n).toContain(n);
		}
		const coder = effectiveDeclared("coder").tools;
		for (const n of ["github_create_issue", "github_list_issues", "github_read_issue", "github_list_pulls", "github_read_pull"]) {
			expect(coder, n).toContain(n);
		}
	});

	it("passes the validator the create/update routes apply, like every seeded object", () => {
		const sql = readFileSync(join(MIGRATIONS, "0120_coder_issue_mutation_tools.sql"), "utf8");
		const objs = [...sql.matchAll(/'\$\.capabilities'\s*,\s*json\('(\{[\s\S]*?\})'\)/g)];
		expect(objs.length, "0120 no longer re-sets three whole capabilities objects").toBe(3);
		for (const m of objs) {
			const caps = JSON.parse(m[1]) as Record<string, unknown>;
			expect(sanitizeDeclaredCapabilities(caps)).toEqual(caps);
		}
	});

	it("grants the issue writes to nobody else — repo-chat stays knowledge-only", () => {
		const { tools } = effectiveDeclared("repo-chat");
		expect(tools.filter((n) => n.startsWith("github_"))).toEqual([]);
	});
});


describe("0121 — the Repo Coder can FIND a file (#508)", () => {
	it("declares the two search tools on both repo-local agents", () => {
		// `capabilities.tools` is an AUTHORITATIVE allowlist, so a connector tool no agent names is
		// a tool no agent has — silently. Without this migration `repo_find` and `repo_grep` would
		// ship complete and unreachable, which is the exact class #444 built its guard for.
		for (const slug of ["coder-repo", "local-repo-chat"]) {
			const { tools } = effectiveDeclared(slug);
			expect(tools, `${slug} repo_find`).toContain("repo_find");
			expect(tools, `${slug} repo_grep`).toContain("repo_grep");
		}
	});

	it("keeps every tool 0120 granted — a whole-object set drops what it does not restate", () => {
		// The trap 0108 wrote down after 0107 lost `set_direction` exactly this way, and the reason
		// the pin above exists. 0121 is another whole-object set over coder-repo.
		const repo = effectiveDeclared("coder-repo").tools;
		for (const n of [
			"repo_tree", "repo_read_file", "repo_git", "repo_remote",
			"github_list_issues", "github_read_issue", "github_create_issue",
			"github_list_pulls", "github_read_pull", "github_workflow_runs",
			"github_comment_issue", "github_update_issue",
		]) {
			expect(repo, n).toContain(n);
		}
		// local-repo-chat keeps its original four (0066), which are its whole surface.
		const chat = effectiveDeclared("local-repo-chat").tools;
		for (const n of ["repo_tree", "repo_read_file", "repo_git", "repo_remote"]) expect(chat, n).toContain(n);
	});

	it("does NOT give them to the agents that reach code through an Engine instead", () => {
		// `coder` and `coder-lead` declare no repo_* tool at all — they do not use this connector,
		// so a search tool with no companion read tools would be noise in their prompt.
		for (const slug of ["coder", "coder-lead"]) {
			const { tools } = effectiveDeclared(slug);
			expect(tools, slug).not.toContain("repo_find");
			expect(tools, slug).not.toContain("repo_grep");
		}
	});

	it("passes the validator the create/update routes apply, like every seeded object", () => {
		const sql = readFileSync(join(MIGRATIONS, "0121_repo_search_tools.sql"), "utf8");
		const objs = [...sql.matchAll(/'\$\.capabilities'\s*,\s*json\('(\{[\s\S]*?\})'\)/g)];
		expect(objs.length, "0121 no longer re-sets two whole capabilities objects").toBe(2);
		for (const m of objs) {
			const caps = JSON.parse(m[1]) as Record<string, unknown>;
			expect(sanitizeDeclaredCapabilities(caps)).toEqual(caps);
		}
	});
});
