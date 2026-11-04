import { describe, expect, it } from "vitest";
import { buildEngineSpec } from "./engine.js";
import { modelArguments, requestedModelEvidence } from "./model-config.js";

describe("explicit CLI model selection (#1511)", () => {
	it.each(["provider/future-v42", "other-model"]) ("passes %s and effort to Codex without changing browser permissions", (model) => {
		const spec = buildEngineSpec({ engine: "codex", model, reasoningEffort: "high", authMode: "machine", prompt: "test", bridge: { command: "node", args: [], env: {} }, mcpConfigPath: "/tmp/mcp.json", toolTimeoutMs: 1000 });
		expect(spec.args[spec.args.indexOf("--model") + 1]).toBe(model);
		expect(spec.args).toContain('model_reasoning_effort="high"');
		expect(spec.args).toContain("read-only");
		expect(spec.args).toContain("--ignore-user-config");
	});
	it("preserves CLI defaults and refuses an unsupported engine/effort combination", () => {
		expect(modelArguments({ engine: "codex" })).toEqual([]);
		expect(modelArguments({ engine: "claude", model: "some-model" })).toEqual(["--model", "some-model"]);
		expect(() => modelArguments({ engine: "claude", reasoningEffort: "high" })).toThrow(/only.*codex/);
	});
	it("never reports requested launch arguments as observed provider identity", () => {
		expect(requestedModelEvidence({ engine: "codex", model: "future-model", reasoningEffort: "high" })).toEqual({ requestedModel: "future-model", requestedReasoningEffort: "high", modelVerification: "unverified" });
	});
});
