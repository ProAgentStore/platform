/**
 * The agent-template model picker (#863): the brain catalogue and nothing else. It offered Claude
 * Opus/Haiku (which the Anthropic brain runs as Sonnet), a 3B model that cannot call tools and Mistral.
 */
import { describe, expect, it } from "vitest";
import { BRAIN_MODELS } from "../../../../workers/api/src/lib/brain-models";
import { templateModelField, templateModelOptions } from "./template-models";

describe("templateModelOptions (#863)", () => {
	it("offers exactly the brain models, labelled like the instance picker", () => {
		const options = templateModelOptions("claude-sonnet-4-6");
		expect(options.map((o) => o.value)).toEqual(BRAIN_MODELS.map((m) => m.id));
		expect(options[0].label).toBe(`${BRAIN_MODELS[0].label} — ${BRAIN_MODELS[0].hint}`);
		expect(options.some((o) => o.disabled)).toBe(false);
	});

	it("a stored model outside the catalogue is shown, disabled and flagged — never silently switched", () => {
		const options = templateModelOptions("claude-opus-4");
		expect(options[0]).toEqual({ value: "claude-opus-4", label: "claude-opus-4 (not a brain model — kept until you pick one)", disabled: true });
		expect(options.slice(1).map((o) => o.value)).toEqual(BRAIN_MODELS.map((m) => m.id));
	});

	it("no stored model: just the catalogue", () => {
		expect(templateModelOptions("").map((o) => o.value)).toEqual(BRAIN_MODELS.map((m) => m.id));
	});
});

describe("templateModelField (#863)", () => {
	it("sends a brain model; leaves a kept off-catalogue model out of the save, so the rest still saves", () => {
		expect(templateModelField("@cf/qwen/qwen2.5-coder-32b-instruct")).toEqual({ model: "@cf/qwen/qwen2.5-coder-32b-instruct" });
		expect(templateModelField("claude-opus-4")).toEqual({});
	});
});
