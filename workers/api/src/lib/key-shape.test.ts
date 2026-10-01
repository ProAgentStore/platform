import { describe, expect, it } from "vitest";
import { cloudflareCredentialsError, identifyKeyProvider, wrongProviderError } from "./key-shape.js";

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

describe("cloudflareCredentialsError — catch the swap before Cloudflare is asked (#893)", () => {
	// Self-labelling fixtures: an account ID is 32 hex characters, a token is anything else.
	const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
	const TOKEN = "cf-token-fixture-not-a-real-token-000000";

	it("accepts a well-formed pair", () => {
		expect(cloudflareCredentialsError(ACCOUNT_ID, TOKEN)).toBeNull();
	});

	it("accepts an upper-case account ID (the route stores it lower-cased)", () => {
		expect(cloudflareCredentialsError(ACCOUNT_ID.toUpperCase(), TOKEN)).toBeNull();
	});

	it("does not allowlist the token's format — an unfamiliar token is accepted", () => {
		expect(cloudflareCredentialsError(ACCOUNT_ID, "cfut_some-future-format")).toBeNull();
	});

	it("names a swap when the two fields hold each other's values", () => {
		expect(cloudflareCredentialsError(TOKEN, ACCOUNT_ID)).toMatch(/swapped/);
	});

	it("refuses an account ID that is not 32 hex characters", () => {
		expect(cloudflareCredentialsError(TOKEN, TOKEN)).toMatch(/not a Cloudflare account ID/);
		expect(cloudflareCredentialsError(ACCOUNT_ID.slice(1), TOKEN)).toMatch(/not a Cloudflare account ID/);
	});

	it("refuses an account ID in the token field", () => {
		expect(cloudflareCredentialsError(ACCOUNT_ID, ACCOUNT_ID)).toMatch(/not an API token/);
	});

	it("never quotes either value back", () => {
		for (const [id, tok] of [[TOKEN, ACCOUNT_ID], [TOKEN, TOKEN], [ACCOUNT_ID, ACCOUNT_ID]]) {
			const msg = cloudflareCredentialsError(id, tok) ?? "";
			expect(msg).not.toContain(TOKEN);
			expect(msg).not.toContain(ACCOUNT_ID);
		}
	});
});
