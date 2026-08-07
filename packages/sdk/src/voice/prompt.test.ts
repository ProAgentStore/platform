import { describe, expect, it } from "vitest";
import { MAX_EXTRA_TERMS, buildTranscribePrompt, extendTranscribePrompt, isTranscribeBiasEcho, spokenForm, transcribeBiasTerms } from "./prompt.js";

// #371: a tmux operator has `surfaces: ["tmux"]`, so the gate — which only asked about `coding`
// and `repo` — skipped CODING_TERMS entirely. The whole bias for that agent was its own name.
describe("a terminal agent gets a vocabulary (#371)", () => {
	it("reads the tmux surface as coding-ish, so the coding terms it was missing arrive", () => {
		const p = buildTranscribePrompt(["tmux"]);
		expect(p).toContain("console");
		expect(p).toContain("terminal");
		expect(p).toContain("commit");
	});
	it("adds the terminal nouns a shell user actually says", () => {
		const p = buildTranscribePrompt(["tmux"]);
		expect(p).toContain("tmux"); // the word the browser gate returned as "Timo"
		expect(p).toContain("pane");
		expect(p).toContain("detach");
	});
	it("reads the RUNTIME axis too — the tmux agent's runtime was 'coding' the whole time", () => {
		const p = buildTranscribePrompt(["chat"], [], { runtime: "coding" });
		expect(p).toContain("refactor");
		// …but a runtime alone does not make it a terminal.
		expect(p).not.toContain("detach");
	});
	it("leaves a plain chat agent unbiased", () => {
		expect(buildTranscribePrompt(["chat"], [], { runtime: null })).toBe("");
	});
});

describe("the derived/user term list is bounded (#372)", () => {
	it("sends the spoken form of an identifier beside the written one", () => {
		const p = buildTranscribePrompt(["coding"], ["tmux-operator-runner"]);
		expect(p).toContain("tmux-operator-runner");
		expect(p).toContain("tmux operator runner");
	});
	it("splits camel case and slashes the way they are said aloud", () => {
		expect(spokenForm("ProAgentStore/platform")).toBe("Pro Agent Store platform");
		expect(spokenForm("heartfull")).toBe(""); // nothing to split → no duplicate term
	});
	it("does not send a term the static lists already carry", () => {
		const p = buildTranscribePrompt(["coding"], ["console"]);
		expect(p.match(/console/g)?.length).toBe(1);
	});
	it("dedupes the extras against each other, case-insensitively", () => {
		const p = buildTranscribePrompt(["coding"], ["Heartfull", "heartfull", "HEARTFULL"]);
		expect(p.match(/eartfull/gi)?.length).toBe(1);
	});
	// The terms arrive from two places at two times — the consumer knows the surfaces at render,
	// the vocabulary arrives with the voice config on every mic start. Re-joining rather than
	// concatenating strings is what keeps the cap and the dedupe honest across both.
	it("extends an already-built prompt under the same rules", () => {
		const base = buildTranscribePrompt(["tmux"]);
		const extended = extendTranscribePrompt(base, ["HeartFull", "tmux"]);
		expect(extended.startsWith(base)).toBe(true);
		expect(extended).toContain("HeartFull");
		expect(extended.match(/tmux/g)?.length).toBe(1); // already in TMUX_TERMS
	});
	it("extending nothing with nothing stays empty, so no bias field is sent at all", () => {
		expect(extendTranscribePrompt("", [])).toBe("");
		expect(extendTranscribePrompt("", ["Heartfull"])).toBe("Heartfull");
	});
	it("caps the extras — a long list degrades bias rather than improving it", () => {
		const many = Array.from({ length: 100 }, (_, i) => `Zterm${i}`);
		const p = buildTranscribePrompt(["coding"], many);
		expect(p.match(/Zterm/g)?.length).toBe(MAX_EXTRA_TERMS);
		// Caller supplies most-recently-used first, so the cap truncates the tail.
		expect(p).toContain("Zterm0");
		expect(p).not.toContain("Zterm99");
	});
});

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
