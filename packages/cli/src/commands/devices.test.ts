import { describe, expect, it } from "vitest";
import { deviceLines, LIFETIME_CHOICES, parseLifetime } from "./devices.js";

describe("pags devices (#1184)", () => {
	it("lists each machine with its id, expiry and status, and says what new sign-ins last", () => {
		const lines = deviceLines(
			[
				{ id: "dev_a", node: "dell-laptop", lifetimeDays: 90, expiresAt: "2027-01-23T00:00:00.000Z", status: "active" },
				{ id: "dev_b", node: null, lifetimeDays: 30, expiresAt: "2026-11-01T00:00:00.000Z", status: "revoked" },
			],
			90,
		);
		expect(lines[0]).toMatch(/last 90 days.*pags devices lifetime/);
		expect(lines[1]).toMatch(/^active\s+dell-laptop\s+dev_a\s+until 2027-01-23 \(90-day sign-in\)/);
		expect(lines[2]).toMatch(/^revoked\s+\(unnamed\)\s+dev_b\s+revoked/);
	});
	it("says so when no machine has signed in by device login", () => {
		expect(deviceLines([], 30)).toEqual([expect.stringMatching(/No machines are signed in.*30 days/)]);
	});
	it("accepts only the lengths the API does", () => {
		expect(LIFETIME_CHOICES).toEqual([30, 90, 180]);
		for (const ok of ["30", "90", "180"]) expect(parseLifetime(ok)).toBe(Number(ok));
		for (const bad of ["0", "7", "365", "ninety", "", undefined]) expect(parseLifetime(bad)).toBeNull();
	});
});
