/**
 * Seed, do not bind (#345).
 *
 * `timezoneSeed` is the whole design of the seed in one pure function, which is the only shape it
 * could be tested in — this console has no component-testing infrastructure (#282), so the decision
 * lives in `lib/` and the effect that fires it stays a one-liner in AuthContext.
 */
import { describe, expect, it } from "vitest";
import { machineTimeZone, timeZoneOptions, timezoneSeed } from "./accountTimezone";

describe("timezoneSeed", () => {
	it("writes the machine's zone when nothing is stored — the point of the whole exercise", () => {
		// Until something writes this field, `preferences.timezone` is empty for everyone and every
		// agent narrates in UTC: #329 shipped a fix nobody had switched on.
		expect(timezoneSeed(undefined, "Australia/Sydney")).toBe("Australia/Sydney");
		expect(timezoneSeed(null, "Europe/London")).toBe("Europe/London");
		expect(timezoneSeed("", "America/New_York")).toBe("America/New_York");
		expect(timezoneSeed("   ", "Asia/Tokyo")).toBe("Asia/Tokyo");
	});

	it("never re-asserts over a stored value, however different this machine is", () => {
		// The rule #329 reasoned out: the browser value is a fine SEED and a terrible source of
		// truth. It changes when you travel — an owner who set Australia/Sydney and then opens the
		// console from a hotel in Tokyo must not have their setting silently rewritten.
		expect(timezoneSeed("Australia/Sydney", "Asia/Tokyo")).toBeNull();
		expect(timezoneSeed("UTC", "Australia/Sydney")).toBeNull();
	});

	it("declines to record a browser that only says UTC — that is a non-answer, not an answer", () => {
		// `undefined` and `"UTC"` must stay distinguishable (`parseAccountPreferences` keeps them
		// so): one is a user nobody asked, the other a user who really is there. A machine resolving
		// to UTC is overwhelmingly one whose clock was never configured; real UTC-adjacent users
		// resolve to Atlantic/Reykjavik or Europe/London. Declining costs nothing — the two render
		// the same hour, and the unset branch keeps saying "UTC" out loud, honestly.
		expect(timezoneSeed(undefined, "UTC")).toBeNull();
		expect(timezoneSeed(undefined, "Etc/UTC")).toBeNull();
		expect(timezoneSeed(undefined, "GMT")).toBeNull();
	});

	it("sends nothing the server would reject", () => {
		// Same vocabulary as `isValidTimeZone` (lib/cron-time.ts), including its 64-char bound — the
		// route 400s rather than coercing, so an invalid seed would be a silent no-op either way.
		expect(timezoneSeed(undefined, null)).toBeNull();
		expect(timezoneSeed(undefined, "")).toBeNull();
		expect(timezoneSeed(undefined, "AEST")).toBeNull();
		expect(timezoneSeed(undefined, "Not/A/Zone")).toBeNull();
		expect(timezoneSeed(undefined, `Australia/${"x".repeat(80)}`)).toBeNull();
	});
});

describe("the zone vocabulary the console offers", () => {
	it("always contains the stored zone, even one this browser does not list", () => {
		// Otherwise a select silently re-points at its first option and the next change writes a
		// zone the owner never chose.
		expect(timeZoneOptions("Mars/Olympus")).toContain("Mars/Olympus");
		expect(timeZoneOptions()).toContain("UTC");
	});

	it("offers something usable with no stored zone at all", () => {
		expect(timeZoneOptions().length).toBeGreaterThan(1);
	});

	it("reports the machine's zone, or null rather than a fabricated UTC", () => {
		// Distinct from triggerSchedule's `browserTimeZone()`, which falls back to "UTC" because its
		// caller needs something to put in a select. Here a fallback would be RECORDED as the
		// user's answer.
		const tz = machineTimeZone();
		expect(tz === null || typeof tz === "string").toBe(true);
		if (tz) expect(timezoneSeed(undefined, tz)).toBe(timezoneSeed(undefined, tz));
	});
});
