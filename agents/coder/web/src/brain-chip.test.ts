/** #1043: the active Brain model is visible on the coding screen, beside — not in place of — the engine. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrainChipView } from "./BrainChip";

describe("the Brain chip (#1043)", () => {
	it("names the picked Brain, its provider, and that it is advisory", () => {
		const html = renderToStaticMarkup(createElement(BrainChipView, { state: { model: "@cf/qwen/qwen2.5-coder-32b-instruct", modelChosen: true } }));
		expect(html).toContain('data-testid="brain-chip"');
		expect(html).toContain("Brain: Qwen 2.5 Coder 32B (Cloudflare Workers AI) · advisory only");
	});

	it("says when the default runs because nothing was picked", () => {
		expect(renderToStaticMarkup(createElement(BrainChipView, { state: {} }))).toContain("Brain: Claude Sonnet 4.6 (Anthropic) — default · advisory only");
	});

	it("renders nothing until the state is read", () => {
		expect(renderToStaticMarkup(createElement(BrainChipView, { state: null }))).toBe("");
	});
});
