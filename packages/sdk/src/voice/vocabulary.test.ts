import { describe, expect, it } from "vitest";
import { editDistance, nearWord } from "./vocabulary.js";

describe("editDistance (bounded)", () => {
	it("is 0 for identical strings and counts single edits", () => {
		expect(editDistance("tmux", "tmux", 2)).toBe(0);
		expect(editDistance("color", "colour", 2)).toBe(1);
		expect(editDistance("heartful", "heartfull", 2)).toBe(1);
	});
	it("reports max+1 rather than the true distance once past the budget", () => {
		expect(editDistance("timo", "tmux", 1)).toBe(2);
		expect(editDistance("send", "context", 2)).toBe(3);
	});
	it("short-circuits on a length gap without walking the matrix", () => {
		expect(editDistance("a", "abcdefgh", 2)).toBe(3);
	});
});

describe("nearWord — the one answer to 'same word, different spelling?'", () => {
	it("accepts the disagreements two engines really produce", () => {
		expect(nearWord("colour", "color")).toBe(true);
		expect(nearWord("heartfull", "heartful")).toBe(true);
		expect(nearWord("transcripts", "transcript")).toBe(true);
	});
	it("refuses short words that merely rhyme — the tolerance is 0 at ≤3 letters", () => {
		for (const [a, b] of [["go", "no"], ["it", "is"], ["yes", "yet"]]) expect(nearWord(a, b)).toBe(false);
	});
	it("refuses a different first letter, however close the rest", () => {
		expect(nearWord("send", "bend")).toBe(false);
	});
	it("cannot reach Timo → tmux, and is not meant to (#373)", () => {
		// 3 edits over 4 letters. No honest edit-distance rule gets there without also reaching
		// words that have nothing to do with each other — that case is fixed by biasing the
		// decoder BEFORE the transcript exists (prompt.ts), not by rewriting words after it.
		expect(nearWord("timo", "tmux")).toBe(false);
	});
	it("uses the SHORTER word's length, so a long term can't buy a wider allowance", () => {
		expect(nearWord("deployment", "dep")).toBe(false);
	});
	it("is inert on empty input", () => {
		expect(nearWord("", "tmux")).toBe(false);
		expect(nearWord("tmux", "")).toBe(false);
	});
});
