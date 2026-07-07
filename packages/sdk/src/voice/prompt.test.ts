import { describe, expect, it } from "vitest";
import { buildTranscribePrompt } from "./prompt.js";

describe("buildTranscribePrompt", () => {
	it("biases toward coding vocabulary for coding/repo surfaces (fixes 'bugs'→'bars')", () => {
		const p = buildTranscribePrompt(["coding"]);
		expect(p).toContain("bugs");
		expect(p).toContain("refactor");
		expect(buildTranscribePrompt(["repo"])).toContain("repository");
	});

	it("biases toward apply vocabulary for the apply surface", () => {
		const p = buildTranscribePrompt(["apply"]);
		expect(p).toContain("resume");
		expect(p).toContain("recruiter");
		expect(p).not.toContain("refactor");
	});

	it("appends extra proper nouns (e.g. repo names)", () => {
		expect(buildTranscribePrompt(["coding"], ["ProAgentStore/platform"])).toContain("ProAgentStore/platform");
	});

	it("returns empty (no bias) when there's nothing domain-specific", () => {
		expect(buildTranscribePrompt([])).toBe("");
		expect(buildTranscribePrompt(["chat"], ["  "])).toBe("");
	});
});
