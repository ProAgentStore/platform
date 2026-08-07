import { describe, expect, it } from "vitest";
import { deleteTurnPrompt, scrapPreviewPrompt, turnEffectSummary } from "./turnEffects";

const messages = [
	{ id: "u1", role: "user", content: "look at the repo" },
	{ id: "t1", role: "system", content: "✅ **search_knowledge** → 3 hits\n✅ **write_memory** → ok" },
	{ id: "a1", role: "assistant", content: "Done." },
	{ id: "u2", role: "user", content: "thanks" },
	{ id: "a2", role: "assistant", content: "Any time." },
];

describe("turnEffectSummary", () => {
	it("names the tools the turn ran, from any message in it", () => {
		expect(turnEffectSummary(messages, "u1")).toBe("search_knowledge, write_memory");
		expect(turnEffectSummary(messages, "a1")).toBe("search_knowledge, write_memory");
	});

	it("does not attribute a neighbouring turn's tools", () => {
		expect(turnEffectSummary(messages, "u2")).toBeNull();
	});

	it("returns null for an id that is not on screen", () => {
		expect(turnEffectSummary(messages, "nope")).toBeNull();
	});
});

describe("deleteTurnPrompt", () => {
	it("says what stays, not only what goes", () => {
		const prompt = deleteTurnPrompt("start_work");
		expect(prompt).toContain("start_work");
		// The load-bearing sentence: a delete is not a retraction.
		expect(prompt).toMatch(/does NOT undo/);
	});

	it("still addresses side effects when there were none", () => {
		expect(deleteTurnPrompt(null)).toMatch(/no tools/);
	});
});

describe("scrapPreviewPrompt (the voice trigger)", () => {
	// The whole safety of a voice-aimed delete: the words about to be destroyed are on screen.
	// A mis-heard "scrap that" is caught by READING the quote, not by trusting the recogniser.
	it("quotes the turn it is about to destroy", () => {
		expect(scrapPreviewPrompt("index the repo", null)).toContain("“index the repo”");
	});

	it("keeps the what-stays-behind sentence the button's prompt carries", () => {
		expect(scrapPreviewPrompt("do the thing", "start_work")).toMatch(/does NOT undo/);
		// …without the button's "Delete this turn?" heading, which would contradict its own.
		expect(scrapPreviewPrompt("do the thing", null)).not.toContain("Delete this turn?");
	});

	it("truncates a long turn rather than filling the dialog", () => {
		const prompt = scrapPreviewPrompt("x".repeat(500), null);
		expect(prompt).toContain("…");
		expect(prompt.length).toBeLessThan(700);
	});
});
