/**
 * #1042 — subscription CLI is the default for actual coding; API-key coding needs the owner's console
 * confirmation, is refused at spawn without it, and never stands in for (or is stood in for by) a
 * subscription login. Real schema throughout: presets and confirmations are read from the instance's
 * stored config, exactly as a session start reads them.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "./d1-sqlite.js";
import type { Env } from "../types.js";

/** The vault, per provider — `getUserProviderKey` is the one boundary stubbed. */
const keys = vi.hoisted(() => new Map<string, string>());
vi.mock("./user-ai.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./user-ai.js")>()),
	getUserProviderKey: async (_env: unknown, _uid: string, provider: string) => keys.get(provider) ?? null,
}));
const runnerCalls = vi.hoisted(() => [] as string[]);
vi.mock("./runner-client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./runner-client.js")>()),
	getRunnerConnIgnoringLiveness: async () => ({ runnerNode: "mac" }),
	relayConnected: async () => true,
	callRunner: async (_conn: unknown, path: string) => {
		runnerCalls.push(path);
		return {};
	},
}));

const { DEFAULT_ENGINES, readEngines, resolveEngineEnv } = await import("./coding-engines.js");
const { ApiCodingRefused, apiCodingOptInsForSave, apiCodingView, parseApiCodingOptIns } = await import("./coding-api-policy.js");
const { startSessionOnRunner } = await import("./coding-session-open.js");
const { BRAIN_MODELS } = await import("./brain-models.js");

const MIGRATION = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations/0226_coding_engines_subscription_default.sql"), "utf8");
const KEY_PRESET = { id: "claude-api", label: "Claude (API)", command: "claude --dangerously-skip-permissions --model claude-sonnet-4-6", auth: "api-key" as const };

let d1: RealSchemaD1;
let env: Env;
const config = (cfg: unknown) => d1.exec(`UPDATE agent_instances SET config = '${JSON.stringify(cfg).replaceAll("'", "''")}' WHERE id = 'i1'`);
const session = (launchCommand: string, clientType = "claude") => ({ id: "s1", clientType, launchCommand }) as never;

beforeEach(() => {
	keys.clear();
	runnerCalls.length = 0;
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('coder', 'u1', 't1042-coder', 'Coder', '{}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i1', 'coder', 'u1', 'active', '{}')`);
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

describe("defaults are subscription CLI (#1042)", () => {
	it("a new instance's presets and default engine are all subscription/local CLIs", async () => {
		const { engines, defaultEngineId } = await readEngines(env, "i1", "u1");
		expect(engines).toEqual(DEFAULT_ENGINES);
		expect(engines.filter((e) => e.auth === "api-key")).toEqual([]);
		expect(defaultEngineId).toBe("claude");
	});

	it("a subscription engine never receives a provider key, even with one stored", async () => {
		keys.set("anthropic", "sk-ant-stored");
		keys.set("google", "g-key");
		expect(await resolveEngineEnv(env, "i1", "u1", session(DEFAULT_ENGINES[0].command))).toEqual({ ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" });
		const gemini = DEFAULT_ENGINES.find((e) => e.id === "gemini")!;
		expect(await resolveEngineEnv(env, "i1", "u1", session(gemini.command, "gemini"))).toEqual({ GEMINI_API_KEY: "" });
	});
});

describe("the spawn gate: no unconfirmed API-key coding, and no fallback (#1042)", () => {
	it("an api-key preset with no console confirmation is refused — no key, no machine login", async () => {
		keys.set("anthropic", "sk-ant-stored");
		config({ codingEngines: [KEY_PRESET], defaultEngineId: "claude-api" });
		await expect(resolveEngineEnv(env, "i1", "u1", session(KEY_PRESET.command))).rejects.toMatchObject({ code: "api-key-not-confirmed", message: expect.stringMatching(/never falls back/) });
	});

	it("a confirmation for a DIFFERENT command (another model) does not cover it", async () => {
		keys.set("anthropic", "sk-ant-stored");
		config({ codingEngines: [KEY_PRESET], apiCodingOptIns: { "claude-api": { command: "claude --model claude-opus-5", provider: "anthropic", model: "claude-opus-5", acknowledgedAt: "2026-10-12T00:00:00Z" } } });
		await expect(resolveEngineEnv(env, "i1", "u1", session(KEY_PRESET.command))).rejects.toBeInstanceOf(ApiCodingRefused);
	});

	it("a confirmed api-key preset gets exactly its provider key", async () => {
		keys.set("anthropic", "sk-ant-stored");
		config({ codingEngines: [KEY_PRESET], apiCodingOptIns: { "claude-api": { command: KEY_PRESET.command, provider: "anthropic", model: "claude-sonnet-4-6", acknowledgedAt: "2026-10-12T00:00:00Z" } } });
		expect(await resolveEngineEnv(env, "i1", "u1", session(KEY_PRESET.command))).toEqual({ ANTHROPIC_API_KEY: "sk-ant-stored" });
	});

	it("a confirmed api-key preset with no key stored STOPS — it does not run on the machine's login", async () => {
		config({ codingEngines: [KEY_PRESET], apiCodingOptIns: { "claude-api": { command: KEY_PRESET.command, provider: "anthropic", model: null, acknowledgedAt: "2026-10-12T00:00:00Z" } } });
		await expect(resolveEngineEnv(env, "i1", "u1", session(KEY_PRESET.command))).rejects.toMatchObject({ code: "api-key-missing", message: expect.stringMatching(/no Anthropic API key is stored/) });
	});

	it("a session start (the path every loop, objective and background dispatch takes) reports the refusal and launches nothing", async () => {
		keys.set("anthropic", "sk-ant-stored");
		config({ codingEngines: [KEY_PRESET], defaultEngineId: "claude-api" });
		const repo = { id: "r1", instanceId: "i1", name: "repo", provider: "local", workdir: "~/repo", githubRepo: null } as never;
		const started = await startSessionOnRunner(env, "i1", "u1", { id: "s1", clientType: "claude", launchCommand: KEY_PRESET.command, runnerNode: "mac" } as never, repo);
		expect(started).toMatchObject({ conn: null, engineUnavailable: true, startError: expect.stringMatching(/Coding stopped: .*not been confirmed in the console/) });
		expect(runnerCalls).not.toContain("/coding/start");
	});
});

describe("saving presets: the confirmation is the console's alone (#1042)", () => {
	const engines = [{ id: "claude", label: "Claude Code", command: "claude" }, KEY_PRESET];

	it("refuses an unacknowledged api-key preset with the billing warning — provider, model, billing source, cost", () => {
		expect(() => apiCodingOptInsForSave(engines, {}, undefined, false)).toThrow(/Anthropic account \(ANTHROPIC_API_KEY.*separately from any subscription.*likely to cost more.*Model: claude-sonnet-4-6/s);
	});

	it("MCP can never supply the confirmation, even with the acknowledgement", () => {
		expect(() => apiCodingOptInsForSave(engines, {}, ["claude-api"], true)).toThrow(/only be turned on in the console/);
	});

	it("records it for exactly the confirmed command; a re-save keeps it; a changed command needs it again", () => {
		const optIns = apiCodingOptInsForSave(engines, {}, ["claude-api"], false, Date.parse("2026-10-13T00:00:00Z"));
		expect(optIns).toEqual({ "claude-api": { command: KEY_PRESET.command, provider: "anthropic", model: "claude-sonnet-4-6", acknowledgedAt: "2026-10-13T00:00:00.000Z" } });
		expect(apiCodingOptInsForSave(engines, optIns, undefined, true)).toEqual(optIns);
		expect(() => apiCodingOptInsForSave([{ ...KEY_PRESET, command: "claude --model claude-opus-5" }], optIns, undefined, false)).toThrow(/Confirm it in the console/);
	});

	it("a preset switched back to subscription drops its confirmation", () => {
		const optIns = apiCodingOptInsForSave(engines, {}, ["claude-api"], false);
		expect(apiCodingOptInsForSave([{ ...KEY_PRESET, auth: undefined }], optIns, undefined, false)).toEqual({});
	});

	it("reads malformed stored confirmations as none", () => {
		expect(parseApiCodingOptIns({ a: { command: 1 }, b: "x", c: null })).toEqual({});
		expect(parseApiCodingOptIns([1])).toEqual({});
	});
});

describe("what the panel is offered (#1042)", () => {
	it("each API alternative is usable only with its provider key stored; Cloudflare is listed (coming soon) only with its credentials; no DeepSeek", () => {
		const none = apiCodingView(new Set(), {}, []);
		expect(none.options.map((o) => [o.clientType, o.keyStored])).toEqual([["claude", false], ["codex", false], ["gemini", false], ["grok", false]]);
		expect(none.cloudflare).toBeNull();
		const some = apiCodingView(new Set(["openai", "cloudflare"]), {}, []);
		expect(some.options.find((o) => o.clientType === "codex")?.keyStored).toBe(true);
		expect(some.cloudflare).toEqual({ comingSoon: true, models: [expect.objectContaining({ label: "Llama 4 Scout 17B" }), expect.objectContaining({ label: "Llama 3.3 70B" }), expect.objectContaining({ label: "Qwen 2.5 Coder 32B" })] });
		expect(JSON.stringify(some)).not.toMatch(/deepseek/i);
	});

	it("the advisory Brain path is untouched: it still offers API-key models (Anthropic and Cloudflare)", () => {
		expect(new Set(BRAIN_MODELS.map((m) => m.provider))).toEqual(new Set(["anthropic", "cloudflare"]));
	});
});

describe("migration 0226 — existing instances move to subscription CLI (#1042)", () => {
	it("strips api-key sign-in from stored presets, keeps everything else and the order, and records what it switched", () => {
		config({
			codingEngines: [{ id: "claude", label: "Claude Code", command: "claude" }, { id: "gemini", label: "Gemini CLI", command: "gemini --prompt", auth: "api-key" }, { id: "codex", label: "Codex", command: "codex exec", auth: "subscription" }],
			defaultEngineId: "gemini",
			other: 1,
		});
		d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i2', 'coder', 'u1', 'active', '{"codingEngines":[{"id":"claude","label":"C","command":"claude"}]}')`);
		d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i3', 'coder', 'u1', 'active', 'not json')`);
		d1.exec(MIGRATION);
		const cfg = JSON.parse((d1.sqlite.prepare("SELECT config FROM agent_instances WHERE id = 'i1'").get() as { config: string }).config);
		expect(cfg.codingEngines).toEqual([{ id: "claude", label: "Claude Code", command: "claude" }, { id: "gemini", label: "Gemini CLI", command: "gemini --prompt" }, { id: "codex", label: "Codex", command: "codex exec", auth: "subscription" }]);
		expect(cfg).toMatchObject({ defaultEngineId: "gemini", other: 1, apiCodingMigrated: ["gemini"] });
		expect((d1.sqlite.prepare("SELECT config FROM agent_instances WHERE id = 'i2'").get() as { config: string }).config).toBe('{"codingEngines":[{"id":"claude","label":"C","command":"claude"}]}');
		expect((d1.sqlite.prepare("SELECT config FROM agent_instances WHERE id = 'i3'").get() as { config: string }).config).toBe("not json");
	});
});
