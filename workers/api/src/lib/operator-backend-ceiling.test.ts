/**
 * migration 0104 (#402): the kitty and iTerm2 Operators declare the backend their names claim.
 *
 * 0099 could not do this. It made the tmux Operator true BY CONSTRUCTION — the `tmux_*` tools have
 * no other backend behind them — and there is no `kitty_*` or `iterm2_*` connector to repeat that
 * with, so it rewrote those two DESCRIPTIONS to admit they reach all three backends and left the
 * capability to #402. `lib/tmux-operator-seed.test.ts` still pins that older text against 0099's
 * own SQL, which is correct: a migration's assertions are about the migration. What the ROW says
 * afterwards is this file's business, and the two sentences are opposites on purpose.
 *
 * Checked the way 0099's, 0087's and 0057's seeds are: parse what the migration will actually
 * write, then resolve it through the REAL capability plumbing and the REAL dispatcher gate. A SQL
 * file cannot state that a ceiling it writes will survive the sanitiser, and a ceiling that does
 * not survive is config the next agent update deletes.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentCapabilities, sanitizeDeclaredCapabilities } from "./agent-capabilities.js";
import { lintAgentClaims } from "./agent-claims-lint.js";
import { CONNECTOR_CONSTRAINTS, constraintsFor, enforceConstraints } from "./surface-options.js";
import { getRegistryTool } from "./tool-registry.js";

const SQL = readFileSync(fileURLToPath(new URL("../../migrations/0104_operator_backend_ceilings.sql", import.meta.url)), "utf8");

/** The statements alone. Comments discuss the paths and fields this migration does NOT write, so
 *  an assertion about what it writes has to read what runs — the same split `check-migrations.mjs`
 *  makes when it decides whether an applied migration was edited. */
const DDL = SQL.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

/** One `UPDATE … WHERE slug = 'x'` block's backends list and description, read out of the SQL. */
function statementFor(slug: string): { backends: string[]; description: string; path: string } {
	const block = DDL.split("UPDATE agents").find((s) => s.includes(`slug = '${slug}'`)) ?? "";
	return {
		backends: JSON.parse(/json\('(\[[^)]*\])'\)/.exec(block)?.[1] ?? "[]"),
		description: /description = '([^']*)'/.exec(block)?.[1] ?? "",
		path: /'(\$\.[^']+)'/.exec(block)?.[1] ?? "",
	};
}

const KITTY = statementFor("kitty-operator");
const ITERM = statementFor("iterm-operator");

/**
 * The rows as they stand in production TODAY (read from the live D1 on 2026-08-08), so the test
 * resolves the migration against the config it will really be applied to rather than an invented
 * one. Both are `visibility = 'draft'`; both carry the generic terminal tools and no
 * `surfaceOptions` at all.
 */
const LIVE_CONFIG = {
	capabilities: {
		surfaces: ["tmux"],
		runtime: "coding",
		workflow: null,
		tools: ["terminal_list_targets", "terminal_capture", "terminal_run_command", "terminal_send_keys", "terminal_new_target", "terminal_kill_target"],
	},
};

/** What the row's config becomes: the live object with only the migration's path set. */
function applied(backends: string[]): Record<string, unknown> {
	return {
		capabilities: { ...LIVE_CONFIG.capabilities, surfaceOptions: { terminal: { backends } } },
	};
}

describe("migration 0104 — the ceiling each operator declares", () => {
	it("gives kitty the kitty backend and iTerm2 the iterm2 backend, and nothing else", () => {
		expect(KITTY.backends).toEqual(["kitty"]);
		expect(ITERM.backends).toEqual(["iterm2"]);
	});

	it("writes values the closed vocabulary actually contains", () => {
		// A typo here is not a build failure: `parseConstraintSpec` drops an unknown value, so the
		// row would read as having no ceiling and the agent would quietly reach all three again.
		const def = CONNECTOR_CONSTRAINTS.terminal.backends;
		const values = def.kind === "values" ? def.values : [];
		for (const b of [...KITTY.backends, ...ITERM.backends]) expect(values).toContain(b);
	});

	it("sets the NARROWEST path, so nothing an earlier migration wrote can be dropped", () => {
		// The whole-object trap: re-setting `$.capabilities` means reproducing surfaces, runtime,
		// workflow and the six declared tools, and getting one wrong silently removes a capability.
		for (const s of [KITTY, ITERM]) expect(s.path).toBe("$.capabilities.surfaceOptions.terminal.backends");
		// EVERY path this file WRITES, not just the two the parser above happened to find first.
		// (`$.capabilities` appears once more, in the WHERE guard — a read, which is the point of it.)
		const written = [...DDL.matchAll(/json_set\([^)]*?'(\$\.[^']+)'/gs)].map((m) => m[1]);
		expect(written).toEqual(["$.capabilities.surfaceOptions.terminal.backends", "$.capabilities.surfaceOptions.terminal.backends"]);
	});

	it("touches neither the generic Terminal Operator nor the tmux Operator", () => {
		// `terminal-operator` must stay `many`: exercising the whole connector is its entire
		// purpose and its description already says so. `tmux-operator` declares `tmux_*` tools,
		// whose connector has no constraint vocabulary — a `terminal` ceiling on that row would be
		// dropped by the sanitiser on the next write, i.e. config that reads as a ceiling and is not.
		expect(DDL).not.toMatch(/slug = 'terminal-operator'/);
		expect(DDL).not.toMatch(/slug = 'tmux-operator'/);
		expect(CONNECTOR_CONSTRAINTS.tmux).toBeUndefined();
	});

	it("declares no cardinality — these are backend test agents, not single-pane operators", () => {
		// `many` is the default and the reason every existing agent stays byte-identical. A
		// `targets: "single"` here would demand a bound target before either agent could be used.
		expect(DDL).not.toMatch(/targets/);
	});
});

describe("migration 0104 — the ceiling survives the plumbing that will read it", () => {
	for (const [slug, backends] of [
		["kitty-operator", KITTY.backends],
		["iterm-operator", ITERM.backends],
	] as const) {
		it(`${slug}: resolves through agentCapabilities and survives the sanitiser`, () => {
			const caps = agentCapabilities({ slug, category: "coding", config: JSON.stringify(applied(backends)) });
			expect(constraintsFor(caps, "terminal")).toEqual({ backends });
			// The write path an agent UPDATE takes. A field the sanitiser drops would vanish the
			// first time anyone edited the agent, long after this migration looked applied.
			const sanitized = sanitizeDeclaredCapabilities(applied(backends).capabilities);
			expect(sanitized?.surfaceOptions).toEqual({ terminal: { backends } });
			// And the six declared tools are still there — the thing a whole-object set would lose.
			expect(sanitized?.tools).toEqual(LIVE_CONFIG.capabilities.tools);
		});

		it(`${slug}: the gate refuses the two backends the name does not claim`, () => {
			const caps = agentCapabilities({ slug, category: "coding", config: JSON.stringify(applied(backends)) });
			const spec = constraintsFor(caps, "terminal");
			const capture = getRegistryTool("terminal_capture");
			if (!capture) throw new Error("terminal_capture is not registered");
			for (const other of ["tmux", "kitty", "iterm2"].filter((b) => !backends.includes(b))) {
				const r = enforceConstraints(capture, spec, { target: `${other}:1` });
				expect(r.ok, other).toBe(false);
			}
			// Its own backend goes through, and a defaulted `backend` is narrowed to it.
			expect(enforceConstraints(capture, spec, { target: `${backends[0]}:1` })).toEqual({
				ok: true,
				input: { target: `${backends[0]}:1`, backend: backends[0] },
			});
		});
	}
});

describe("migration 0104 — the descriptions go back, because the capability changed", () => {
	it("no longer says the agent reaches all three backends — 0099's sentence is now FALSE", () => {
		// A description that understates a capability and one that overstates it are the same
		// defect. 0099's copy was true when it was written and stops being true here, so it is
		// rewritten in the SAME migration that changes the capability rather than left to drift.
		for (const s of [KITTY, ITERM]) {
			expect(s.description).not.toMatch(/reach tmux, kitty and iTerm2 alike/);
			expect(s.description).not.toMatch(/every local terminal/);
		}
	});

	it("names the mechanism rather than promising, so the claim is checkable", () => {
		for (const s of [KITTY, ITERM]) {
			expect(s.description).toMatch(/surfaceOptions\.terminal\.backends/);
			expect(s.description).toMatch(/enforced at dispatch/);
		}
		expect(KITTY.description).toMatch(/cannot see or drive tmux sessions or iTerm2 windows/);
		expect(ITERM.description).toMatch(/cannot see or drive tmux sessions or kitty windows/);
	});

	it("the claims lint stays clean — and still cannot see this class of claim", () => {
		// Recorded rather than presented as a verdict, exactly as 0099's test recorded it. The lint
		// asks whether a RUNTIME claim is backed by `runtime`/`workflow`; both rows genuinely
		// declare `runtime: "coding"`. What #402 fixes is WHICH RESOURCE that runtime reaches,
		// which the lint structurally does not look at — the constraint is now declared data it
		// COULD read, and teaching it to is not in this ticket.
		for (const s of [KITTY, ITERM]) {
			expect(lintAgentClaims({ description: s.description, capabilities: { runtime: "coding", workflow: null } })).toEqual([]);
		}
	});
});
