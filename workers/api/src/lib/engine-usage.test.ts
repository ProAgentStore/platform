import { describe, expect, it } from "vitest";
import { engineUsageRowId, sanitizeEngineUsage } from "./engine-usage.js";

/** A well-formed record as the runner sends it. */
const rec = (over: Record<string, unknown> = {}) => ({
	id: "uuid-1", model: "claude-opus-5", inputTokens: 2, outputTokens: 4,
	cacheReadTokens: 15273, cacheWriteTokens: 12701, costUsd: 0.1347565, ...over,
});

describe("sanitizeEngineUsage", () => {
	it("passes a well-formed record through intact", () => {
		expect(sanitizeEngineUsage([rec()])).toEqual([rec({ provider: "anthropic" })]);
	});

	it("is empty for a non-array — a runner that reports nothing must yield no rows", () => {
		// The runner omits `usage` entirely unless the caller asked to drain, and omits it for a
		// raw engine even then. Every one of those must produce zero ledger rows, not a zero row:
		// a $0.00 "engine" entry reads as "this engine is free", which is worse than absent (#267).
		expect(sanitizeEngineUsage(undefined)).toEqual([]);
		expect(sanitizeEngineUsage(null)).toEqual([]);
		expect(sanitizeEngineUsage({})).toEqual([]);
		expect(sanitizeEngineUsage([])).toEqual([]);
	});

	it("drops an all-zero record rather than writing a fabricated zero", () => {
		expect(sanitizeEngineUsage([rec({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 })])).toEqual([]);
	});

	it("keeps a record with cost but no tokens, and tokens but no cost", () => {
		// Both halves are independently reportable: an older CLI may omit `total_cost_usd`, and a
		// fully-cached turn can report cost with input_tokens 0. Requiring both would silently
		// drop real spend.
		expect(sanitizeEngineUsage([rec({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })])).toHaveLength(1);
		expect(sanitizeEngineUsage([rec({ costUsd: 0 })])).toHaveLength(1);
	});

	it("keeps the reported provider for structured non-Claude engines", () => {
		expect(sanitizeEngineUsage([rec({ provider: "openai", model: "codex", costUsd: 0 })])[0]).toMatchObject({
			provider: "openai",
			model: "codex",
			inputTokens: 2,
			costUsd: 0,
		});
	});

	it("defaults older runner records to Claude's provider and rejects unknown providers", () => {
		expect(sanitizeEngineUsage([rec()])[0].provider).toBe("anthropic");
		expect(sanitizeEngineUsage([rec({ provider: "filecoin" })])[0].provider).toBe("anthropic");
	});

	it("drops a record with no id — there would be no dedup key", () => {
		// The ledger's idempotency is the deterministic primary key. A row without one would be
		// re-inserted on every retry, so it double-counts; that is worse than the gap it fills.
		expect(sanitizeEngineUsage([rec({ id: "" })])).toEqual([]);
		expect(sanitizeEngineUsage([rec({ id: 42 })])).toEqual([]);
	});

	it("collapses duplicate ids within one drain", () => {
		expect(sanitizeEngineUsage([rec(), rec()])).toHaveLength(1);
	});

	it("coerces junk types to zero instead of letting NaN reach cost_micros", () => {
		// The payload crosses the relay from a machine we do not control. `Math.round(NaN * 1e6)`
		// is NaN, which D1 would store as a null/0 and quietly corrupt the account total.
		const [out] = sanitizeEngineUsage([rec({ inputTokens: "abc", outputTokens: -5, costUsd: "1e999" })]);
		expect(out.inputTokens).toBe(0);
		expect(out.outputTokens).toBe(0);
		expect(Number.isFinite(out.costUsd)).toBe(true);
	});

	it("caps an absurd single-turn cost rather than poisoning the total", () => {
		expect(sanitizeEngineUsage([rec({ costUsd: 5_000_000 })])[0].costUsd).toBe(1000);
	});

	it("caps how many records one drain can insert", () => {
		const many = Array.from({ length: 500 }, (_, i) => rec({ id: `u${i}` }));
		expect(sanitizeEngineUsage(many).length).toBeLessThanOrEqual(200);
	});

	it("falls back to a model label instead of an empty string", () => {
		expect(sanitizeEngineUsage([rec({ model: "" })])[0].model).toBe("unknown");
		expect(sanitizeEngineUsage([rec({ model: 7 })])[0].model).toBe("unknown");
	});
});

describe("engineUsageRowId", () => {
	it("is deterministic — the same turn reported twice yields one key", () => {
		// This is what makes re-reporting safe: the capture poll and the Pilot's own capture can
		// both drain and write, and INSERT OR IGNORE turns the race into a no-op.
		expect(engineUsageRowId("s1", "uuid-1")).toBe(engineUsageRowId("s1", "uuid-1"));
	});

	it("namespaces by session so two sessions cannot collide on a CLI-supplied uuid", () => {
		expect(engineUsageRowId("s1", "uuid-1")).not.toBe(engineUsageRowId("s2", "uuid-1"));
	});
});
