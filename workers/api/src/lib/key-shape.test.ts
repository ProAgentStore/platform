import { describe, expect, it } from "vitest";
import { identifyKeyProvider, wrongProviderError } from "./key-shape.js";

describe("wrongProviderError — accept the unknown, reject the misrouted", () => {
	it("ACCEPTS Google's new AQ. format", () => {
		// The live bug: AI Studio issues `AQ.…` now, the old check demanded `AIza…`, and a
		// working key could not be saved at all. A format we have not heard of is far more
		// likely to be new than wrong.
		expect(wrongProviderError("google", "AQ.Ab8RN6xxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toBeNull();
	});

	it("still accepts Google's older AIza format", () => {
		expect(wrongProviderError("google", "AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX")).toBeNull();
	});

	it("REJECTS an Anthropic key pasted into the Google slot", () => {
		// The thing the check is actually for.
		const err = wrongProviderError("google", "sk-ant-api03-xxxx");
		expect(err).toContain("Anthropic");
		expect(err).toContain("Google");
	});

	it("REJECTS a Google key pasted into the OpenAI slot", () => {
		expect(wrongProviderError("openai", "AIzaSyXXXX")).toContain("Google");
	});

	it("does not mistake an Anthropic key for OpenAI", () => {
		// `sk-ant-` also starts with `sk-`; most-specific must win or every Anthropic key
		// reads as OpenAI and lands in the wrong bucket.
		expect(identifyKeyProvider("sk-ant-api03-x")).toBe("anthropic");
		expect(wrongProviderError("anthropic", "sk-ant-api03-x")).toBeNull();
	});

	it("does not mistake an OpenRouter key for OpenAI", () => {
		expect(identifyKeyProvider("sk-or-v1-xxxx")).toBe("openrouter");
	});

	it("identifies a plain OpenAI key", () => {
		expect(identifyKeyProvider("sk-proj-xxxx")).toBe("openai");
	});

	it("accepts an unfamiliar shape for any provider", () => {
		// Providers rotate formats; the validator must not be the reason a valid key is refused.
		for (const p of ["google", "openai", "anthropic", "xai", "mcp", "http"]) {
			expect(wrongProviderError(p, "totally-new-format-2027")).toBeNull();
		}
	});

	it("accepts an empty key rather than misclassifying it (emptiness is checked elsewhere)", () => {
		expect(wrongProviderError("google", "")).toBeNull();
	});
});
