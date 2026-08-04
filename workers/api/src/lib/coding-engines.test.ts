import { describe, expect, it } from "vitest";
import { deriveClientType, engineAuthFor, resolveEngineEnv, type CodingEngine } from "./coding-engines.js";
import type { Env } from "../types.js";

/** Env whose vault holds only the providers listed. */
function buildEnv(stored: Record<string, string> = {}) {
	return {
		DB: {
			prepare() {
				return { bind() { return { async first() { return null; }, async all() { return { results: [] }; } }; } };
			},
		},
		__stored: stored,
	} as unknown as Env;
}

/** resolveEngineEnv reads the vault via getUserProviderKey; stub the module boundary by
 *  passing an env whose DB returns nothing, so "no stored token" is the default path. */
const session = (over: Record<string, unknown> = {}) =>
	({ id: "s1", clientType: "claude", launchCommand: "claude --dangerously-skip-permissions", ...over }) as never;

const presets: CodingEngine[] = [
	{ id: "claude", label: "Claude Code", command: "claude --dangerously-skip-permissions" },
	{ id: "sub", label: "Claude (subscription)", command: "claude --sub", auth: "subscription" },
	{ id: "machine", label: "Claude (machine)", command: "claude --machine", auth: "machine" },
	{ id: "key", label: "Claude (api key)", command: "claude --key", auth: "api-key" },
];

describe("engineAuthFor", () => {
	it("defaults an unlabelled preset to auto", () => {
		expect(engineAuthFor(presets, "claude --dangerously-skip-permissions")).toBe("auto");
	});

	it("reads the preset's declared mode", () => {
		expect(engineAuthFor(presets, "claude --sub")).toBe("subscription");
		expect(engineAuthFor(presets, "claude --machine")).toBe("machine");
		expect(engineAuthFor(presets, "claude --key")).toBe("api-key");
	});

	it("falls back to auto for a command matching no preset", () => {
		// An edited preset applies on the next start; an orphan command must not crash.
		expect(engineAuthFor(presets, "claude --something-else")).toBe("auto");
	});
});

describe("resolveEngineEnv — a mode must decide how the engine BILLS", () => {
	it("auto with no stored token STRIPS the inherited API key", async () => {
		// The bug this exists to stop: a shell exporting ANTHROPIC_API_KEY silently turned every
		// mode into per-token billing, because the runner inherits process.env wholesale and
		// Claude Code prefers an API key over the subscription login.
		const out = await resolveEngineEnv(buildEnv(), "i1", "u1", session());
		expect(out).toEqual({ ANTHROPIC_API_KEY: "" }); // "" means REMOVE (runner mergeEnv)
	});

	it("machine mode strips it too — an env key is not a login", async () => {
		const out = await resolveEngineEnv(buildEnv(), "i1", "u1", session({ launchCommand: "claude --machine" }));
		expect(out).toEqual({ ANTHROPIC_API_KEY: "" });
	});

	it("a non-Claude engine also gets its own provider key stripped", async () => {
		// Codex would otherwise inherit OPENAI_API_KEY the same way.
		const out = await resolveEngineEnv(buildEnv(), "i1", "u1", session({ clientType: "codex", launchCommand: "codex" }));
		expect(out).toEqual({ OPENAI_API_KEY: "" });
	});
});

describe("deriveClientType", () => {
	it("maps the real binary past wrappers and env prefixes", () => {
		expect(deriveClientType("FOO=1 npx claude --flag")).toBe("claude");
		expect(deriveClientType("codex")).toBe("codex");
	});

	it("runs an unknown binary RAW rather than mis-driving it as Claude", () => {
		expect(deriveClientType("some-other-cli")).toBe("codex");
	});
});
