import { describe, it, expect } from "vitest";
import { isProviderStallError, STALL_MAX_RETRIES, STALL_BACKOFF_MS, STALL_RETRY_CEILING_MS } from "./provider-stall-policy.js";

/**
 * Tests for resilient handling of transient provider stream stalls (#907).
 *
 * These unit tests verify the stall detection and policy constants are correct.
 * Integration tests that verify the retry logic works end-to-end are in
 * `user-ai-stall.test.ts` and related test files.
 */

describe("Provider stall retry policy (#907)", () => {
	it("detects stall errors correctly", () => {
		const stallError1 = new Error("The AI provider stopped sending mid-reply — 20s with no bytes received after the reply had begun.");
		const stallError2 = new Error("The connection to the AI provider ended mid-reply, so the answer was cut off rather than slow.");
		const credentialsError = new Error("Invalid API key");
		const nonError = "not an error";

		expect(isProviderStallError(stallError1)).toBe(true);
		expect(isProviderStallError(stallError2)).toBe(true);
		expect(isProviderStallError(credentialsError)).toBe(false);
		expect(isProviderStallError(nonError)).toBe(false);
	});

	it("policy constants are sensible", () => {
		// Verify the policy is configured correctly
		expect(STALL_MAX_RETRIES).toBeGreaterThanOrEqual(1);
		expect(STALL_BACKOFF_MS.length).toBeGreaterThanOrEqual(STALL_MAX_RETRIES - 1);

		// Backoff should be monotonically increasing (or stay the same)
		for (let i = 1; i < STALL_BACKOFF_MS.length; i++) {
			expect(STALL_BACKOFF_MS[i]).toBeGreaterThanOrEqual(STALL_BACKOFF_MS[i - 1]);
		}

		// Total backoff should be less than the ceiling
		const totalBackoff = STALL_BACKOFF_MS.reduce((a, b) => a + b, 0);
		expect(totalBackoff).toBeLessThan(STALL_RETRY_CEILING_MS);
	});

	it("stall parameters are bounded", () => {
		expect(STALL_MAX_RETRIES).toBeLessThanOrEqual(10);
		expect(STALL_RETRY_CEILING_MS).toBeGreaterThan(5_000);
		expect(STALL_RETRY_CEILING_MS).toBeLessThanOrEqual(60_000);
	});
});
