import { describe, expect, it } from "vitest";
import { normalizeModel, priceFor, estimateCostMicros, formatUsd, DEFAULT_PRICE, estimateTtsMicros, estimateSttMicros, secondsFromAudioBytes } from "./ai-pricing.js";

describe("normalizeModel", () => {
	it("maps versioned/dated ids to the base key (longest prefix)", () => {
		expect(normalizeModel("claude-sonnet-4-6-20260101")).toBe("claude-sonnet-4-6");
		expect(normalizeModel("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
	});
	it("strips an anthropic/ provider prefix", () => {
		expect(normalizeModel("anthropic/claude-opus-4")).toBe("claude-opus-4");
	});
	it("buckets every @cf/ Workers-AI model into 'cf'", () => {
		expect(normalizeModel("@cf/meta/llama-4-scout-17b")).toBe("cf");
		expect(normalizeModel("@cf/meta/llama-3.2-3b-instruct")).toBe("cf");
	});
	it("defaults empty/nullish to the Anthropic default", () => {
		expect(normalizeModel("")).toBe("claude-sonnet-4-6");
		expect(normalizeModel(null)).toBe("claude-sonnet-4-6");
	});
});

describe("priceFor", () => {
	it("returns the known price for a mapped model", () => {
		expect(priceFor("claude-sonnet-4-6")).toEqual({ inputPerM: 3, outputPerM: 15 });
	});
	it("returns the ~free bucket for Workers AI", () => {
		expect(priceFor("@cf/meta/llama-4-scout-17b")).toEqual({ inputPerM: 0, outputPerM: 0 });
	});
	it("falls back to DEFAULT_PRICE for an unknown model", () => {
		expect(priceFor("some-new-model-9000")).toBe(DEFAULT_PRICE);
	});
});

describe("estimateCostMicros", () => {
	it("computes tokens × per-M list price in micros", () => {
		// 1M input @ $3 + 1M output @ $15 = $18 = 18_000_000 micros
		expect(estimateCostMicros("claude-sonnet-4-6", 1_000_000, 1_000_000)).toBe(18_000_000);
	});
	it("prices a realistic small call", () => {
		// 10k in @ $3/M = $0.03 = 30_000 micros; 2k out @ $15/M = $0.03 = 30_000 → 60_000
		expect(estimateCostMicros("claude-sonnet-4-6", 10_000, 2_000)).toBe(60_000);
	});
	it("is zero for Workers AI (per-neuron, not per-token)", () => {
		expect(estimateCostMicros("@cf/meta/llama-4-scout-17b", 50_000, 10_000)).toBe(0);
	});
	it("treats missing/garbage token counts as zero and never goes negative", () => {
		expect(estimateCostMicros("claude-sonnet-4-6", null, undefined)).toBe(0);
		expect(estimateCostMicros("claude-sonnet-4-6", -5, NaN)).toBe(0);
	});
	it("uses DEFAULT_PRICE for an unknown model so it is not silently free", () => {
		expect(estimateCostMicros("mystery-model", 1_000_000, 0)).toBe(3_000_000);
	});
});

describe("voice pricing", () => {
	it("prices TTS by exact character count ($15/1M chars)", () => {
		// 1M chars @ $15/M = $15 = 15_000_000 micros
		expect(estimateTtsMicros(1_000_000)).toBe(15_000_000);
		expect(estimateTtsMicros(1000)).toBe(15_000); // 1000 × 15
		expect(estimateTtsMicros(0)).toBe(0);
	});
	it("prices STT by minutes of audio ($0.006/min)", () => {
		// 60s = 1 min = $0.006 = 6000 micros
		expect(estimateSttMicros(60)).toBe(6000);
		expect(estimateSttMicros(0)).toBe(0);
	});
	it("estimates audio seconds from byte size", () => {
		expect(secondsFromAudioBytes(2500)).toBe(1);
		expect(secondsFromAudioBytes(25_000)).toBe(10);
		expect(secondsFromAudioBytes(0)).toBe(0);
	});
});

describe("formatUsd", () => {
	it("formats normal amounts to cents", () => {
		expect(formatUsd(1_234_567)).toBe("$1.23");
	});
	it("shows exact zero", () => {
		expect(formatUsd(0)).toBe("$0.00");
	});
	it("uses a <$0.01 floor for tiny non-zero amounts", () => {
		expect(formatUsd(500)).toBe("<$0.01");
	});
});

describe("prompt-cache pricing (#212)", () => {
	it("prices a cache READ at a tenth of input — the whole point of caching", () => {
		// 1M input tokens on sonnet = $3.00. The same tokens served from cache = $0.30.
		expect(estimateCostMicros("claude-sonnet-4-6", 1_000_000, 0)).toBe(3_000_000);
		expect(estimateCostMicros("claude-sonnet-4-6", 0, 0, { read: 1_000_000 })).toBe(300_000);
	});

	it("prices a cache WRITE at 1.25x — you pay a premium once to save 90% later", () => {
		expect(estimateCostMicros("claude-sonnet-4-6", 0, 0, { write: 1_000_000 })).toBe(3_750_000);
	});

	it("is unchanged for callers that pass no cache info", () => {
		// Every non-Anthropic path (Workers AI) has no prompt cache and must keep its old number.
		expect(estimateCostMicros("claude-sonnet-4-6", 1000, 100)).toBe(estimateCostMicros("claude-sonnet-4-6", 1000, 100, {}));
		expect(estimateCostMicros("@cf/meta/llama-3.2-3b-instruct", 1000, 100, { read: 5000 }))
			.toBeGreaterThanOrEqual(0);
	});

	it("stops overstating a mostly-cached call", () => {
		// The bug: input+read+write were summed and ALL priced at the input rate. A 10k-token
		// prompt that is 90% cache-read cost $0.030 on the old maths and really costs $0.0057 —
		// so the Usage page was reporting >5x the true figure for a well-cached agent.
		const wrong = estimateCostMicros("claude-sonnet-4-6", 10_000, 0);
		const right = estimateCostMicros("claude-sonnet-4-6", 1_000, 0, { read: 9_000 });
		expect(wrong).toBe(30_000);
		expect(right).toBe(5_700);
		expect(right).toBeLessThan(wrong / 5);
	});

	it("never returns a negative or fractional micro", () => {
		expect(estimateCostMicros("claude-sonnet-4-6", -5, -5, { read: -100, write: -100 })).toBe(0);
		expect(Number.isInteger(estimateCostMicros("claude-sonnet-4-6", 7, 3, { read: 11, write: 13 }))).toBe(true);
	});
});

