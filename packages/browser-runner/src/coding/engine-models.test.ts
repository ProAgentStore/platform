/**
 * #1199 — the runner reads an engine's live model list, for coding_engine_set to check a pinned id against.
 * The text is what `grok models` printed on a real machine (xAI Grok CLI 1.0.62, 2026-10-19).
 */
import { describe, expect, it } from "vitest";
import { listEngineModelsLive, listEngineModels, parseGrokModels } from "./engine-check.js";

const GROK_MODELS_OUTPUT = `You are logged in with grok.com.

Default model: grok-4.7

Available models:
  * grok-4.7 (default)
  - grok-4.7-build-fast
  - grok-4.6
  - grok-4.5
`;

const installed = { env: { PATH: "/usr/local/bin" }, platform: "darwin" as const, home: "/home/owner", isExecutable: (p: string) => p === "/usr/local/bin/grok" };

describe("the engine's live model list (#1199)", () => {
	it("reads `grok models`: every id, and the default", () => {
		expect(parseGrokModels(GROK_MODELS_OUTPUT)).toEqual({ models: ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"], defaultModel: "grok-4.7" });
	});

	it("text with no model list is no list — not an empty one that would refuse everything", () => {
		expect(parseGrokModels("Error: not logged in. Run grok login.")).toBeNull();
		expect(parseGrokModels("Available models:\n\n")).toBeNull();
	});

	it("asks `grok models` with the binary the preset names", () => {
		const asked: string[][] = [];
		const listText = (s: { args: string[] }) => {
			asked.push(s.args);
			return GROK_MODELS_OUTPUT;
		};
		const out = listEngineModels({ clientType: "grok", command: "grok --permission-mode bypassPermissions -p" }, { ...installed, listText });
		expect(asked).toEqual([["models"]]);
		expect(out).toMatchObject({ clientType: "grok", defaultModel: "grok-4.7" });
		expect(out.models).toContain("grok-4.7");
		expect(out.models).not.toContain("grok-4");
	});

	it("an engine with no list, a missing binary, and a CLI that printed none each say why — never a guessed list", () => {
		expect(listEngineModels({ clientType: "claude", command: "claude" })).toMatchObject({ models: null, reason: expect.stringMatching(/publishes no model list/) });
		expect(listEngineModels({ clientType: "grok", command: "grok -p" }, { ...installed, isExecutable: () => false })).toMatchObject({ models: null, reason: expect.stringMatching(/not installed/) });
		expect(listEngineModels({ clientType: "grok", command: "grok -p" }, { ...installed, listText: () => null })).toMatchObject({ models: null, reason: expect.stringMatching(/signed in/) });
	});
});

describe("the provider's model list, for the CLIs that list none (#1206)", () => {
	const reply = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });
	const calls: { url: string; headers: Record<string, string> }[] = [];
	const spy = (body: unknown, status = 200): typeof fetch => async (url, init) => {
		calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
		return reply(body, status)();
	};

	it("Claude: reads Anthropic's /v1/models with ANTHROPIC_API_KEY", async () => {
		calls.length = 0;
		const out = await listEngineModelsLive({ clientType: "claude", command: "claude" }, { env: { ANTHROPIC_API_KEY: "sk-ant-test" }, fetch: spy({ data: [{ id: "claude-opus-5-5" }, { id: "claude-sonnet-5-5" }] }) });
		expect(out).toMatchObject({ clientType: "claude", models: ["claude-opus-5-5", "claude-sonnet-5-5"] });
		expect(calls[0].url).toBe("https://api.anthropic.com/v1/models?limit=1000");
		expect(calls[0].headers["x-api-key"]).toBe("sk-ant-test");
		expect(JSON.stringify(out)).not.toContain("sk-ant-test"); // the key is used, never returned
	});

	it("Codex: OpenAI /v1/models; Gemini: the `models/` prefix is dropped", async () => {
		const codex = await listEngineModelsLive({ clientType: "codex" }, { env: { OPENAI_API_KEY: "sk-test" }, fetch: spy({ data: [{ id: "gpt-5" }, { id: "gpt-5" }] }) });
		expect(codex.models).toEqual(["gpt-5"]);
		const gemini = await listEngineModelsLive({ clientType: "gemini" }, { env: { GOOGLE_API_KEY: "g-test" }, fetch: spy({ models: [{ name: "models/gemini-2.5-pro" }] }) });
		expect(gemini.models).toEqual(["gemini-2.5-pro"]);
	});

	it("no key (a subscription login) asks nothing and says which key would have helped", async () => {
		let asked = 0;
		const out = await listEngineModelsLive({ clientType: "claude" }, { env: {}, fetch: (async () => { asked++; return new Response("{}"); }) as typeof fetch });
		expect(asked).toBe(0);
		expect(out.models).toBeNull();
		expect(out.reason).toMatch(/publishes no model list.*ANTHROPIC_API_KEY/);
	});

	it("a refused key, an empty list and an unreachable provider are each no list — never an empty one that refuses everything", async () => {
		const env = { ANTHROPIC_API_KEY: "k" };
		expect(await listEngineModelsLive({ clientType: "claude" }, { env, fetch: spy({ error: "bad key" }, 401) })).toMatchObject({ models: null, reason: expect.stringMatching(/answered 401/) });
		expect(await listEngineModelsLive({ clientType: "claude" }, { env, fetch: spy({ data: [] }) })).toMatchObject({ models: null, reason: expect.stringMatching(/empty/) });
		expect(await listEngineModelsLive({ clientType: "claude" }, { env, fetch: (async () => { throw new Error("offline"); }) as typeof fetch })).toMatchObject({ models: null, reason: expect.stringMatching(/could not be reached/) });
	});

	it("Grok still answers from its own CLI and never touches a provider", async () => {
		let asked = 0;
		const out = await listEngineModelsLive({ clientType: "grok", command: "grok -p" }, { ...installed, listText: () => GROK_MODELS_OUTPUT, fetch: (async () => { asked++; return new Response("{}"); }) as typeof fetch });
		expect(out.models).toContain("grok-4.7");
		expect(asked).toBe(0);
	});
});
