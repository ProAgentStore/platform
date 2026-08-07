import { describe, expect, it } from "vitest";
import { buildTranscribePrompt, isTranscribeBiasEcho, transcribeBiasTerms } from "./prompt.js";

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

// The bias still earns its place (it is what stops "bugs" → "bars"), so the answer to #332 is not
// to drop it — it is to recognise it when it comes back. Silence handed to the decoder does not
// return nothing; it returns something from the list we supplied.
describe("isTranscribeBiasEcho (#332 — the list read back to us)", () => {
	it("recognises the incident transcript: the agent's own name, alone, from silence", () => {
		const prompt = buildTranscribePrompt(["coding"], ["Coder Lead"]);
		expect(isTranscribeBiasEcho("Coder Lead", prompt)).toBe(true);
		expect(isTranscribeBiasEcho("coder lead.", prompt)).toBe(true);
		expect(isTranscribeBiasEcho("Coder-Lead", prompt)).toBe(true); // same normaliser as #334
	});

	it("recognises a multi-word generic term echoed alone", () => {
		expect(isTranscribeBiasEcho("pull request", buildTranscribePrompt(["coding"]))).toBe(true);
		expect(isTranscribeBiasEcho("cover letter", buildTranscribePrompt(["apply"]))).toBe(true);
	});

	it("never fires on a single word — a one-word utterance is plausible speech", () => {
		const prompt = buildTranscribePrompt(["coding"], ["Sentry"]);
		for (const word of ["commit", "deploy", "refactor", "Sentry"]) expect(isTranscribeBiasEcho(word, prompt)).toBe(false);
	});

	it("never fires on a sentence that merely uses the terms", () => {
		const prompt = buildTranscribePrompt(["coding"], ["Coder Lead"]);
		expect(isTranscribeBiasEcho("open a pull request", prompt)).toBe(false);
		expect(isTranscribeBiasEcho("ask Coder Lead about it", prompt)).toBe(false);
	});

	it("is inert with no prompt — an agent with no bias has nothing to echo", () => {
		expect(isTranscribeBiasEcho("Coder Lead")).toBe(false);
		expect(isTranscribeBiasEcho("Coder Lead", "")).toBe(false);
		expect(isTranscribeBiasEcho("", buildTranscribePrompt(["coding"]))).toBe(false);
	});

	it("reads the prompt back into the terms it was built from", () => {
		expect(transcribeBiasTerms(buildTranscribePrompt(["coding"], ["Coder Lead"]))).toContain("coder lead");
		expect(transcribeBiasTerms("")).toEqual([]);
	});
});
