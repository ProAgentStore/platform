import { describe, expect, it } from "vitest";
import { CHAT_MAX_TOKENS, hitOutputCap, truncationNotice } from "./reply-truncation.js";

describe("hitOutputCap (#397 — a reply that stopped because it ran out of room)", () => {
	it("recognises the provider verdicts that MEAN truncation", () => {
		// Anthropic's spelling and the OpenAI-shaped one. Both, because the field this reads is
		// whatever the provider adapter put there, and a second provider must not silently turn the
		// check off by using the other word.
		expect(hitOutputCap("max_tokens")).toBe(true);
		expect(hitOutputCap("length")).toBe(true);
		expect(hitOutputCap("MAX_TOKENS")).toBe(true);
		expect(hitOutputCap(" max_tokens ")).toBe(true);
	});

	it("never fires on a reply that simply FINISHED", () => {
		// The failure mode this guards is the notice becoming noise: a warning on every turn is a
		// warning nobody reads, and then the one turn it matters on is invisible again.
		for (const done of ["end_turn", "stop_sequence", "tool_use", "stop", "", "unknown"]) {
			expect(hitOutputCap(done), done).toBe(false);
		}
	});

	it("treats a provider that reports NOTHING as not-truncated", () => {
		// Cloudflare Workers AI does not report a stop reason. Absence is not evidence of a cut, and
		// guessing from response length would mark long, complete answers as truncated.
		expect(hitOutputCap(undefined)).toBe(false);
		expect(hitOutputCap(null)).toBe(false);
		expect(hitOutputCap(4096)).toBe(false);
		expect(hitOutputCap({ type: "max_tokens" })).toBe(false);
	});
});

describe("truncationNotice", () => {
	it("says the answer is incomplete AND how to get the rest", () => {
		// Naming the remedy is the load-bearing half: a reply that stops mid-sentence reads as a bug
		// in the agent, and "ask it to continue" is the only action that recovers the answer.
		const n = truncationNotice();
		expect(n).toContain("not the whole answer");
		expect(n).toMatch(/continue/i);
	});

	it("leads with the ⚠️ platform prefix so the console cannot fold it into a 'Used …' chip", () => {
		// Same rule as the #395 notices: every chat surface collapses a system message that STARTS
		// with a tool marker, so a disclosure that does not lead is a disclosure nobody opens.
		expect(truncationNotice().startsWith("⚠️ **platform**")).toBe(true);
	});

	it("names the cap it hit, formatted, from the caller's number", () => {
		expect(truncationNotice(4096)).toContain("4,096-token");
		expect(truncationNotice(1024)).toContain("1,024-token");
		expect(truncationNotice()).toContain(CHAT_MAX_TOKENS.toLocaleString("en-US"));
	});
});

describe("CHAT_MAX_TOKENS", () => {
	it("is meaningfully larger than the 1024 default chat used to inherit", () => {
		// The regression this pins: someone removing the explicit cap, or trimming it back toward
		// the default, re-creates #397 — a Repo Coder answer cut off mid-import, stored and shown as
		// if it were whole. 4k is the floor "a reply a person reads end to end" needs.
		expect(CHAT_MAX_TOKENS).toBeGreaterThanOrEqual(4096);
	});
});
