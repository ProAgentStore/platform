/**
 * #1199 — the runner reads an engine's live model list, for coding_engine_set to check a pinned id against.
 * The text is what `grok models` printed on a real machine (xAI Grok CLI 1.0.62, 2026-10-19).
 */
import { describe, expect, it } from "vitest";
import { listEngineModels, parseGrokModels } from "./engine-check.js";

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
