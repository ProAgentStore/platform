import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodingRuntime } from "../../../../packages/browser-runner/src/coding/runtime.js";
import { codingEngineModelProblem as runnerProblem } from "../../../../packages/browser-runner/src/coding/engine-model-policy.js";
import { codingEngineModelProblem, isHaikuCodingModel } from "./coding-engine-policy.js";

const denied = [
	"haiku", "HAIKU", "haiku[1m]", "claude-haiku-5-5", "claude-3-5-haiku-20241022",
	"anthropic/haiku", "anthropic:claude-haiku-4-5", "bedrock/anthropic.claude-haiku-4-5",
];
const commands = [
	"claude --model haiku", "claude --model=haiku[1m]", 'claude --model "anthropic/haiku"',
	"claude --model opus --fallback-model claude-haiku-5-5", "claude --fallback-model=haiku",
	"pas mcp-auth exec -- claude --model haiku", "codex exec -m anthropic/haiku", 'codex exec -c model="anthropic/haiku"',
	"env ANTHROPIC_MODEL=haiku claude",
];

describe("Haiku stays outside coding engines", () => {
	// Invariant: aliases and provider-qualified Haiku ids are refused without consulting a model provider.
	it("recognizes Haiku model values while preserving other model families", () => {
		for (const model of denied) expect(isHaikuCodingModel(model), model).toBe(true);
		for (const model of ["opus", "sonnet[1m]", "fable", "gpt-5.1-codex", "gemini-3-pro", "grok-4.7"]) expect(isHaikuCodingModel(model), model).toBe(false);
	});

	it("the API and runner apply the same refusal to selected models and fallbacks", () => {
		for (const command of commands) {
			expect(codingEngineModelProblem(command, undefined, "claude"), command).toMatch(/not permitted for coding engines/);
			expect(runnerProblem(command, undefined, "claude"), command).toBe(codingEngineModelProblem(command, undefined, "claude"));
		}
		expect(runnerProblem("claude", { ANTHROPIC_MODEL: "haiku" }, "claude")).toBe(codingEngineModelProblem("claude", { ANTHROPIC_MODEL: "haiku" }, "claude"));
		expect(runnerProblem("claude", { ANTHROPIC_MODEL: "haiku" }, "claude")).toMatch(/not permitted for coding engines/);
	});

	it("does not mistake a path, prompt or unrelated argument for a model pin", () => {
		for (const command of [
			"claude", "claude --model opus --add-dir /projects/haiku", 'claude --model sonnet --prompt "Explain --model haiku"',
			'claude --model opus --append-system-prompt "haiku"', "codex exec --model gpt-5.1-codex /projects/haiku",
			"gemini --model gemini-3-pro", "grok --model grok-4.7", "node /projects/haiku/custom-engine.mjs",
		]) {
			expect(codingEngineModelProblem(command), command).toBeNull();
			expect(runnerProblem(command), command).toBeNull();
		}
	});

	it("unused Anthropic model environment cannot block a different engine family", () => {
		for (const clientType of ["codex", "gemini", "grok"]) {
			const command = `env ANTHROPIC_MODEL=haiku ${clientType}`;
			expect(codingEngineModelProblem(command, { ANTHROPIC_MODEL: "haiku" }, clientType)).toBeNull();
			expect(runnerProblem(command, { ANTHROPIC_MODEL: "haiku" }, clientType)).toBeNull();
		}
	});

	it("a direct runner start refuses Haiku before cloning, creating files or spawning an engine", () => {
		const root = join(tmpdir(), `pags-haiku-refusal-${crypto.randomUUID()}`);
		const runtime = new CodingRuntime(root);
		for (const selected of [
			{ command: "claude --model haiku" }, { command: "claude --model opus --fallback-model haiku" },
			{ command: "claude", env: { ANTHROPIC_MODEL: "anthropic/haiku" } },
		]) expect(() => runtime.start({ sessionId: "s1", repoId: "r1", clientType: "claude", cloneUrl: "https://example.invalid/never-clone.git", ...selected })).toThrow(/not permitted for coding engines/);
		expect(existsSync(root)).toBe(false);
		expect(runtime.list()).toEqual([]);
	});
});
