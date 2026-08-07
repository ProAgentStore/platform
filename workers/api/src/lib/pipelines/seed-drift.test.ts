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
import { validatePipeline } from "../pipeline.js";
import { agentCapabilities } from "../agent-capabilities.js";
import { pipelineDeclarationError } from "../pipeline-tool-policy.js";
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
		// Asked of the real registry, so a step swapped for a different connector tool fails here
		// rather than at 3am on someone's cron.
		const gated = [...new Set([...siteBuilder.steps, ...siteDeploy.steps].map((s) => s.tool))].filter((t) => !!getRegistryTool(t)?.connector);
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
