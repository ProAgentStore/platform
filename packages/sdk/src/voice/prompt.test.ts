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

describe("the prompt cannot be continued as speech", () => {
	// Whisper given silence does not return nothing — it continues the prompt in the prompt's
	// own style. The old framing ("The speaker is talking to an AI assistant about their work.
	// Expect terms like: …") produced fluent phantom USER messages in a real conversation:
	// "I just need to refactor this function before I commit the changes to the repo", built
	// entirely from the coding term list, logged as something the user said and (in hands-free)
	// auto-sent to an agent that can start work.
	it("is a bare term list — no sentence, no first person, no speaker framing", () => {
		const p = buildTranscribePrompt(["coding"]);
		expect(p).not.toMatch(/\bthe speaker\b/i);
		expect(p).not.toMatch(/\bexpect terms\b/i);
		expect(p).not.toMatch(/\bI\b/);
		// No sentence-ending punctuation to continue from.
		expect(p.endsWith(".")).toBe(false);
	});

	it("still biases the vocabulary it exists for", () => {
		const p = buildTranscribePrompt(["coding"], ["ProAgentStore/platform"]);
		expect(p).toContain("refactor");
		expect(p).toContain("ProAgentStore/platform");
	});

	it("stays empty for an agent with no domain, so no bias is applied at all", () => {
		expect(buildTranscribePrompt([])).toBe("");
	});
});
