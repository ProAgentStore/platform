import { describe, expect, it } from "vitest";
import { TOOL_CAPABLE_MODELS } from "../agent-do-prompt.js";
import { BRAIN_MODELS, isWorkersAiModel } from "./brain-models.js";

describe("BRAIN_MODELS (#852)", () => {
	it("offers only tool-capable models — a brain that cannot call tools confabulates", () => {
		expect(BRAIN_MODELS.filter((m) => !TOOL_CAPABLE_MODELS.has(m.id))).toEqual([]);
	});

	it("offers the three Cloudflare models #851 made tool-capable, each with a cost hint", () => {
		const cf = BRAIN_MODELS.filter((m) => m.provider === "cloudflare");
		expect(cf.map((m) => m.id)).toEqual([
			"@cf/meta/llama-4-scout-17b-16e-instruct",
			"@cf/meta/llama-3.3-70b-instruct-fp8-fast",
			"@cf/qwen/qwen2.5-coder-32b-instruct",
		]);
		expect(cf.every((m) => m.hint.startsWith("cheap"))).toBe(true);
		expect(BRAIN_MODELS.every((m) => isWorkersAiModel(m.id) === (m.provider === "cloudflare"))).toBe(true);
	});
});
