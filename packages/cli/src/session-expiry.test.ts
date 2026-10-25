import { describe, expect, it } from "vitest";
import { expiryLine, expiryWarner, expiryWarning, readExpiry } from "./session-expiry.js";

const DAY = 24 * 3600_000;
const NOW = Date.parse("2026-10-25T00:00:00Z");
const at = (days: number) => NOW + days * DAY;

describe("readExpiry (#1184)", () => {
	it("puts the time left in the smallest tier that contains it: 30, 7 or 1 day", () => {
		expect(readExpiry(at(90), NOW)).toMatchObject({ daysLeft: 90, tier: null, expired: false });
		expect(readExpiry(at(30), NOW)).toMatchObject({ tier: 30 });
		expect(readExpiry(at(29.5), NOW)).toMatchObject({ tier: 30, daysLeft: 30 });
		expect(readExpiry(at(8), NOW)).toMatchObject({ tier: 30 });
		expect(readExpiry(at(7), NOW)).toMatchObject({ tier: 7 });
		expect(readExpiry(at(2), NOW)).toMatchObject({ tier: 7, daysLeft: 2 });
		expect(readExpiry(at(1), NOW)).toMatchObject({ tier: 1 });
		expect(readExpiry(NOW + 3 * 3600_000, NOW)).toMatchObject({ tier: 1, daysLeft: 1 });
	});
	it("is expired at and after the moment, with no tier; unreadable is null", () => {
		expect(readExpiry(NOW, NOW)).toMatchObject({ expired: true, tier: null });
		expect(readExpiry(at(-3), NOW)).toMatchObject({ expired: true });
		expect(readExpiry(null, NOW)).toBeNull();
		expect(readExpiry(Number.NaN, NOW)).toBeNull();
	});
});

describe("what the owner is told", () => {
	it("always says when the sign-in runs out", () => {
		expect(expiryLine(at(29.5), NOW)).toBe("Signed in until 2026-11-23 (30 days)");
		expect(expiryLine(at(1), NOW)).toBe("Signed in until 2026-10-26 (1 day)");
		expect(expiryLine(at(-1), NOW)).toBe("Sign-in expired on 2026-10-24");
		expect(expiryLine(null, NOW)).toBe("Sign-in expiry: unknown");
	});
	it("warns at 30, 7 and 1 days with what to do, and says plainly when it has expired", () => {
		expect(expiryWarning(at(120), NOW)).toBeNull();
		expect(expiryWarning(at(30), NOW)).toMatch(/expires in 30 days.*pags login --device.*pags devices/);
		expect(expiryWarning(at(7), NOW)).toMatch(/expires in 7 days/);
		expect(expiryWarning(at(0.5), NOW)).toMatch(/expires within a day/);
		expect(expiryWarning(at(-1), NOW)).toMatch(/has expired/);
		expect(expiryWarning(null, NOW)).toBeNull();
	});
	it("a long-running process warns once per tier, not on every check", () => {
		const warn = expiryWarner();
		expect(warn(at(90), NOW)).toBeNull();
		expect(warn(at(29), NOW)).toMatch(/30 days|29 days/);
		expect(warn(at(28), NOW)).toBeNull(); // still the 30-day tier
		expect(warn(at(6), NOW)).toMatch(/6 days/);
		expect(warn(at(5), NOW)).toBeNull();
		expect(warn(at(0.4), NOW)).toMatch(/within a day/);
		expect(warn(at(-1), NOW)).toMatch(/has expired/);
		expect(warn(at(-2), NOW)).toBeNull();
	});
});
