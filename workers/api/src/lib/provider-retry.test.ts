/**
 * #1391 — the retry policy: defaults, what an owner may set, and a backoff that is exponential, spread, bounded and — because the workflow that
 * parks on it is replayed — the same instant every time it is computed for the same run.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_RETRY, fallbackModelProblem, PROVIDER_RETRY_BOUNDS, providerRetryView, resolveProviderRetry, retryDelayMs, retrySchedule, sanitizeProviderRetry, sayWait } from "./provider-retry.js";

describe("the defaults", () => {
	it("are four waits — 2, 4, 8 then the 15-minute ceiling — spread 20% (the issue asks for 3-5 attempts)", () => {
		expect(DEFAULT_PROVIDER_RETRY).toEqual({ attempts: 4, baseMs: 120_000, maxMs: 900_000, jitter: 0.2, fallbackModel: null });
		expect(retrySchedule(DEFAULT_PROVIDER_RETRY)).toEqual([120_000, 240_000, 480_000, 900_000]);
	});
});

describe("sanitizeProviderRetry — what an owner may set", () => {
	it("keeps the recognised numeric fields and nothing else", () => {
		expect(sanitizeProviderRetry({ attempts: 5, baseMs: 30_000, maxMs: 600_000, jitter: 0.1, fallbackModel: "gpt-x", extra: 1 })).toEqual({ attempts: 5, baseMs: 30_000, maxMs: 600_000, jitter: 0.1, fallbackModel: "gpt-x" });
	});

	it("clamps each field to its bound instead of refusing", () => {
		const b = PROVIDER_RETRY_BOUNDS;
		expect(sanitizeProviderRetry({ attempts: 0 })).toEqual({ attempts: b.attempts.min });
		expect(sanitizeProviderRetry({ attempts: 99 })).toEqual({ attempts: b.attempts.max });
		expect(sanitizeProviderRetry({ baseMs: 1 })).toEqual({ baseMs: b.baseMs.min });
		expect(sanitizeProviderRetry({ baseMs: 10 ** 9 })).toEqual({ baseMs: b.baseMs.max });
		expect(sanitizeProviderRetry({ jitter: 5 })).toEqual({ jitter: b.jitter.max });
		expect(sanitizeProviderRetry({ jitter: -1 })).toEqual({ jitter: 0 });
	});

	it("rounds a fraction of an attempt or a millisecond", () => {
		expect(sanitizeProviderRetry({ attempts: 3.6, baseMs: 60_000.4 })).toEqual({ attempts: 4, baseMs: 60_000 });
	});

	it("drops strings, NaN, null and booleans rather than guessing — a hand-edited blob degrades to the defaults", () => {
		expect(sanitizeProviderRetry({ attempts: "5", baseMs: Number.NaN, maxMs: null, jitter: true })).toEqual({});
	});

	it("a value that is not an object is no override", () => {
		for (const v of [null, undefined, "x", 5, [], [1, 2]]) expect(sanitizeProviderRetry(v), String(v)).toEqual({});
	});

	it("a ceiling below the first wait is raised to it, so the ladder always climbs", () => {
		expect(sanitizeProviderRetry({ baseMs: 300_000, maxMs: 60_000 })).toEqual({ baseMs: 300_000, maxMs: 300_000 });
	});
});

describe("resolveProviderRetry — the policy a run uses", () => {
	it("is the defaults with the instance's own fields on top", () => {
		expect(resolveProviderRetry(null)).toEqual(DEFAULT_PROVIDER_RETRY);
		expect(resolveProviderRetry({})).toEqual(DEFAULT_PROVIDER_RETRY);
		expect(resolveProviderRetry({ attempts: 2 })).toEqual({ ...DEFAULT_PROVIDER_RETRY, attempts: 2 });
	});

	it("an override of the first wait alone cannot leave the ceiling beneath it, nor of the ceiling alone leave the first wait above it", () => {
		expect(resolveProviderRetry({ baseMs: 600_000 }).maxMs).toBeGreaterThanOrEqual(600_000);
		const lowCeiling = resolveProviderRetry({ maxMs: 30_000 });
		expect(lowCeiling.baseMs).toBeLessThanOrEqual(lowCeiling.maxMs);
	});
});

describe("retryDelayMs — exponential, capped, spread, deterministic", () => {
	const policy = { attempts: 6, baseMs: 60_000, maxMs: 600_000, jitter: 0.25, fallbackModel: null };

	it("doubles per wait and stops at the ceiling (no seed: the exact backoff)", () => {
		expect([0, 1, 2, 3, 4, 5].map((i) => retryDelayMs(i, policy))).toEqual([60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
	});

	it("a negative or fractional attempt count is treated as the first", () => {
		expect(retryDelayMs(-3, policy)).toBe(60_000);
		expect(retryDelayMs(0.9, policy)).toBe(60_000);
	});

	it("the same seed and attempt always give the same wait; a different seed gives a different one", () => {
		expect(retryDelayMs(2, policy, "run-1")).toBe(retryDelayMs(2, policy, "run-1"));
		const waits = new Set(["run-1", "run-2", "run-3", "run-4", "run-5"].map((s) => retryDelayMs(2, policy, s)));
		expect(waits.size).toBeGreaterThan(1);
	});

	it("never strays beyond the spread and never exceeds the ceiling, across many runs and attempts", () => {
		for (let r = 0; r < 200; r++) {
			for (let i = 0; i < 6; i++) {
				const exact = retryDelayMs(i, policy);
				const ms = retryDelayMs(i, policy, `run-${r}`);
				expect(ms).toBeGreaterThanOrEqual(Math.floor(exact * 0.75));
				expect(ms).toBeLessThanOrEqual(Math.min(policy.maxMs, Math.ceil(exact * 1.25)));
			}
		}
	});

	it("actually spreads: over many runs the first wait covers both sides of the exact backoff", () => {
		const first = Array.from({ length: 200 }, (_, r) => retryDelayMs(0, policy, `run-${r}`));
		expect(Math.min(...first)).toBeLessThan(60_000);
		expect(Math.max(...first)).toBeGreaterThan(60_000);
	});

	it("jitter 0 is the exact backoff whatever the seed", () => {
		expect(retryDelayMs(1, { ...policy, jitter: 0 }, "any")).toBe(120_000);
	});

	it("is never shorter than a second", () => {
		expect(retryDelayMs(0, { attempts: 1, baseMs: 5_000, maxMs: 5_000, jitter: 0.5, fallbackModel: null }, "x")).toBeGreaterThanOrEqual(1_000);
	});
});

describe("retrySchedule and sayWait", () => {
	it("lists one wait per attempt", () => {
		expect(retrySchedule({ attempts: 3, baseMs: 60_000, maxMs: 900_000, jitter: 0, fallbackModel: null })).toEqual([60_000, 120_000, 240_000]);
		expect(retrySchedule({ attempts: 3, baseMs: 60_000, maxMs: 900_000, jitter: 0.2, fallbackModel: null }, "run-1")).toHaveLength(3);
	});

	it("says a wait the way a person would", () => {
		expect(sayWait(120_000)).toBe("2 min");
		expect(sayWait(45_000)).toBe("45 s");
		expect(sayWait(900_000)).toBe("15 min");
	});
});

describe("providerRetryView — what the limits routes read back", () => {
	it("is the effective policy with the waits it serves; the defaults when nothing is set", () => {
		expect(providerRetryView({})).toEqual({ effectiveProviderRetry: { ...DEFAULT_PROVIDER_RETRY, scheduleMs: [120_000, 240_000, 480_000, 900_000] } });
		expect(providerRetryView({ providerRetry: { attempts: 2, baseMs: 30_000 } }).effectiveProviderRetry).toMatchObject({ attempts: 2, baseMs: 30_000, scheduleMs: [30_000, 60_000] });
	});
});

describe("the fallback model is opt-in and only ever what the owner wrote (#1392)", () => {
	it("is OFF by default: no model, not even in the policy a run resolves", () => {
		expect(DEFAULT_PROVIDER_RETRY.fallbackModel).toBeNull();
		expect(resolveProviderRetry(null).fallbackModel).toBeNull();
		expect(resolveProviderRetry({ attempts: 5 }).fallbackModel).toBeNull();
		expect(providerRetryView({}).effectiveProviderRetry.fallbackModel).toBeNull();
	});

	it("keeps a real model id and nothing else — a typo cannot become a fragment of a command line", () => {
		expect(sanitizeProviderRetry({ fallbackModel: "gpt-5.1-codex-mini" })).toEqual({ fallbackModel: "gpt-5.1-codex-mini" });
		expect(sanitizeProviderRetry({ fallbackModel: "claude-opus-5[1m]" })).toEqual({ fallbackModel: "claude-opus-5[1m]" });
		for (const bad of ["", " ", "gpt 5", "gpt-5 --dangerously", "a;b", "$(id)", '"x"', "x".repeat(101), 5, true, null, [], {}]) {
			expect(sanitizeProviderRetry({ fallbackModel: bad }), JSON.stringify(bad)).toEqual({});
		}
	});

	it("reaches the resolved policy and the read-back view", () => {
		expect(resolveProviderRetry({ fallbackModel: "gpt-x" }).fallbackModel).toBe("gpt-x");
		expect(providerRetryView({ providerRetry: { fallbackModel: "gpt-x" } }).effectiveProviderRetry).toMatchObject({ fallbackModel: "gpt-x", attempts: 4 });
	});

	it("fallbackModelProblem names what is wrong with a value, and accepts null (no fallback)", () => {
		expect(fallbackModelProblem(null)).toBeNull();
		expect(fallbackModelProblem("gpt-x")).toBeNull();
		for (const bad of ["gpt x", "", 7, undefined, "$(rm -rf /)"]) expect(fallbackModelProblem(bad), String(bad)).toMatch(/fallbackModel must be a model id/);
	});
});
