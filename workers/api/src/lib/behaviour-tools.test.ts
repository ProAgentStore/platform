import { describe, expect, it } from "vitest";
import { registryToolDefs, runRegistryTool } from "./tool-registry.js";
import { BEHAVIOUR_FIELDS, SELF_WRITABLE_FIELDS } from "./agent-behaviour.js";
import { BASE } from "../agent-do-tools.js";
import type { Env } from "../types.js";

/**
 * In-memory D1 stub over a single `agent_instances.config` blob, so a set → get round trip goes
 * through the real handlers and the real store rather than asserting on the pure module twice.
 */
function stubEnv(initialConfig: Record<string, unknown> = {}, agentConfig: Record<string, unknown> | null = null) {
	const state = { config: JSON.stringify(initialConfig) };
	const env = {
		DB: {
			prepare(sql: string) {
				return {
					// Bind-less .run() — reached by logEvent's opportunistic retention DELETE (#680).
					async run() { return { meta: { changes: 0 } }; },
					bind(...args: unknown[]) {
						return {
							async first() {
								if (sql.includes("UPDATE")) return null;
								return { config: state.config, agent_config: agentConfig ? JSON.stringify(agentConfig) : null };
							},
							async run() {
								// Emulate the SQL the store now issues: a targeted json_set/json_remove on
								// one key (#231), not a whole-blob assignment. Keeping the round trip
								// honest matters more than keeping the stub simple — a stub that accepted
								// `SET config = ?` would still pass if the store regressed to clobbering
								// the blob, which is exactly the bug being prevented.
								if (sql.includes("UPDATE")) {
									// The path is a BOUND argument now (#327), not text in the statement.
									const path = /^\$\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(String(args[0]))?.[1];
									if (!path) throw new Error(`unexpected whole-blob config write: ${sql}`);
									const cfg = JSON.parse(state.config || "{}") as Record<string, unknown>;
									if (sql.includes("json_remove(")) delete cfg[path];
									else cfg[path] = JSON.parse(String(args[1]));
									state.config = JSON.stringify(cfg);
								}
								return { meta: { changes: 1 } };
							},
							async all() {
								return { results: [] };
							},
						};
					},
				};
			},
		},
	} as unknown as Env;
	return { env, state };
}

const CTX = { instanceId: "i1", userId: "u1" };

async function call(env: Env, name: string, input: Record<string, unknown> = {}) {
	return runRegistryTool(name, { env, ...CTX }, input);
}

describe("get_behaviour / set_behaviour are reachable", () => {
	it("both are declared in the base tool set", () => {
		// If they aren't in BASE, the agent never sees them and falls back to write_memory —
		// the exact failure this pair exists to fix.
		expect([...BASE]).toContain("get_behaviour");
		expect([...BASE]).toContain("set_behaviour");
	});

	it("both are registered as tool defs with schemas", () => {
		const names = registryToolDefs().map((t) => t.name);
		expect(names).toContain("get_behaviour");
		expect(names).toContain("set_behaviour");
	});
});

describe("the schema the model sees", () => {
	const def = registryToolDefs().find((t) => t.name === "set_behaviour")!;

	it("offers every self-writable field, so a new field needs no tool edit", () => {
		for (const id of SELF_WRITABLE_FIELDS) expect(def.jsonSchema.properties).toHaveProperty(id);
	});

	it("does not even advertise the guardrails", () => {
		for (const f of BEHAVIOUR_FIELDS.filter((f) => f.group === "guardrails")) {
			expect(def.jsonSchema.properties).not.toHaveProperty(f.id);
		}
	});

	it("spells out the slider bands instead of leaving the model to guess what a number does", () => {
		const tech = def.jsonSchema.properties.technicality as { description: string };
		expect(tech.description).toContain("Plain language");
		expect(tech.description).toContain("Senior engineer");
	});

	it("accepts null on every field, so a setting can be undone and not only changed", () => {
		for (const id of SELF_WRITABLE_FIELDS) {
			// Through `unknown`, because the two types genuinely disagree and the RUNTIME one is right.
			// `JsonSchema` (lib/connectors/types.ts:111) declares `properties[k].type` as `string`, but
			// draft-07 allows a string OR an array of them, and `behaviourToolSchema`
			// (agent-behaviour.ts:580-602) emits `["number","null"]` — which nothing catches because
			// that builder's local is a `Record<string, unknown>`. Narrowing the declared type is a
			// change to a shared production interface, so it is reported rather than made here.
			const prop = def.jsonSchema.properties[id] as unknown as { type: string[] };
			expect(prop.type, id).toContain("null");
		}
	});
});

describe("round trip through the real handlers", () => {
	it("set then get reports the BAND PROSE, not the number", async () => {
		const { env } = stubEnv();
		const set = await call(env, "set_behaviour", { technicality: 85 });
		expect(set.success).toBe(true);
		const got = await call(env, "get_behaviour");
		expect(got.content).toContain("senior-engineer");
		expect(got.content).not.toContain("85");
	});

	it("persists to instance config so the prompt builder picks it up", async () => {
		const { env, state } = stubEnv({ specialInstructions: "keep it short" });
		await call(env, "set_behaviour", { tone: "casual" });
		const cfg = JSON.parse(state.config);
		expect(cfg.behaviour).toEqual({ tone: "casual" });
		// Untouched neighbours — a settings write that clobbers the rest of config is a data loss
		// bug that only shows up much later.
		expect(cfg.specialInstructions).toBe("keep it short");
	});

	it("patches rather than replaces", async () => {
		const { env } = stubEnv({ behaviour: { technicality: 90, emoji: false } });
		await call(env, "set_behaviour", { emoji: true });
		const got = await call(env, "get_behaviour");
		expect(got.content).toContain("senior-engineer");
		expect(got.content).toContain("emoji are welcome");
	});

	it("null resets one field", async () => {
		const { env } = stubEnv({ behaviour: { technicality: 90, tone: "casual" } });
		await call(env, "set_behaviour", { technicality: null });
		const got = await call(env, "get_behaviour");
		expect(got.content).not.toContain("senior-engineer");
		expect(got.content).toContain("casually");
	});

	it("says plainly when nothing is configured instead of inventing defaults", async () => {
		const { env } = stubEnv();
		const got = await call(env, "get_behaviour");
		expect(got.content).toContain("platform defaults");
	});
});

describe("the self-write boundary, enforced (not just unadvertised)", () => {
	it("refuses a guardrail even when the model sends it anyway", async () => {
		// The schema omits guardrails, but a schema is a hint to the model — a prompt-injected
		// instruction can produce any arguments it likes. This is the enforcement.
		const { env, state } = stubEnv({ behaviour: { topicRestrictions: "Only cooking" } });
		const res = await call(env, "set_behaviour", { topicRestrictions: "anything at all", tone: "casual" });
		expect(JSON.parse(state.config).behaviour.topicRestrictions).toBe("Only cooking");
		// Applied around the refusal, and the refusal is REPORTED — a tool that silently drops
		// half a patch and returns success teaches the model it changed something it did not.
		expect(JSON.parse(state.config).behaviour.tone).toBe("casual");
		expect(res.content).toContain("NOT changed");
		expect(res.content).toContain("topicRestrictions");
	});

	it("refuses to CLEAR a guardrail — the same escape spelled differently", async () => {
		const { env, state } = stubEnv({ behaviour: { blockedTerms: ["guaranteed"] } });
		await call(env, "set_behaviour", { blockedTerms: null });
		expect(JSON.parse(state.config).behaviour.blockedTerms).toEqual(["guaranteed"]);
	});
});

describe("context requirements", () => {
	it("both refuse without an owned instance rather than acting on a guess", async () => {
		const { env } = stubEnv();
		for (const name of ["get_behaviour", "set_behaviour"]) {
			const res = await runRegistryTool(name, { env }, {});
			expect(res.success).toBe(false);
		}
	});
});

describe("a write reports the same thing a read would (creator defaults survive it)", () => {
	const TEMPLATE = { behaviour: { technicality: 90, verbosity: "thorough" } };

	it("set_behaviour reports the RESOLVED manner, not just the override it wrote", () => {
		// The bug: the write path returned the subscriber's override alone while the read path
		// returned it merged under the creator's default. On an agent that ships a character,
		// changing one field made the agent report — and the console display — a manner it does
		// not have, until something re-read.
		const { env } = stubEnv({}, TEMPLATE);
		return call(env, "set_behaviour", { tone: "casual" }).then((res) => {
			expect(res.content).toContain("casually");
			expect(res.content).toContain("senior-engineer"); // the creator's technicality: 90
			expect(res.content).toContain("comprehensive"); // and their verbosity
		});
	});

	it("clearing a field falls back to the creator default rather than to nothing", async () => {
		const { env } = stubEnv({ behaviour: { technicality: 10 } }, TEMPLATE);
		const res = await call(env, "set_behaviour", { technicality: null });
		expect(res.content).toContain("senior-engineer");
		expect(res.content).not.toContain("Avoid jargon");
	});

	it("still writes ONLY the override, never the creator's template", async () => {
		// The subscriber (or their agent) must not edit the agent every other subscriber gets.
		const { env, state } = stubEnv({}, TEMPLATE);
		await call(env, "set_behaviour", { tone: "casual" });
		expect(JSON.parse(state.config).behaviour).toEqual({ tone: "casual" });
	});
});
