import { describe, expect, it } from "vitest";
import { applyVocabulary, editDistance, nearWord } from "./vocabulary.js";

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

// The half of #373 that works on the BROWSER recogniser, which has no steerable grammar at all —
// `SpeechGrammarList` is specced and Chrome's default engine ignores it, so a post-hoc pass is the
// only lever that exists on that path.
describe("applyVocabulary — conservative, and visible", () => {
	const terms = ["HeartFull", "tmux", "Vectorize"];

	it("restores the user's own spelling without calling it a correction", () => {
		const r = applyVocabulary("open heartfull please", terms);
		expect(r.text).toBe("open HeartFull please");
		expect(r.corrections).toEqual([]);
	});
	it("corrects a near miss and reports it", () => {
		const r = applyVocabulary("check Heartful now", terms);
		expect(r.text).toBe("check HeartFull now");
		expect(r.corrections).toEqual([{ from: "Heartful", to: "HeartFull" }]);
	});
	it("leaves a mishearing that is not close to anything exactly as it arrived", () => {
		// The headline example of the ticket. `Timo`/`tmux` is 3 edits over 4 letters; reaching it
		// would mean reaching words with nothing to do with each other. The bias prompt is what
		// fixes that case, before the transcript exists.
		expect(applyVocabulary("is Timo ready", terms).text).toBe("is Timo ready");
		expect(applyVocabulary("Duet", terms).text).toBe("Duet");
	});
	it("never rewrites a short word — the tolerance is 0 below four letters", () => {
		expect(applyVocabulary("go now", ["no"]).text).toBe("go now");
	});
	it("leaves a token that is near TWO terms alone — we do not know which", () => {
		const r = applyVocabulary("deployy", ["deploy", "deploys"]);
		expect(r.text).toBe("deployy");
		expect(r.corrections).toEqual([]);
	});
	it("never touches a substring of a longer word", () => {
		expect(applyVocabulary("tmuxinator", ["tmux"]).text).toBe("tmuxinator");
	});
	it("ignores multi-word terms — a span replacement could restructure a sentence", () => {
		expect(applyVocabulary("pull requests are open", ["pull request"]).text).toBe("pull requests are open");
	});
	it("keeps the punctuation around what it replaces", () => {
		expect(applyVocabulary("run it, heartful.", terms).text).toBe("run it, HeartFull.");
	});
	it("is inert with no vocabulary and on empty text", () => {
		expect(applyVocabulary("anything", []).text).toBe("anything");
		expect(applyVocabulary("", terms).text).toBe("");
	});
});
