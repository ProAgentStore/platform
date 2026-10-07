import { describe, expect, it } from "vitest";
import { MAX_TAGS, matchesTags, normalizeTags, tagsOf, wantedTags } from "./instance-tags.js";

describe("instance tags (#961)", () => {
	it("keeps the owner's spelling, trims, and drops blanks and case-insensitive duplicates", () => {
		expect(normalizeTags([" store-coders ", "PAS-apps", "pas-apps", ""])).toEqual({ tags: ["store-coders", "PAS-apps"] });
		expect(normalizeTags([])).toEqual({ tags: [] });
	});

	it("refuses what cannot be a tag, naming it — never a silent drop", () => {
		expect(normalizeTags("store")).toMatchObject({ error: expect.stringContaining("must be a list") });
		expect(normalizeTags([3])).toMatchObject({ error: "Every tag must be a string." });
		expect(normalizeTags(["no/slash"])).toMatchObject({ error: expect.stringContaining('"no/slash"') });
		expect(normalizeTags(["x".repeat(41)])).toMatchObject({ error: "A tag is 41 characters; the limit is 40." });
		expect(normalizeTags(Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`))).toMatchObject({ error: expect.stringContaining(`at most ${MAX_TAGS}`) });
	});

	it("matches any wanted tag case-insensitively; no wanted tag matches everything", () => {
		expect(matchesTags(["Store-Coders"], ["store-coders"])).toBe(true);
		expect(matchesTags(["a"], ["b", "A"])).toBe(true);
		expect(matchesTags([], ["a"])).toBe(false);
		expect(matchesTags([], [])).toBe(true);
	});

	it("reads tags off a config blob defensively, and the query in both spellings", () => {
		expect(tagsOf({ tags: ["a", 1, " ", "b"] })).toEqual(["a", "b"]);
		expect(tagsOf({ tags: "a" })).toEqual([]);
		expect(wantedTags({ tag: ["a"], tags: "b, c,," })).toEqual(["a", "b", "c"]);
	});
});
