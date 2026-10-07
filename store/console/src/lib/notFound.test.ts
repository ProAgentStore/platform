import { describe, expect, it } from "vitest";
import { isNotFoundError } from "./notFound";

describe("isNotFoundError (#894)", () => {
	it("is a 404 and nothing else — a blip must never read as 'this no longer exists'", () => {
		expect(isNotFoundError(Object.assign(new Error("Agent not found"), { status: 404 }))).toBe(true);
		expect(isNotFoundError(Object.assign(new Error("boom"), { status: 500 }))).toBe(false);
		expect(isNotFoundError(Object.assign(new Error("unauthorized"), { status: 401 }))).toBe(false);
		expect(isNotFoundError(new TypeError("fetch failed"))).toBe(false);
		expect(isNotFoundError(null)).toBe(false);
	});
});
