import { describe, expect, it } from "vitest";
import { isTransientInfraError } from "./transient-error.js";

describe("isTransientInfraError", () => {
	it("matches a Durable Object reset from a code deploy", () => {
		expect(isTransientInfraError("Durable Object reset because its code was updated.")).toBe(true);
		expect(isTransientInfraError("The Durable Object has been reset")).toBe(true);
	});

	it("is case-insensitive and tolerant of null", () => {
		expect(isTransientInfraError("durable object RESET because its CODE WAS UPDATED")).toBe(true);
		expect(isTransientInfraError("")).toBe(false);
		// @ts-expect-error — guards against a non-string at runtime
		expect(isTransientInfraError(undefined)).toBe(false);
	});

	it("does NOT match a genuine application bug", () => {
		expect(isTransientInfraError("TypeError: cannot read property 'x' of undefined")).toBe(false);
		expect(isTransientInfraError("No API key configured")).toBe(false);
		expect(isTransientInfraError("stuck not resolved in time")).toBe(false);
	});
});
