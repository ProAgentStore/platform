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
import { CONNECTOR_CONSTRAINTS, constraintsFor, enforceConstraints, narrowConstraintSpec } from "./surface-options.js";
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

/**
 * migration 0112 (#441): the FIRST agent anywhere to declare `targets: "single"`.
 *
 * #402 shipped the binding whole — it parses, it narrows, it is writable through
 * `PUT /v1/instances/:id/terminal-target`, and `enforceBinding` refuses on it at dispatch — and
 * then nothing declared it. Of the three production rows carrying `surfaceOptions` at all, every
 * one declares only a VALUE ceiling. So the two keys had never been round-tripped together, and
 * the refusal a `single` agent exists to give had never been produced by a real row.
 *
 * Checked the way 0104's is: parse what the migration will actually write, then resolve it through
 * the REAL parser, the REAL sanitiser, the REAL creator→subscriber merge and the REAL dispatcher
 * gate. A SQL file cannot state that the field it writes survives the sanitiser, and a field that
 * does not survive is config the next agent update deletes.
 */
const SEED_SQL = readFileSync(fileURLToPath(new URL("../../migrations/0112_seed_single_pane_operator_agent.sql", import.meta.url)), "utf8");
const SEED_DDL = SEED_SQL.split("\n")
	.filter((l) => !l.trimStart().startsWith("--"))
	.join("\n");

/** The config the INSERT writes, read out of the SQL rather than restated here. `''` is SQL's
 *  escaped apostrophe, not JSON's. */
const SEED_CONFIG = JSON.parse((/json\('(\{[\s\S]*?\})'\),\s*\n\s*datetime/.exec(SEED_DDL)?.[1] ?? "{}").replace(/''/g, "'")) as {
	capabilities: Record<string, unknown>;
};

const SEED_AGENT = { slug: "single-pane-operator", category: "coding", config: JSON.stringify(SEED_CONFIG) };
const CAPTURE = getRegistryTool("terminal_capture");
const LIST = getRegistryTool("terminal_list_targets");
if (!CAPTURE || !LIST) throw new Error("the terminal tools are not registered");

describe("migration 0112 — a `single` declaration that survives the round trip", () => {
	it("declares BOTH keys: the backend ceiling and the cardinality", () => {
		expect(constraintsFor(agentCapabilities(SEED_AGENT), "terminal")).toEqual({ backends: ["tmux"], targets: "single" });
	});

	it("survives `sanitizeDeclaredCapabilities` — the property #441 says was never exercised", () => {
		// The write path an agent UPDATE takes. `parseConstraintSpec` handles a value list and a
		// binding field in two different branches; a row carrying both is what proves neither branch
		// eats the other. A field the sanitiser drops would vanish the first time anyone edited the
		// agent, long after this migration looked applied.
		const sanitized = sanitizeDeclaredCapabilities(SEED_CONFIG.capabilities);
		expect(sanitized?.surfaceOptions).toEqual({ terminal: { backends: ["tmux"], targets: "single" } });
		expect(sanitized?.tools).toEqual(["terminal_list_targets", "terminal_capture", "terminal_run_command", "terminal_send_keys"]);
	});

	it("declares no `boundTarget` — the bound identity is the SUBSCRIBER's half", () => {
		// And unbound is the interesting state: it is what produces the "bind one first" refusal
		// instead of a guess at somebody's pane.
		expect(constraintsFor(agentCapabilities(SEED_AGENT), "terminal")).not.toHaveProperty("boundTarget");
		expect(SEED_DDL).not.toMatch(/boundTarget/);
	});

	it("declares no create/kill tool — 'may not make a second terminal' is a MISSING tool, not a constraint", () => {
		const tools = agentCapabilities(SEED_AGENT).tools ?? [];
		expect(tools).not.toContain("terminal_new_target");
		expect(tools).not.toContain("terminal_kill_target");
		// `terminal_list_targets` must stay: it takes no `target`, so the binding never gates it, and
		// it is how a subscriber discovers what to bind. Withholding it would leave a fresh instance
		// unconfigurable.
		expect(tools).toContain("terminal_list_targets");
	});

	it("is a DRAFT, so no published catalog entry changes", () => {
		expect(SEED_DDL).toMatch(/'draft'/);
	});

	it("writes the NARROWEST paths on the converging UPDATE", () => {
		// Re-setting `$.capabilities` would mean reproducing surfaces, runtime, workflow and the
		// declared tools, and getting one wrong silently removes a capability.
		// EVERY JSON path the file mentions, not only the ones a json_set-shaped regex happens to
		// find first — the whole risk is a path nobody looked at.
		const written = [...SEED_DDL.matchAll(/'(\$\.[^']+)'/g)].map((m) => m[1]);
		expect(written).toEqual(["$.capabilities.surfaceOptions.terminal.backends", "$.capabilities.surfaceOptions.terminal.targets"]);
	});

	it("names the mechanism in its description, and the claims lint stays clean", () => {
		const description = /'(Drives exactly ONE[^']*)',/.exec(SEED_DDL)?.[1] ?? "";
		expect(description).toMatch(/surfaceOptions\.terminal\.targets/);
		expect(description).toMatch(/enforced at dispatch/);
		expect(lintAgentClaims({ description, capabilities: { runtime: "coding", workflow: null } })).toEqual([]);
	});
});

/**
 * The four outcomes #441 asks to be recorded, driven through the real merge and the real gate.
 *
 * `bound()` is the subscriber's `PUT …/terminal-target` reduced to what it stores — an instance
 * `surfaceOptions` — merged by `narrowConstraintSpec`, which is the same function
 * `connectorConstraintsForInstance` calls before handing the result to `enforceConstraints`. So
 * these run the seed's own declaration through the whole chain bar the D1 read.
 */
describe("migration 0112 — the four outcomes of a single-target agent", () => {
	const CEILING = constraintsFor(agentCapabilities(SEED_AGENT), "terminal");
	const bound = (target: string | null) => narrowConstraintSpec("terminal", CEILING, target ? { boundTarget: target } : undefined);

	it("(a) UNBOUND: a target-taking call is refused rather than guessing a pane", () => {
		const r = enforceConstraints(CAPTURE, bound(null), { target: "tmux:main" });
		expect(r.ok).toBe(false);
		expect(!r.ok && r.refusal).toContain("`terminal.targets` (single)");
		expect(!r.ok && r.refusal).toMatch(/terminal-target/);
	});

	it("(a′) UNBOUND: listing still works — that is how you discover what to bind", () => {
		expect(enforceConstraints(LIST, bound(null), {})).toEqual({ ok: true, input: { backend: "tmux" } });
	});

	it("(b) BOUND: the bound pane passes, and an omitted target is filled with it", () => {
		expect(enforceConstraints(CAPTURE, bound("tmux:main"), { target: "tmux:main" })).toEqual({ ok: true, input: { target: "tmux:main", backend: "tmux" } });
		expect(enforceConstraints(CAPTURE, bound("tmux:main"), {})).toEqual({ ok: true, input: { target: "tmux:main", backend: "tmux" } });
		// The same pane written the other way, canonicalised to the bound form so the runner is
		// addressed exactly one way.
		expect(enforceConstraints(CAPTURE, bound("tmux:main"), { target: "main" })).toEqual({ ok: true, input: { target: "tmux:main", backend: "tmux" } });
	});

	it("(c) BOUND: any OTHER pane is refused, naming what is bound", () => {
		const r = enforceConstraints(CAPTURE, bound("tmux:main"), { target: "tmux:other" });
		expect(r.ok).toBe(false);
		expect(!r.ok && r.refusal).toContain("tmux:main");
		expect(!r.ok && r.refusal).toContain("tmux:other");
	});

	it("(d) a target naming another BACKEND is refused as a backend violation, not a binding one", () => {
		// Table order decides which constraint gets reported, and reporting the one that actually
		// applies is the difference between a usable refusal and a misleading one.
		const r = enforceConstraints(CAPTURE, bound("tmux:main"), { target: "kitty:main" });
		expect(r.ok).toBe(false);
		expect(!r.ok && r.refusal).toContain("`terminal.backends` (tmux)");
	});

	it("a subscriber cannot bind OUTSIDE the ceiling — the widen attempt in its other form", () => {
		expect(bound("kitty:3")).toEqual({ backends: ["tmux"], targets: "single" });
	});
});
