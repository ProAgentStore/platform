import { describe, expect, it } from "vitest";
import { MAX_DERIVED_TERMS, pickVocabularyTerms } from "./voice-vocabulary.js";

// The entry rule (#372): a term earns its place only if it is BOTH likely to be said aloud and
// likely to be mis-heard. Everything below is one half of that rule refusing something.
describe("pickVocabularyTerms", () => {
	it("keeps the proper nouns a user says to an agent", () => {
		expect(pickVocabularyTerms(["Heartfull", "ProAgentStore/platform", "tmux-operator-runner"])).toEqual([
			"Heartfull",
			"ProAgentStore/platform",
			"tmux-operator-runner",
		]);
	});
	it("drops ids, however they arrive — a `name` column is not a promise of a name", () => {
		expect(pickVocabularyTerms(["a3f9c81b2e", "12345", "  ", null, undefined])).toEqual([]);
	});
	it("drops URLs and absolute paths — nobody pronounces one", () => {
		expect(pickVocabularyTerms(["https://github.com/x/y", "/Users/me/dev/repo", "~/dev/repo"])).toEqual([]);
	});
	it("keeps `owner/repo`, which has neither a scheme nor a leading slash", () => {
		expect(pickVocabularyTerms(["ProAgentStore/platform"])).toEqual(["ProAgentStore/platform"]);
	});
	it("drops two-character tokens — they bias nothing and collide with everything", () => {
		expect(pickVocabularyTerms(["ok", "hi", "api"])).toEqual(["api"]);
	});
	it("drops anything longer than a word said in one breath", () => {
		expect(pickVocabularyTerms(["a".repeat(41)])).toEqual([]);
	});
	it("dedupes case-insensitively, preserving order", () => {
		expect(pickVocabularyTerms(["Platform", "platform", "Coder"])).toEqual(["Platform", "Coder"]);
	});
	it("caps the list, keeping the head — callers order most-relevant-first", () => {
		const many = Array.from({ length: 100 }, (_, i) => `Name${i}`);
		const out = pickVocabularyTerms(many);
		expect(out.length).toBe(MAX_DERIVED_TERMS);
		expect(out[0]).toBe("Name0");
	});
});
