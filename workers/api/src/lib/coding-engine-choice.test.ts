/**
 * The engine + model choice writes the SAME state the CLI engines panel owns (#792).
 *
 * Driven against the real migrated schema, because the claim under test is about what ends up in
 * `agent_instances.config` and what `resolveEngine` — the thing that actually launches — then does
 * with it. Migration 0126 deleted the last "engine" dropdown for being read by nothing; the tests
 * that matter here are the ones that go through the launcher's own resolver.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { DEFAULT_ENGINES, readEngines, resolveEngine } from "./coding-engines.js";
import { ENGINE_CHOICE_APPLIES_TO, readEngineChoice, writeEngineChoice } from "./coding-engine-choice.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["inst-1"] });
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

async function storedConfig(): Promise<Record<string, unknown>> {
	const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = 'inst-1'").first<{ config: string }>();
	return JSON.parse(row?.config || "{}");
}

describe("reading the choice", () => {
	it("an instance that has saved nothing shows the shipped engines, Claude chosen, no model pinned", async () => {
		const view = await readEngineChoice(env, "inst-1", "u1");
		expect(view.defaultEngineId).toBe("claude");
		expect(view.engines.map((e) => e.id)).toEqual(DEFAULT_ENGINES.map((e) => e.id));
		expect(view.engines.every((e) => e.model === null)).toBe(true);
		expect(view.appliesTo).toBe(ENGINE_CHOICE_APPLIES_TO);
	});

	it("says which engines take a model, and offers aliases only where the CLI documents them", async () => {
		const byId = Object.fromEntries((await readEngineChoice(env, "inst-1", "u1")).engines.map((e) => [e.id, e]));
		expect(byId.claude.modelSelectable).toBe(true);
		expect(byId.claude.suggestions.map((s) => s.value)).toEqual(["fable", "opus", "sonnet"]);
		expect(byId.codex.modelSelectable).toBe(true);
		expect(byId.codex.suggestions).toEqual([]);
		expect(byId.local.modelSelectable).toBe(false);
	});

	it("reports the model the last MEASURED engine turn ran — and ignores the Pilot's own rows", async () => {
		expect((await readEngineChoice(env, "inst-1", "u1")).lastObserved).toBeNull();
		d1.exec(`INSERT INTO ai_usage (id, user_id, instance_id, provider, model, kind, created_at) VALUES
			('engine:sess-1:r1', 'u1', 'inst-1', 'anthropic', 'claude-fable-5-1', 'coding', '2026-09-19 10:00:00'),
			('plain-row',        'u1', 'inst-1', 'anthropic', 'claude-sonnet-4-6', 'coding', '2026-09-19 11:00:00'),
			('engine:sess-9:r1', 'u2', 'inst-1', 'anthropic', 'someone-elses',     'coding', '2026-09-19 12:00:00')`);
		expect((await readEngineChoice(env, "inst-1", "u1")).lastObserved).toEqual({ model: "claude-fable-5-1", at: "2026-09-19 10:00:00" });
	});
});

describe("choosing an engine", () => {
	it("is what the LAUNCHER then resolves — the dropdown is not a second opinion (migration 0126)", async () => {
		await writeEngineChoice(env, "inst-1", "u1", { engineId: "codex" });
		expect((await resolveEngine(env, "inst-1", "u1", undefined)).clientType).toBe("codex");
		expect((await storedConfig()).defaultEngineId).toBe("codex");
	});

	it("without a `model` key, leaves every command alone — and does not materialise the defaults", async () => {
		await writeEngineChoice(env, "inst-1", "u1", { engineId: "grok" });
		expect((await storedConfig()).codingEngines).toBeUndefined();
	});

	it("REFUSES an engine this agent does not have, naming the ones it does", async () => {
		await expect(writeEngineChoice(env, "inst-1", "u1", { engineId: "cursor" })).rejects.toThrow(/No engine "cursor".*claude, codex, gemini, grok, local/);
		await expect(writeEngineChoice(env, "inst-1", "u1", {})).rejects.toThrow(/No engine/);
		expect((await storedConfig()).defaultEngineId).toBeUndefined();
	});
});

describe("choosing a model", () => {
	it("pins it IN the preset's command, which is what launches", async () => {
		const view = await writeEngineChoice(env, "inst-1", "u1", { engineId: "claude", model: "sonnet" });
		expect(view.engines.find((e) => e.id === "claude")?.model).toBe("sonnet");
		expect((await resolveEngine(env, "inst-1", "u1", undefined)).command).toBe("claude --model sonnet --dangerously-skip-permissions");
	});

	it("keeps every other preset, and its sign-in, when it first writes the list", async () => {
		await writeEngineChoice(env, "inst-1", "u1", { engineId: "claude", model: "opus" });
		const { engines } = await readEngines(env, "inst-1", "u1");
		expect(engines.map((e) => e.id)).toEqual(DEFAULT_ENGINES.map((e) => e.id));
		expect(engines.find((e) => e.id === "gemini")?.auth).toBe("api-key");
	});

	it("`null` hands the choice back to the CLI; a second choice replaces the first", async () => {
		await writeEngineChoice(env, "inst-1", "u1", { engineId: "claude", model: "opus" });
		await writeEngineChoice(env, "inst-1", "u1", { engineId: "claude", model: "sonnet" });
		expect((await resolveEngine(env, "inst-1", "u1", "claude")).command).toBe("claude --model sonnet --dangerously-skip-permissions");
		await writeEngineChoice(env, "inst-1", "u1", { engineId: "claude", model: null });
		expect((await resolveEngine(env, "inst-1", "u1", "claude")).command).toBe("claude --dangerously-skip-permissions");
	});

	it("switching engine does NOT strip a model the owner pinned on another one", async () => {
		await writeEngineChoice(env, "inst-1", "u1", { engineId: "claude", model: "opus" });
		await writeEngineChoice(env, "inst-1", "u1", { engineId: "codex" });
		await writeEngineChoice(env, "inst-1", "u1", { engineId: "claude" });
		expect((await readEngineChoice(env, "inst-1", "u1")).engines.find((e) => e.id === "claude")?.model).toBe("opus");
	});

	it("refuses an id that is not one, and a pin on an engine with no model flag — writing nothing", async () => {
		await expect(writeEngineChoice(env, "inst-1", "u1", { engineId: "claude", model: "two words" })).rejects.toThrow(/not a model id/);
		await expect(writeEngineChoice(env, "inst-1", "u1", { engineId: "local", model: "llama4" })).rejects.toThrow(/no model flag/);
		expect(await storedConfig()).toEqual({});
	});

	it("clearing the model on an engine that never had a flag is just choosing that engine", async () => {
		const view = await writeEngineChoice(env, "inst-1", "u1", { engineId: "local", model: null });
		expect(view.defaultEngineId).toBe("local");
	});

	it("is scoped to the owner — another user's write changes nothing", async () => {
		await writeEngineChoice(env, "inst-1", "someone-else", { engineId: "codex", model: "gpt-x" }).catch(() => undefined);
		expect(await storedConfig()).toEqual({});
	});
});
