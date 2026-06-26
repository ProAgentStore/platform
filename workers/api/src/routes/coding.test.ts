import { describe, expect, it } from "vitest";
import { deriveClientType } from "./coding.js";

describe("deriveClientType", () => {
	it("classifies bare engine binaries", () => {
		expect(deriveClientType("claude --dangerously-skip-permissions")).toBe("claude");
		expect(deriveClientType("codex")).toBe("codex");
		expect(deriveClientType("grok --foo")).toBe("grok");
		expect(deriveClientType("gemini")).toBe("gemini");
		expect(deriveClientType("claude-code")).toBe("claude");
	});

	it("skips env assignments and launchers to find the real binary", () => {
		expect(deriveClientType("npx codex")).toBe("codex");
		expect(deriveClientType("ANTHROPIC_MODEL=x claude")).toBe("claude");
		expect(deriveClientType("env FOO=1 npx @openai/codex")).toBe("codex");
		expect(deriveClientType("bunx grok")).toBe("grok");
	});

	it("uses the basename of an absolute path", () => {
		expect(deriveClientType("/usr/local/bin/claude --resume abc")).toBe("claude");
	});

	it("treats an unknown binary as raw (codex), NOT as Claude stream-json", () => {
		expect(deriveClientType("aider --model gpt4")).toBe("codex");
		expect(deriveClientType("/opt/tools/mycli")).toBe("codex");
	});

	it("defaults to claude for an empty command", () => {
		expect(deriveClientType("")).toBe("claude");
		expect(deriveClientType("   ")).toBe("claude");
	});
});
