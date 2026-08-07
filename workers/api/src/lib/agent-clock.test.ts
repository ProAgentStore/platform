/**
 * The clock block (#329).
 *
 * Every assertion pins a fixed instant. The bug being fixed is about times meaning different things
 * to different readers, so a test that reads the machine's own clock would be the same mistake in
 * miniature — and the DST cases below only exist because they can be pinned either side of a
 * transition.
 */
import { describe, expect, it } from "vitest";
import { clockPrompt, formatInZone, utcOffsetLabel } from "./agent-clock.js";
import { parseAccountPreferences } from "./preferences.js";

/** 2026-08-06T22:34:19Z — the instant from the report in #329, to the second. */
const REPORTED = Date.parse("2026-08-06T22:34:19Z");

describe("formatInZone — a wall clock the model can only repeat", () => {
	it("renders the reported instant in the user's zone, with the zone named", () => {
		// 22:34 UTC on the 6th is 08:34 on the 7th in Sydney. Both the HOUR and the DAY differ, which
		// is the whole complaint: "the run completed at 22:34 today" was a claim about a different day.
		const s = formatInZone(REPORTED, "Australia/Sydney");
		expect(s).toContain("08:34");
		expect(s).toContain("7 Aug 2026");
		expect(s).toMatch(/AE[SD]T|GMT\+10/);
	});

	it("names the zone in every rendering — a bare local time is the thing being fixed", () => {
		for (const zone of ["America/New_York", "Europe/London", "Asia/Kolkata", "UTC"]) {
			// A time with no zone attached is exactly as ambiguous as the UTC one it replaces.
			expect(formatInZone(REPORTED, zone).replace(/[\d:, ]/g, "")).not.toBe("");
		}
	});

	it("throws on a zone the runtime cannot resolve, rather than silently using UTC", () => {
		expect(() => formatInZone(REPORTED, "Australia/Melbourn")).toThrow();
	});
});

describe("utcOffsetLabel — the offset the model is allowed to convert with", () => {
	it("is signed, zero-padded, and right for a whole-hour zone", () => {
		expect(utcOffsetLabel(REPORTED, "Australia/Sydney")).toBe("+10:00");
		expect(utcOffsetLabel(REPORTED, "UTC")).toBe("+00:00");
		expect(utcOffsetLabel(REPORTED, "America/New_York")).toBe("-04:00");
	});

	it("survives a sub-hour offset — the case a minutes-rounding bug eats", () => {
		// Kathmandu is +05:45. Computed from a millisecond-bearing instant, an unrounded difference
		// renders +05:44.
		expect(utcOffsetLabel(REPORTED, "Asia/Kathmandu")).toBe("+05:45");
		expect(utcOffsetLabel(Date.parse("2026-08-06T22:34:19.937Z"), "Asia/Kathmandu")).toBe("+05:45");
	});

	it("follows daylight saving rather than treating the offset as a property of the zone", () => {
		// Sydney: +10:00 in August (winter), +11:00 in January (summer). This is the arithmetic the
		// prompt refuses to hand the model for distant timestamps, so the value it DOES hand over has
		// to be right for the instant it names.
		expect(utcOffsetLabel(Date.parse("2026-01-15T00:00:00Z"), "Australia/Sydney")).toBe("+11:00");
		expect(utcOffsetLabel(Date.parse("2026-11-01T05:00:00Z"), "America/New_York")).toBe("-04:00");
		expect(utcOffsetLabel(Date.parse("2026-11-02T05:00:00Z"), "America/New_York")).toBe("-05:00");
	});
});

describe("clockPrompt — unset is a first-class state", () => {
	const set = clockPrompt(REPORTED, "Australia/Sydney");
	const unset = clockPrompt(REPORTED);

	it("emits a clock either way, because 'what time is it' has no unset state", () => {
		// The two questions are separate. Only "which zone is the user in" can be unanswered; the
		// current instant is always knowable, and #329's title is that no prompt had a clock at all.
		expect(set).toContain("## Current time");
		expect(unset).toContain("## Current time");
	});

	it("names the user's zone and the offset when one is set", () => {
		expect(set).toContain("Australia/Sydney");
		expect(set).toContain("UTC+10:00");
		expect(set).toContain("08:34");
	});

	it("invents nothing when the zone is unset — UTC, said out loud", () => {
		expect(unset).toContain("22:34");
		expect(unset).toContain("UTC");
		// No zone is asserted, and the model is told that no zone was asserted. A guessed local time
		// is worse than an honest UTC, which is the ticket's own finding.
		expect(unset).toMatch(/have NOT been told the user's timezone/);
		expect(unset).toMatch(/Do NOT guess a local time/i);
		expect(unset).not.toContain("Australia");
	});

	it("tells the model to repeat a zone, never to compute a distant one", () => {
		// The design point of #329: timezone arithmetic is what a model does *almost* right, and an
		// hour wrong stated confidently is worse than UTC stated honestly.
		expect(set).toMatch(/daylight saving/);
		expect(set).toMatch(/say it is UTC rather than guessing/);
	});
});

describe("where the zone comes from", () => {
	it("rides on the account preferences blob, needing no migration", () => {
		const prefs = parseAccountPreferences(JSON.stringify({ timezone: "Australia/Sydney" }));
		expect(prefs.timezone).toBe("Australia/Sydney");
	});

	it("an absent or unresolvable zone parses to undefined, not to UTC", () => {
		// `"UTC"` and `undefined` must stay distinguishable: one is a user who lives in UTC, the other
		// is a user nobody asked. Collapsing them is how the guessed-default bug gets reintroduced.
		expect(parseAccountPreferences("{}").timezone).toBeUndefined();
		expect(parseAccountPreferences(JSON.stringify({ timezone: "AEST" })).timezone).toBeUndefined();
		expect(parseAccountPreferences(JSON.stringify({ timezone: "" })).timezone).toBeUndefined();
		expect(parseAccountPreferences(null).timezone).toBeUndefined();
		expect(parseAccountPreferences(JSON.stringify({ timezone: "UTC" })).timezone).toBe("UTC");
	});

	it("does not disturb the voice and translation sections it sits beside", () => {
		const prefs = parseAccountPreferences(JSON.stringify({ timezone: "Europe/London", voice: { speed: 130 } }));
		expect(prefs.timezone).toBe("Europe/London");
		expect(prefs.voice?.speed).toBe(130);
	});
});
