import { describe, expect, it } from "vitest";
import { type CodingEngine, deriveClientType, engineAuthFor, pickNextIssue } from "./coding.js";

describe("pickNextIssue (issues-mode Loop objective source)", () => {
	const issues = [{ number: 7 }, { number: 3 }, { number: 12 }];
	it("picks the lowest-numbered open issue (deterministic order)", () => {
		expect(pickNextIssue(issues, new Set())).toEqual({ number: 3 });
	});
	it("skips excluded issues (declined this run + the active one)", () => {
		expect(pickNextIssue(issues, new Set([3]))).toEqual({ number: 7 });
		expect(pickNextIssue(issues, new Set([3, 7]))).toEqual({ number: 12 });
	});
	it("returns null when every issue is excluded or the backlog is empty", () => {
		expect(pickNextIssue(issues, new Set([3, 7, 12]))).toBeNull();
		expect(pickNextIssue([], new Set())).toBeNull();
	});
	it("does not mutate the input array", () => {
		const input = [{ number: 5 }, { number: 1 }];
		pickNextIssue(input, new Set());
		expect(input).toEqual([{ number: 5 }, { number: 1 }]);
	});
});

describe("engineAuthFor (per-engine sign-in method)", () => {
	const engines: CodingEngine[] = [
		{ id: "claude", label: "Claude Code", command: "claude --dangerously-skip-permissions", auth: "subscription" },
		{ id: "claude-api", label: "Claude (API)", command: "claude --model opus", auth: "api-key" },
		{ id: "codex", label: "Codex", command: "codex", auth: "machine" },
		{ id: "gemini", label: "Gemini CLI", command: "gemini" },
	];

	it("matches a session's launch command back to its preset's auth", () => {
		expect(engineAuthFor(engines, "claude --dangerously-skip-permissions")).toBe("subscription");
		expect(engineAuthFor(engines, "claude --model opus")).toBe("api-key");
		expect(engineAuthFor(engines, "codex")).toBe("machine");
	});

	it("defaults to auto when the preset has no auth or the command matches nothing", () => {
		expect(engineAuthFor(engines, "gemini")).toBe("auto"); // preset without auth
		expect(engineAuthFor(engines, "claude --some-edited-command")).toBe("auto"); // edited/legacy session
		expect(engineAuthFor(engines, null)).toBe("auto");
		expect(engineAuthFor(engines, undefined)).toBe("auto");
	});

	it("ignores an invalid auth value from a hand-edited config", () => {
		const bad = [{ id: "x", label: "X", command: "claude", auth: "steal-keys" as CodingEngine["auth"] }];
		expect(engineAuthFor(bad, "claude")).toBe("auto");
	});
});

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
