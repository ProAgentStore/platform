import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { realSchemaD1 } from "../d1-sqlite.js";
import leadOutreach from "./lead-outreach.json" with { type: "json" };

/**
 * Migration `0132_seed_lead_outreach_pipeline.sql`, EXECUTED (#706).
 *
 * `seed-drift.test.ts` reads this migration as text — that the definition it embeds equals the
 * reference JSON, that it is filed under the right key, that the instance statement carries the
 * absent-only gate. All of that is true of a migration that does not run, or that runs and writes
 * `null`, and neither is a shape a string check can see.
 *
 * So this one applies it to the REAL schema (every migration on node:sqlite) and asserts on rows.
 * The claim under test is the one the ticket had to decide explicitly: the seed reaches a NEW
 * subscriber through the agents row, and it reaches an EXISTING instance only where that instance
 * has no copy at all — because the definition in this repository was read back OFF the one live
 * instance, so overwriting it could only discard the subscriber's own tuning in exchange for a copy
 * of their own value (#496 is the reason a route has to exist; that is the reason it must not be an
 * overwrite).
 */
const MIGRATION = readFileSync(join(import.meta.dirname, "../../../migrations/0132_seed_lead_outreach_pipeline.sql"), "utf-8");

const SLUG = "lead-outreach-tj6qrr";
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The real schema, plus an owner. 0132 has already run here against an empty `agents`. */
function db(agentConfig: string | null, instances: Array<{ id: string; config: string }> = []) {
	const d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	if (agentConfig !== null) {
		d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('ag1', 'u1', ${q(SLUG)}, 'Lead Outreach', ${q(agentConfig)})`);
	}
	for (const i of instances) {
		d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, config) VALUES (${q(i.id)}, 'ag1', 'u1', ${q(i.config)})`);
	}
	return d1;
}

const agentConfig = (d1: ReturnType<typeof realSchemaD1>) => JSON.parse((d1.sqlite.prepare("SELECT config FROM agents WHERE slug = ?").get(SLUG) as { config: string }).config) as Record<string, Record<string, unknown>>;
const instanceConfig = (d1: ReturnType<typeof realSchemaD1>, id: string) => JSON.parse((d1.sqlite.prepare("SELECT config FROM agent_instances WHERE id = ?").get(id) as { config: string }).config) as Record<string, Record<string, unknown>>;

describe("0132 — the lead-outreach seed, run against the real schema (#706)", () => {
	it("puts the reference definition on the agents row, which is what a NEW subscriber copies", () => {
		// The production shape: `agents.config` was `{}` — one of only two published agents with an
		// empty config — so subscribe (`defaultPipelinesFor`) had nothing to copy and handed out an
		// inert agent while the storefront sold "drafts personalized cold-outreach".
		const d1 = db("{}");
		d1.exec(MIGRATION);
		expect(agentConfig(d1).pipelines.draft_outreach).toEqual(leadOutreach);
		d1.close();
	});

	it("leaves an instance that ALREADY has the pipeline completely alone, tuning included", () => {
		// The live instance `3c09069a` is the source this definition was recovered from. A
		// propagation statement of 0130's shape would overwrite a working, 100-run-old
		// configuration with a value copied out of it — and take any edit made between this commit
		// and the deploy with it. The extra param here stands for exactly that edit.
		const tuned = { ...leadOutreach, params: { ...leadOutreach.params, tuned_by_owner: { type: "string" } } };
		const before = JSON.stringify({ pipelines: { draft_outreach: tuned }, name: "Lead Outreach" });
		const d1 = db("{}", [{ id: "live", config: before }]);
		d1.exec(MIGRATION);
		expect(instanceConfig(d1, "live")).toEqual(JSON.parse(before));
		d1.close();
	});

	it("FILLS an instance that has no copy — the case a seed on the agents row cannot reach", () => {
		// #496: `$.pipelines` is copied at subscribe and never re-read. An instance created while the
		// agent row was still `{}`, or one whose copy went missing, runs inert forever otherwise.
		const d1 = db("{}", [{ id: "empty", config: JSON.stringify({ name: "Outreach 2" }) }]);
		d1.exec(MIGRATION);
		const cfg = instanceConfig(d1, "empty");
		expect(cfg.pipelines.draft_outreach).toEqual(leadOutreach);
		// A targeted json_set, so everything else on the instance survives.
		expect(cfg.name).toBe("Outreach 2");
		d1.close();
	});

	it("never touches another agent's instances", () => {
		const d1 = db("{}");
		d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('ag2', 'u1', 'some-other-agent', 'Other', '{}')`);
		d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, config) VALUES ('other', 'ag2', 'u1', '{}')`);
		d1.exec(MIGRATION);
		expect((d1.sqlite.prepare("SELECT config FROM agent_instances WHERE id = 'other'").get() as { config: string }).config).toBe("{}");
		d1.close();
	});

	it("is idempotent, and preserves config the agent row already carried", () => {
		// Targeted `json_set`, never `SET config = json('…')`: another lane may be writing
		// `$.capabilities` on seeded agents at the same time, and a whole-column write would revert
		// whichever landed second.
		const d1 = db(JSON.stringify({ capabilities: { tools: ["query_records"] } }), [{ id: "empty", config: "{}" }]);
		d1.exec(MIGRATION);
		const once = { agent: agentConfig(d1), instance: instanceConfig(d1, "empty") };
		d1.exec(MIGRATION);
		expect({ agent: agentConfig(d1), instance: instanceConfig(d1, "empty") }).toEqual(once);
		expect(once.agent.capabilities).toEqual({ tools: ["query_records"] });
		d1.close();
	});

	it("is a clean no-op on a fresh database, where the agent does not exist", () => {
		// This is a real creator's row, not first-party seed data, so there is nothing to insert on a
		// fresh DB and nothing here fabricates one. Also the exact state `realSchemaD1()` applies the
		// migration in, which is why it must not throw or write.
		const d1 = db(null, []);
		// The fresh schema is not empty — earlier migrations seed the first-party agents — so the
		// claim is that NONE of them acquires this pipeline, not that the table is bare. A statement
		// whose WHERE clause stopped discriminating would land on all of them.
		expect((d1.sqlite.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n).toBeGreaterThan(0);
		d1.exec(MIGRATION);
		expect((d1.sqlite.prepare("SELECT COUNT(*) AS n FROM agents WHERE slug = ?").get(SLUG) as { n: number }).n).toBe(0);
		expect((d1.sqlite.prepare("SELECT COUNT(*) AS n FROM agents WHERE json_extract(config, '$.pipelines.draft_outreach') IS NOT NULL").get() as { n: number }).n).toBe(0);
		d1.close();
	});

	it("cannot write a null over the key when the agents row has no definition to copy", () => {
		// The instance statement copies FROM the agents row rather than embedding a third copy, so it
		// is only correct where the first statement applied. The one state where it did not is an
		// agents row whose `config` is not valid JSON: statement 1 skips it (`json_valid`), and
		// statement 2 would then read `{}`, extract nothing, and `json_set` a literal NULL onto the
		// instance — turning "no pipeline" into "a pipeline that is null", which fails much later and
		// much less legibly. The `= 'object'` guard on the source is what makes that impossible, and
		// this is the only scenario that reaches it.
		const d1 = db(null, []);
		d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('ag1', 'u1', ${q(SLUG)}, 'Lead Outreach', 'not json')`);
		d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, config) VALUES ('orphan', 'ag1', 'u1', '{}')`);
		d1.exec(MIGRATION);
		expect((d1.sqlite.prepare("SELECT config FROM agent_instances WHERE id = 'orphan'").get() as { config: string }).config).toBe("{}");
		d1.close();
	});
});
