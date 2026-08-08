// The site-builder agent seed (migration 0057) embeds its two pipeline definitions in
// `agents.config.pipelines`, because subscribe copies them into each new instance — that's
// what makes a pipeline-only agent work the moment you subscribe. The definitions therefore
// exist in two places: the reference JSON here, and the SQL.
//
// This test is the thing that stops them drifting. Without it, editing site-builder.json
// would leave every NEW subscriber on the old definition while site-builder.test.ts stayed
// green against the file — the worst kind of drift, invisible and only reproducible in prod.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import siteBuilder from "./site-builder.json" with { type: "json" };
import siteDeploy from "./site-deploy.json" with { type: "json" };
import leadFinder from "./lead-finder.json" with { type: "json" };
import { declaredParamDefaults, validatePipeline } from "../pipeline.js";
import { agentCapabilities } from "../agent-capabilities.js";
import { pipelineDeclarationError, undeclaredPipelineTools } from "../pipeline-tool-policy.js";
import { getRegistryTool } from "../tool-registry.js";

const MIGRATION = fileURLToPath(new URL("../../../migrations/0057_seed_site_builder_agent.sql", import.meta.url));

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
const TOOLS_MIGRATION = fileURLToPath(new URL("../../../migrations/0096_site_builder_declared_tools.sql", import.meta.url));

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
const LEAD_FINDER_MIGRATION = fileURLToPath(new URL("../../../migrations/0111_seed_lead_finder_pipeline.sql", import.meta.url));

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
	const seededDef = literals.find((l) => isRecord(l) && Array.isArray(l.steps)) as Record<string, unknown>;
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
