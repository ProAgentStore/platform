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
import { readEngineChoice, writeEngineChoice } from "./coding-engine-choice.js";
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

	it("clearing the pin (null) is not checked — handing the choice back to the CLI cannot name a wrong model", async () => {
		callRunner.mockRejectedValue(new Error("the machine is unreachable"));
		const view = await writeEngineChoice(env, "inst-1", "u1", { engineId: "grok", model: null });
		expect(view.modelCheck).toBeUndefined();
		expect(view.engines.find((e) => e.id === "grok")?.model).toBeNull();
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

	it("an engine the platform cannot list for (a custom wrapper) is saved unchecked — and the machine is not even asked", async () => {
		const d = deps();
		expect(await checkEngineModel(env, "inst-1", "u1", { clientType: "generic", command: "my-wrapper.sh", label: "Wrapper" }, "x", d)).toMatchObject({ validated: false, reason: expect.stringMatching(/publishes no model list/) });
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

describe("coding_engine_get's suggestions come from the machine's live list (#1202 acceptance)", () => {
	it("Grok's suggestions are the models its CLI lists right now — grok-4.7 included, marked as the CLI's default", async () => {
		const view = await readEngineChoice(env, "inst-1", "u1");
		const grok = view.engines.find((e) => e.id === "grok");
		expect(grok?.suggestionsFrom).toBe("machine");
		expect(grok?.suggestions.map((s) => s.value)).toEqual(GROK_MODELS);
		expect(grok?.suggestions[0]).toEqual({ value: "grok-4.7", label: "grok-4.7 (the CLI's default)" });
	});

	it("the other engines say where theirs come from: Claude its documented aliases, Codex none — it lists no models", async () => {
		const byId = Object.fromEntries((await readEngineChoice(env, "inst-1", "u1")).engines.map((e) => [e.id, e]));
		expect(byId.claude).toMatchObject({ suggestionsFrom: "documented" });
		expect(byId.claude.suggestions.map((s) => s.value)).toEqual(["fable", "opus", "sonnet"]);
		expect(byId.codex).toMatchObject({ suggestionsFrom: null, suggestions: [] });
	});

	it("the dropdown offers only what a save accepts: one list, one cache — the machine is asked once for both", async () => {
		await readEngineChoice(env, "inst-1", "u1");
		await writeEngineChoice(env, "inst-1", "u1", { engineId: "grok", model: "grok-4.6" });
		expect(callRunner.mock.calls.filter((c) => c[1] === "/coding/engine-models")).toHaveLength(1);
	});

	it("no runner connected: the view still loads, with no live suggestions rather than an error", async () => {
		getBoundRunnerConn.mockResolvedValue(null);
		const grok = (await readEngineChoice(env, "inst-1", "u1")).engines.find((e) => e.id === "grok");
		expect(grok).toMatchObject({ suggestions: [], suggestionsFrom: null });
	});
});

describe("Claude Code, Codex and Gemini ids are checked against the provider's list when the machine can read it (#1206)", () => {
	const ENGINE = (clientType: string, label: string) => ({ clientType, command: clientType, label });
	const answering = (models: string[] | null, reason?: string): ModelListDeps => ({ now: () => 1_000, ask: async () => ({ node: "mac", models, ...(reason ? { reason } : {}) }) });

	it("a typo'd Claude id is refused naming the real ones; a real id and every Claude alias pass", async () => {
		const d = answering(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
		const claude = ENGINE("claude", "Claude Code");
		const err = await checkEngineModel(env, "inst-1", "u1", claude, "claude-opus-5", d).then(() => null, (e) => e as Error & { status?: number });
		expect(err?.status).toBe(400);
		expect(err?.message).toContain("claude-sonnet-5-5");
		expect(await checkEngineModel(env, "inst-1", "u1", claude, "claude-opus-5-5", d)).toEqual({ validated: true });
		for (const alias of ["opus", "sonnet", "haiku", "fable", "opusplan", "sonnet[1m]"]) expect(await checkEngineModel(env, "inst-1", "u1", claude, alias, d)).toEqual({ validated: true });
	});

	it("Codex and Gemini ids are checked the same way", async () => {
		const codex = ENGINE("codex", "Codex");
		await expect(checkEngineModel(env, "inst-1", "u1", codex, "gpt-9", answering(["gpt-5", "gpt-5-codex"]))).rejects.toMatchObject({ status: 400 });
		expect(await checkEngineModel(env, "inst-1", "u1", codex, "gpt-5-codex", answering(["gpt-5", "gpt-5-codex"]))).toEqual({ validated: true });
		await expect(checkEngineModel(env, "inst-1", "u1", ENGINE("gemini", "Gemini"), "gemini-9", answering(["gemini-2.5-pro"]))).rejects.toMatchObject({ status: 400 });
	});

	it("no API key on the machine (a subscription login): saved unchecked, the reason says why", async () => {
		const reason = "the claude CLI publishes no model list, and no ANTHROPIC_API_KEY is set on this machine to ask the provider";
		const out = await checkEngineModel(env, "inst-1", "u1", ENGINE("claude", "Claude Code"), "claude-typo", answering(null, reason));
		expect(out).toEqual({ validated: false, reason: `${reason}, so the id was saved unchecked` });
	});

	it("a long provider list is cut in the refusal, saying how many more", async () => {
		const models = Array.from({ length: 100 }, (_, i) => `gpt-${i}`);
		const err = await checkEngineModel(env, "inst-1", "u1", ENGINE("codex", "Codex"), "nope", answering(models)).then(() => null, (e) => e as Error);
		expect(err?.message).toContain("gpt-39");
		expect(err?.message).not.toContain("gpt-40,");
		expect(err?.message).toContain("and 60 more");
	});

	it("through coding_engine_set: a refused Claude pin writes nothing; an accepted one is saved", async () => {
		callRunner.mockImplementation(async () => ({ models: ["claude-opus-5-5"], defaultModel: null }));
		const before = (await readEngines(env, "inst-1", "u1")).engines.find((e) => e.id === "claude")?.command;
		await expect(writeEngineChoice(env, "inst-1", "u1", { engineId: "claude", model: "claude-opus-5" })).rejects.toMatchObject({ status: 400 });
		expect((await readEngines(env, "inst-1", "u1")).engines.find((e) => e.id === "claude")?.command).toBe(before);
		const view = await writeEngineChoice(env, "inst-1", "u1", { engineId: "claude", model: "claude-opus-5-5" });
		expect(view.modelCheck).toEqual({ validated: true });
	});

	it("Claude's dropdown keeps its documented aliases — only Grok's suggestions come from the machine", async () => {
		const claude = (await readEngineChoice(env, "inst-1", "u1")).engines.find((e) => e.id === "claude");
		expect(claude).toMatchObject({ suggestionsFrom: "documented" });
	});
});
