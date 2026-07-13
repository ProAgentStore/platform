import { describe, expect, it } from "vitest";
import { normalizeModel, priceFor, estimateCostMicros, formatUsd, DEFAULT_PRICE } from "./ai-pricing.js";

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
