/**
 * #1199 — a pinned model id is checked against the machine's own model list before it is saved.
 *
 * Acceptance, from the issue: setting `grok-4` on a Grok instance is refused with the valid list; `grok-4.7` is
 * accepted. The list is the one `grok models` printed on a real machine (xAI Grok CLI 1.0.62, 2026-10-19). Driven
 * through `writeEngineChoice` — what `coding_engine_set` calls — over the real schema; only the relay is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getBoundRunnerConn, callRunner } = vi.hoisted(() => ({ getBoundRunnerConn: vi.fn(), callRunner: vi.fn() }));
vi.mock("./runner-client.js", async (orig) => ({ ...(await orig<typeof import("./runner-client.js")>()), getBoundRunnerConn, callRunner }));

import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { readEngines } from "./coding-engines.js";
import { writeEngineChoice } from "./coding-engine-choice.js";
import { checkEngineModel, clearEngineModelCache, ENGINE_MODELS_TTL_MS, type ModelListDeps } from "./engine-model-check.js";
import type { Env } from "../types.js";

/** `grok models` on a real machine. */
const GROK_MODELS = ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"];

let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["inst-1"] });
	env = { DB: d1.DB } as unknown as Env;
	clearEngineModelCache();
	getBoundRunnerConn.mockReset().mockResolvedValue({ runnerNode: "Sergeys-Mac-mini.local", instanceId: "inst-1" });
	callRunner.mockReset().mockImplementation(async (_conn: unknown, path: string) => {
		if (path !== "/coding/engine-models") throw new Error(`unexpected ${path}`);
		return { clientType: "grok", models: GROK_MODELS, defaultModel: "grok-4.7" };
	});
});
afterEach(() => d1.close());

const grokCommand = async () => (await readEngines(env, "inst-1", "u1")).engines.find((e) => e.id === "grok")?.command ?? "";

describe("coding_engine_set checks a Grok model against the machine's live list (#1199 acceptance)", () => {
	it("`grok-4` is REFUSED, the answer naming the models the machine offers — and nothing is saved", async () => {
		const before = await grokCommand();
		const err = await writeEngineChoice(env, "inst-1", "u1", { engineId: "grok", model: "grok-4" }).then(() => null, (e) => e as Error & { status?: number });
		expect(err?.status).toBe(400);
		expect(err?.message).toContain('"grok-4" is not a model');
		for (const m of GROK_MODELS) expect(err?.message).toContain(m);
		expect(await grokCommand()).toBe(before);
		expect(callRunner).toHaveBeenCalledWith(expect.anything(), "/coding/engine-models", expect.objectContaining({ clientType: "grok" }), expect.anything());
	});

	it("`grok-4.7` is ACCEPTED, pinned in the command that launches, and said to have been checked", async () => {
		const view = await writeEngineChoice(env, "inst-1", "u1", { engineId: "grok", model: "grok-4.7" });
		expect(view.modelCheck).toEqual({ validated: true });
		expect(await grokCommand()).toContain("grok-4.7");
	});

	it("clearing the pin (null) asks nothing — handing the choice back to the CLI cannot name a wrong model", async () => {
		await writeEngineChoice(env, "inst-1", "u1", { engineId: "grok", model: null });
		expect(callRunner).not.toHaveBeenCalled();
	});
});

describe("checkEngineModel — when the list cannot be had, it says so instead of guessing (#1199)", () => {
	const GROK = { clientType: "grok", command: "grok --permission-mode bypassPermissions -p", label: "Grok" };
	const deps = (over: Partial<ModelListDeps> = {}): ModelListDeps & { asked: number } => {
		const d = { asked: 0, now: () => 1_000, ask: async () => ({ node: "mac", models: GROK_MODELS }) , ...over } as ModelListDeps & { asked: number };
		const ask = d.ask;
		d.ask = async (b) => {
			d.asked++;
			return ask(b);
		};
		return d;
	};

	it("an engine whose CLI lists no models is saved unchecked — and the machine is not even asked", async () => {
		const d = deps();
		expect(await checkEngineModel(env, "inst-1", "u1", { clientType: "claude", command: "claude", label: "Claude" }, "opus", d)).toMatchObject({ validated: false, reason: expect.stringMatching(/publishes no model list/) });
		expect(d.asked).toBe(0);
	});

	it("no runner connected, an old runner (404), or a CLI that listed nothing: unchecked, with the reason", async () => {
		expect(await checkEngineModel(env, "inst-1", "u1", GROK, "grok-4", deps({ ask: async () => null }))).toMatchObject({ validated: false, reason: expect.stringMatching(/no runner is connected/) });
		expect(await checkEngineModel(env, "inst-1", "u1", GROK, "grok-4", deps({ ask: async () => Promise.reject(new Error('Runner /coding/engine-models → 404: {"error":"Not found"}')) }))).toMatchObject({ validated: false, reason: expect.stringMatching(/CLI 0\.4\.161 or newer/) });
		expect(await checkEngineModel(env, "inst-1", "u1", GROK, "grok-4", deps({ ask: async () => ({ node: "mac", models: null, reason: "`grok models` gave no model list (is the CLI signed in?)" }) }))).toMatchObject({ validated: false, reason: expect.stringMatching(/signed in/) });
	});

	it("caches a machine's list for its TTL, then asks again", async () => {
		let t = 1_000;
		const d = deps({ now: () => t });
		await checkEngineModel(env, "inst-1", "u1", GROK, "grok-4.7", d);
		await checkEngineModel(env, "inst-1", "u1", GROK, "grok-4.6", d);
		expect(d.asked).toBe(1);
		t += ENGINE_MODELS_TTL_MS + 1;
		await checkEngineModel(env, "inst-1", "u1", GROK, "grok-4.5", d);
		expect(d.asked).toBe(2);
	});

	it("a failed listing is not cached — the next save asks again", async () => {
		let calls = 0;
		const d = deps({ ask: async () => (++calls === 1 ? { node: "mac", models: null, reason: "not signed in" } : { node: "mac", models: GROK_MODELS }) });
		expect((await checkEngineModel(env, "inst-1", "u1", GROK, "grok-4.7", d)).validated).toBe(false);
		expect((await checkEngineModel(env, "inst-1", "u1", GROK, "grok-4.7", d)).validated).toBe(true);
	});
});
