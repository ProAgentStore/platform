// The site-builder agent seed (migration 0057) embeds its two pipeline definitions in
// `agents.config.pipelines`, because subscribe copies them into each new instance — that's
// what makes a pipeline-only agent work the moment you subscribe. The definitions therefore
// exist in two places: the reference JSON here, and the SQL.
//
// This test is the thing that stops them drifting. Without it, editing site-builder.json
// would leave every NEW subscriber on the old definition while site-builder.test.ts stayed
// green against the file — the worst kind of drift, invisible and only reproducible in prod.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import siteBuilder from "./site-builder.json" with { type: "json" };
import siteDeploy from "./site-deploy.json" with { type: "json" };
import leadFinder from "./lead-finder.json" with { type: "json" };
import leadOutreach from "./lead-outreach.json" with { type: "json" };
import { declaredParamDefaults, validatePipeline } from "../pipeline.js";
import { agentCapabilities } from "../agent-capabilities.js";
import { pipelineDeclarationError, undeclaredPipelineTools, type ToolNamingSteps } from "../pipeline-tool-policy.js";
import { getRegistryTool } from "../tool-registry.js";

const MIGRATION = fileURLToPath(new URL("../../../migrations/0057_seed_site_builder_agent.sql", import.meta.url).href);

/** Pull the agent's config JSON back out of the migration's `json('…')` literal. */
function seededAgentConfig(): Record<string, unknown> {
	const sql = readFileSync(MIGRATION, "utf8");
	const start = sql.indexOf("json('");
	const end = sql.indexOf("'),\n  datetime('now')", start);
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	// SQL escapes a single quote by doubling it.
	const literal = sql.slice(start + "json('".length, end).replace(/''/g, "'");
	return JSON.parse(literal) as Record<string, unknown>;
}

describe("migration 0057 — the seeded agent", () => {
	const config = seededAgentConfig();
	const pipelines = config.pipelines as Record<string, unknown>;

	it("embeds the SAME pipeline definitions as the reference JSON", () => {
		expect(pipelines["site-builder"]).toEqual(siteBuilder);
		expect(pipelines["site-deploy"]).toEqual(siteDeploy);
	});

	it("embeds definitions the runner will actually accept", () => {
		// A seed that fails validatePipeline would be silently dropped on subscribe.
		expect(validatePipeline(pipelines["site-builder"])).toBeNull();
		expect(validatePipeline(pipelines["site-deploy"])).toBeNull();
	});

	it("is cloud-only — no local runner, no bespoke workflow", () => {
		const caps = config.capabilities as Record<string, unknown>;
		expect(caps.runtime).toBeNull();
		expect(caps.workflow).toBeNull();
	});

	it("asks the subscriber for the builder endpoint rather than hardcoding one", () => {
		// settingsSchema must sit at TOP-LEVEL config.settingsSchema — agentCapabilities reads
		// it from there (lib/agent-capabilities.ts), so nesting it under `capabilities` silently
		// yields no settings card and the subscriber can never enter their endpoint.
		const schema = config.settingsSchema as Array<{ id: string }>;
		expect(Array.isArray(schema)).toBe(true);
		expect(schema.map((f) => f.id)).toEqual(["mcp_url", "template_slug", "photo_limit"]);
		expect((config.capabilities as Record<string, unknown>).settingsSchema).toBeUndefined();
		expect(JSON.stringify(config)).not.toMatch(/freewebstore|freeappstore|freegamestore/i);
	});

	it("survives the real capability resolver with its settings intact", () => {
		// End-to-end on the seed: what the console will actually be handed.
		const caps = agentCapabilities({ slug: "site-builder", category: "Sales", config: JSON.stringify(config) });
		expect(caps.runtime).toBeNull();
		expect(caps.settingsSchema?.map((f) => f.id)).toEqual(["mcp_url", "template_slug", "photo_limit"]);
	});
});

// ── #381 ────────────────────────────────────────────────────────────────────────
// `capabilities.tools` is now enforced on pipeline steps, so an agent that ships WITH pipelines
// must declare the connector tools they dispatch or its own work is refused. 0057 declared none —
// which is exactly the drift this file exists to catch, one field over — so 0096 adds them.
//
// A second file, because 0057 has already run in production and editing an applied migration
// changes nothing there while a fresh database gets the new text.
const TOOLS_MIGRATION = fileURLToPath(new URL("../../../migrations/0096_site_builder_declared_tools.sql", import.meta.url).href);

describe("migration 0096 — the seeded agent declares what its pipelines dispatch", () => {
	/** The tool names out of the migration's `json('[…]')` literal. */
	function declaredTools(): string[] {
		const sql = readFileSync(TOOLS_MIGRATION, "utf8");
		const literal = sql.match(/json\('(\[[^']*\])'\)/);
		expect(literal, "0096 must set capabilities.tools from a json('[…]') literal").not.toBeNull();
		return JSON.parse((literal as RegExpMatchArray)[1]) as string[];
	}

	it("covers every gated tool in BOTH shipped pipelines", () => {
		// Asked of the real registry through the real rule, so a step swapped for a different
		// connector tool fails here rather than at 3am on someone's cron. Via the rule rather than
		// `steps[].tool` since #396: a step can reach a connector tool it does not name (`geocode`
		// needs `http_request`), and a hand-rolled derivation here would be exactly the second
		// reading of the definition that issue is about.
		const declaresNothing = agentCapabilities({ slug: "site-builder", category: "Sales", config: JSON.stringify({ capabilities: { surfaces: [], runtime: null, workflow: null, tools: [] } }) });
		const gated = [...new Set([siteBuilder, siteDeploy].flatMap((p) => undeclaredPipelineTools(p, declaresNothing, getRegistryTool).map((u) => u.tool)))];
		expect(gated.length).toBeGreaterThan(0);
		expect([...declaredTools()].sort()).toEqual(gated.sort());
	});

	it("makes the seeded agent's own pipelines pass the gate", () => {
		// The whole point, end to end: 0057's config plus 0096's tools, through the real resolver
		// and the real rule. Without 0096 both of these name their first connector step.
		const seeded = seededAgentConfig();
		const caps = agentCapabilities({
			slug: "site-builder",
			category: "Sales",
			config: JSON.stringify({ ...seeded, capabilities: { ...(seeded.capabilities as object), tools: declaredTools() } }),
		});
		expect(pipelineDeclarationError(siteBuilder, caps, getRegistryTool)).toBeNull();
		expect(pipelineDeclarationError(siteDeploy, caps, getRegistryTool)).toBeNull();
	});
});

// ── #394 ────────────────────────────────────────────────────────────────────────
// The lead finder had the SAME two-copy problem as site-builder above and none of the guard.
// `6b37070` fixed the 1MiB crash in `lead-finder.json`, but nothing loaded that file in
// production: `loadPipeline` reads `agent_instances.config.pipelines[key]`, which is seeded from
// `agents.config.pipelines` on subscribe, and the agent row had no `pipelines` key at all. So the
// fix reached nobody, and the one live instance stayed on a hand-attached 8-step copy missing
// exactly the two steps the fix added. 0111 seeds it; this describes what must stay true of it.
const LEAD_FINDER_MIGRATION = fileURLToPath(new URL("../../../migrations/0111_seed_lead_finder_pipeline.sql", import.meta.url).href);

/**
 * Every `json('…')` literal in a migration, in order, with SQL's doubled single quotes undone.
 *
 * A scanner rather than a regex because the lead-finder definition contains an apostrophe
 * (`the agent''s max_places setting`), and a non-greedy `json\('(.*?)'\)` stops dead on it —
 * silently, yielding a truncated string that fails to parse for a reason that looks nothing like
 * the cause.
 */
function jsonLiterals(path: string): unknown[] {
	const sql = readFileSync(path, "utf8");
	const OPEN = "json('";
	const out: unknown[] = [];
	let i = sql.indexOf(OPEN);
	while (i !== -1) {
		let j = i + OPEN.length;
		let raw = "";
		for (;;) {
			const q = sql.indexOf("'", j);
			expect(q, `unterminated ${OPEN}…') literal in ${path}`).toBeGreaterThan(-1);
			raw += sql.slice(j, q);
			if (sql[q + 1] === "'") {
				raw += "'";
				j = q + 2;
				continue;
			}
			j = q + 1;
			break;
		}
		out.push(JSON.parse(raw));
		i = sql.indexOf(OPEN, j);
	}
	return out;
}

describe("migration 0111 — the seeded lead-finder pipeline", () => {
	const literals = jsonLiterals(LEAD_FINDER_MIGRATION);
	const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
	// Picked by SHAPE, not by position, so re-ordering the statements cannot silently swap what
	// each assertion is talking about.
	// `& ToolNamingSteps` so the kick-gate assertion below can pass it straight to
	// `pipelineDeclarationError`. The claim is not taken on trust: "embeds the SAME definition as
	// the reference JSON" and "passes validatePipeline" both run against this same value, and
	// either would fail first if the steps were not the tool-naming shape.
	const seededDef = literals.find((l) => isRecord(l) && Array.isArray(l.steps)) as Record<string, unknown> & ToolNamingSteps;
	const seededSchema = literals.find((l) => Array.isArray(l) && l.every(isRecord)) as Array<{ id: string; type: string; default?: unknown }>;
	const seededTools = literals.find((l) => Array.isArray(l) && l.every((x) => typeof x === "string")) as string[];

	it("embeds the SAME definition as the reference JSON", () => {
		// The whole point of the file. Editing lead-finder.json without re-running the seed leaves
		// every future subscriber on the old definition, which is how the 1MiB fix came to be live
		// in the runner and absent from every agent that runs it.
		expect(seededDef).toEqual(leadFinder);
	});

	it("embeds a definition the runner will actually accept", () => {
		// `defaultPipelinesFor` drops an invalid def on subscribe — silently. A seed that fails here
		// would look applied and hand out nothing.
		expect(validatePipeline(seededDef)).toBeNull();
	});

	it("is filed under `lead_finder`, and says so in its own name field", () => {
		// The KEY is what resolves (`loadPipeline`), and production — the live instance,
		// `pipeline_runs.pipeline`, the console, the one lead.created connection — says `lead_finder`.
		// Seeding under `lead-finder` would have created a SECOND pipeline beside the live one.
		const sql = readFileSync(LEAD_FINDER_MIGRATION, "utf8");
		expect(sql).toContain("'$.pipelines.lead_finder'");
		expect(sql).not.toContain("'$.pipelines.lead-finder'");
		// And key == name, because `defaultPipelinesFor` copies what it is given without running it
		// through `pipelineDefForKey` — so a def whose name disagreed with its key would re-create
		// #173's split (runs under one spelling, every workflow log line under the other) for every
		// new subscriber.
		expect(seededDef.name).toBe("lead_finder");
	});

	it("declares max_places at TOP-LEVEL settingsSchema, addressing the param by name", () => {
		// Not under `capabilities`: `agentCapabilities` reads `cfg.settingsSchema`, so nesting it
		// yields no settings card and the cap can never be turned. And the id must be the PARAM name
		// exactly — `paramsWithDefaults` matches by id, which is why site-builder's camelCase params
		// never received their snake_case settings.
		expect(seededSchema.map((f) => f.id)).toEqual(["max_places"]);
		expect(Object.keys(declaredParamDefaults(leadFinder))).toContain("max_places");
		expect(seededSchema[0].type).toBe("number");
	});

	it("gives the setting the same default the definition declares", () => {
		// `resolveSettingsValues` emits a field's default even when the subscriber has set nothing,
		// and `paramsWithDefaults` ranks settings ABOVE the declared default — so a settings default
		// that disagreed would quietly overrule the pipeline's own cap on every untouched instance.
		expect(seededSchema[0].default).toBe(declaredParamDefaults(leadFinder).max_places);
	});

	it("survives the real capability resolver — settings and tools both land", () => {
		// This agent declares no `surfaces` array, so it resolves down the FALLBACK branch. Both
		// fields have to be honored there too, and that is a branch a hand-built literal never takes.
		const caps = agentCapabilities({
			slug: "small-business-website-lead-finder",
			category: "sales",
			config: JSON.stringify({ capabilities: { tools: seededTools }, settingsSchema: seededSchema, pipelines: { lead_finder: seededDef } }),
		});
		expect(caps.settingsSchema?.map((f) => f.id)).toEqual(["max_places"]);
		expect(caps.tools).toEqual(seededTools);
		expect(caps.runtime).toBeNull();
	});

	it("declares every gated tool the definition REACHES, nested ones included", () => {
		// Derived from the real registry through the real rule, not restated by hand. This is the
		// #396 case in the wild: only step 2 NAMES `http_request`, while `geocode` (step 0) and
		// `fan_out` (step 1) dispatch it from inside their handlers. A check that read `steps[].tool`
		// would pass a definition with the explicit step removed and still be refused mid-run.
		const declaresNothing = agentCapabilities({
			slug: "small-business-website-lead-finder",
			category: "sales",
			config: JSON.stringify({ capabilities: { tools: [] } }),
		});
		const gated = undeclaredPipelineTools(leadFinder, declaresNothing, getRegistryTool);
		expect(gated.map((u) => u.tool)).toEqual(["http_request"]);
		expect(gated[0].via).toBe("dispatch"); // reached first by `geocode`, not by the explicit step
		expect(seededTools).toEqual(expect.arrayContaining(gated.map((u) => u.tool)));
	});

	it("makes the seeded pipeline pass the kick gate", () => {
		// End to end on the seed: 0111's tools plus 0111's definition, through the real resolver and
		// the real rule. A seed that is refused at kick is not a fix.
		const caps = agentCapabilities({
			slug: "small-business-website-lead-finder",
			category: "sales",
			config: JSON.stringify({ capabilities: { tools: seededTools } }),
		});
		expect(pipelineDeclarationError(seededDef, caps, getRegistryTool)).toBeNull();
	});

	it("keeps the chat tools the declaration would otherwise strip", () => {
		// A declared list REPLACES the permissive per-surface default (`toolNamesFor`), so declaring
		// `["http_request"]` alone would have silently cost this agent the storage tools its own
		// transcript uses to answer "how many leads have no website" — it keeps answering, it just
		// goes back to estimating from KB prose.
		expect(seededTools).toEqual(expect.arrayContaining(["query_records", "list_collections", "read_knowledge", "list_knowledge"]));
	});

	it("writes only targeted paths, and guards the tools write so #444 composes", () => {
		// Never `SET config = json('…')`: another change may be declaring tools on seeded agents at
		// the same time, and a whole-column write would revert whichever landed second. The tools
		// statement is additionally guarded on there being none, so in production it is a no-op and
		// the two migrations compose in either order.
		//
		// Asked of the DDL with comments stripped, the same split `check-migrations.mjs` makes: the
		// header discusses the uuid and the absent INSERT in prose, and a guard that read prose would
		// be forcing the migration to explain itself less.
		const ddl = readFileSync(LEAD_FINDER_MIGRATION, "utf8")
			.split("\n")
			.filter((l) => !l.trimStart().startsWith("--"))
			.join("\n");
		expect(ddl).not.toMatch(/SET\s+config\s*=\s*json\('/);
		expect(ddl).toContain("json_type(COALESCE(NULLIF(config, ''), '{}'), '$.capabilities.tools') IS NULL");
		// By slug, never by the uuid: this agent is a real creator's row, not first-party seed data,
		// so there is nothing to insert on a fresh database and nothing here fabricates one.
		expect(ddl).toContain("WHERE slug = 'small-business-website-lead-finder'");
		expect(ddl).not.toContain("4d9945ab");
		expect(ddl).not.toMatch(/\bINSERT\b/i);
	});
});

// ── #394 / #496 ─────────────────────────────────────────────────────────────────
// 0111 seeded the fixed definition onto the AGENTS row, which is where a future subscriber gets it
// from. It could not reach the one Lead Finder instance that already existed: subscribe copies
// `agents.config.pipelines` once, and `loadPipeline` reads `agent_instances.config` with no
// fallback. So the 1MiB fix was live in the runner, present in the catalog, and absent from the
// only agent running it — which is #496's defect, one field over from identity.
//
// The remedy migration copies the definition FROM the agents row rather than embedding it, so
// there is deliberately no third copy to drift. What can still drift is its GATE: it names the
// eight-step shape it is willing to replace, and that shape is only meaningful as "the reference
// minus the two steps the fix added". These derive it and assert the SQL says exactly that.
const PROPAGATION_MIGRATION = readdirSync(fileURLToPath(new URL("../../../migrations", import.meta.url).href))
	.filter((f) => f.endsWith("lead_finder_pipeline_reaches_live_instances.sql"))
	.map((f) => fileURLToPath(new URL(`../../../migrations/${f}`, import.meta.url).href));

describe("the #394 propagation migration — the seed reaches the instance that already existed", () => {
	it("exists exactly once", () => {
		// Found by suffix so a renumbering (two lanes landing at once) does not need this edited;
		// two files matching would mean the migration was copied rather than renamed.
		expect(PROPAGATION_MIGRATION).toHaveLength(1);
	});

	const ddl = () =>
		readFileSync(PROPAGATION_MIGRATION[0], "utf8")
			.split("\n")
			.filter((l) => !l.trimStart().startsWith("--"))
			.join("\n");

	it("gates on the reference definition MINUS the two steps the 1MiB fix added", () => {
		// The stale copy is the reference without `slice` (the cap) and without the second `map`
		// (bind `classified`, the reshape that follows the responseMap projection). Derived from
		// lead-finder.json rather than restated, so a definition change makes the gate's premise
		// fail here instead of turning it into a clause that silently matches nothing — or, worse,
		// something else.
		const stale = leadFinder.steps.filter((s) => s.tool !== "slice" && s.bind !== "classified").map((s) => s.tool);
		expect(stale).toHaveLength(leadFinder.steps.length - 2);
		expect(ddl()).toContain(JSON.stringify(stale));
	});

	it("cannot match the FIXED definition, so it is not a re-run hazard", () => {
		// The gate is an equality on the whole step sequence, so the 10-step definition it installs
		// can never satisfy it. That is what makes the migration idempotent and what stops it
		// overwriting the archive with the value it just wrote.
		expect(ddl()).not.toContain(JSON.stringify(leadFinder.steps.map((s) => s.tool)));
	});

	it("copies from the agents row instead of embedding a third copy of the definition", () => {
		// The drift this whole file exists to prevent. A migration that restated the definition
		// would add a copy that no test compares to lead-finder.json, on top of the two that do.
		expect(ddl()).toMatch(/FROM agents a/);
		expect(ddl()).not.toContain('"steps"');
		expect(ddl()).toMatch(/UPDATE agent_instances/);
	});

	it("keeps what it replaces, since the gate matches a shape and not the bytes", () => {
		// An instance that edited an INPUT inside those eight steps matches too. Archiving the old
		// definition is what makes that acceptable: the change is reversible by hand rather than
		// destructive, and `$.pipelinesReplaced` is read by nothing.
		expect(ddl()).toContain("'$.pipelinesReplaced.lead_finder'");
	});
});

// ── #706 ────────────────────────────────────────────────────────────────────────
// The Lead Outreach agent's `draft_outreach` pipeline had the same two-copy problem as the two
// above, minus one copy: until 2026-08-18 it existed ONLY as instance data on
// `3c09069a-e866-4218-978e-569f62f4ab10`, with no reference JSON, nothing importing it, and
// `agents.config` = `{}`. So a new subscriber got an inert agent (subscribe copies
// `agents.config.pipelines`), and the definition — second link of the platform's only live
// agent-to-agent chain, 100+ runs — was one cancelled subscription from unrecoverable.
//
// The reference JSON was read back off that instance and committed; 0132 seeds it onto the agent
// row. This is what stops the two drifting, and what pins the two decisions the migration made
// deliberately rather than by default: no `capabilities.tools` statement, and no re-sync of the
// live instance.
const LEAD_OUTREACH_MIGRATION = readdirSync(fileURLToPath(new URL("../../../migrations", import.meta.url).href))
	.filter((f) => f.endsWith("seed_lead_outreach_pipeline.sql"))
	.map((f) => fileURLToPath(new URL(`../../../migrations/${f}`, import.meta.url).href));

describe("the #706 lead-outreach seed — the definition stops living only in one instance", () => {
	it("exists exactly once", () => {
		// Found by suffix so a renumbering (two lanes landing at once) does not need this edited;
		// two files matching would mean the migration was copied rather than renamed.
		expect(LEAD_OUTREACH_MIGRATION).toHaveLength(1);
	});

	const literals = jsonLiterals(LEAD_OUTREACH_MIGRATION[0]);
	const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
	const seededDef = literals.find((l) => isRecord(l) && Array.isArray(l.steps)) as Record<string, unknown> & ToolNamingSteps;

	const ddl = () =>
		readFileSync(LEAD_OUTREACH_MIGRATION[0], "utf8")
			.split("\n")
			.filter((l) => !l.trimStart().startsWith("--"))
			.join("\n");

	it("embeds the SAME definition as the reference JSON", () => {
		// The reason this file exists. Editing lead-outreach.json without re-running the seed would
		// leave every future subscriber on the old definition while lead-outreach.test.ts stayed
		// green against the file.
		expect(seededDef).toEqual(leadOutreach);
	});

	it("embeds a definition the runner will actually accept", () => {
		expect(validatePipeline(seededDef)).toBeNull();
	});

	it("is filed under `draft_outreach`, and says so in its own name field", () => {
		// The KEY is what resolves (`loadPipeline`), and production — the live instance,
		// `pipeline_runs.pipeline`, the `lead.created` connection — says `draft_outreach`. Seeding
		// under `lead-outreach` (the FILE's name, and the agent's) would have created a SECOND
		// pipeline beside the live one, which is 0111's lesson restated one agent over.
		expect(ddl()).toContain("'$.pipelines.draft_outreach'");
		expect(ddl()).not.toContain("'$.pipelines.lead-outreach'");
		// And key == name, because `defaultPipelinesFor` copies what it is given without running it
		// through `pipelineDefForKey`.
		expect(seededDef.name).toBe("draft_outreach");
	});

	it("reaches no connector tool, which is why the seed declares none", () => {
		// Asked of the REAL registry through the REAL rule, not asserted by hand. 0111 needed a
		// `capabilities.tools` statement because the lead finder reaches `http_request` from inside
		// `geocode` and `fan_out`; this definition reaches nothing gated, so there is nothing to
		// declare — and declaring a list anyway would REPLACE the permissive per-surface default
		// (`toolNamesFor`) and strip this agent's chat of the storage tools it uses today.
		//
		// It is also what "Draft-only — never sends" rests on: a step that later reaches a connector
		// makes this red, which is the moment to decide whether the storefront claim still holds.
		const declaresNothing = agentCapabilities({ slug: "lead-outreach-tj6qrr", category: "general", config: JSON.stringify({ capabilities: { tools: [] } }) });
		expect(undeclaredPipelineTools(leadOutreach, declaresNothing, getRegistryTool)).toEqual([]);
		expect(ddl()).not.toContain("$.capabilities.tools");
	});

	it("passes the kick gate for an agent that declares nothing at all", () => {
		// This agent's config is `{}`, so it resolves down the FALLBACK branch of the capability
		// resolver with no declared tool list — the state a hand-built literal never exercises. A
		// seed that is refused at kick is not a fix.
		const caps = agentCapabilities({ slug: "lead-outreach-tj6qrr", category: "general", config: "{}" });
		expect(pipelineDeclarationError(seededDef, caps, getRegistryTool)).toBeNull();
	});

	it("writes one targeted path on the agents row, by slug, and inserts nothing", () => {
		// Never `SET config = json('…')`: another lane may be writing `$.capabilities` on seeded
		// agents at the same time, and a whole-column write would revert whichever landed second.
		// By slug rather than the uuid, and no INSERT — this is a real creator's row, so there is
		// nothing to seed on a fresh database and nothing here fabricates one.
		expect(ddl()).not.toMatch(/SET\s+config\s*=\s*json\('/);
		expect(ddl()).toContain("WHERE slug = 'lead-outreach-tj6qrr'");
		expect(ddl()).not.toContain("bf1de46a");
		expect(ddl()).not.toMatch(/\bINSERT\b/i);
	});

	it("reaches an existing instance by FILLING an absent copy, never by overwriting one", () => {
		// #496: `$.pipelines` is copied at subscribe and never re-read, so the agents-row statement
		// alone reaches nobody already running the agent. The second statement is the route — but
		// unlike 0130 it must not overwrite, and the reason is structural rather than cautious: the
		// reference JSON was DERIVED FROM the live instance, so that instance already holds byte for
		// byte what this seeds. Overwriting could only discard tuning made between this commit and
		// the deploy, in exchange for writing back a copy of the instance's own value.
		//
		// Recorded as an assertion rather than a sentence in a comment, because "gated deliberately"
		// and "forgot the gate" are indistinguishable in a diff — and an ungated version of this
		// statement would pass every other check in this file.
		const sql = ddl();
		expect(sql).toMatch(/UPDATE\s+agent_instances/);
		expect(sql).toContain("'$.pipelines.draft_outreach') IS NULL");
		// Copied FROM the agents row, so there is no third copy of the definition to drift (0130's
		// principle) — and the instance statement carries no literal of its own.
		expect(sql).toMatch(/FROM agents a/);
		expect(sql.match(/json\('/g) ?? []).toHaveLength(1);
	});
});
