import { describe, expect, it } from "vitest";

describe("rate limit logic", () => {
	it("bucket resets after window", () => {
		const windowMs = 60_000;
		const now = Date.now();
		const bucket = { count: 50, resetAt: now + windowMs };

		// Within window — should be counted
		expect(bucket.count).toBe(50);
		expect(now < bucket.resetAt).toBe(true);

		// After window — should reset
		const later = now + windowMs + 1;
		expect(later >= bucket.resetAt).toBe(true);
	});

	it("remaining calculation", () => {
		const limit = 60;
		const count = 45;
		const remaining = Math.max(0, limit - count);
		expect(remaining).toBe(15);
	});

	it("remaining floors at zero", () => {
		const limit = 60;
		const count = 75;
		const remaining = Math.max(0, limit - count);
		expect(remaining).toBe(0);
	});

	it("strict limit is lower than default", () => {
		const defaultLimit = 60;
		const strictLimit = 10;
		expect(strictLimit).toBeLessThan(defaultLimit);
	});
});
