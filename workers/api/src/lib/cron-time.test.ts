import { describe, expect, it } from "vitest";
import {
	cronFields,
	isValidTimeZone,
	matchesCronField,
	nextCronInstant,
	resolveWallTime,
	wallPartsInZone,
	zoneOffsetMs,
} from "./cron-time.js";

/** Read an instant back as wall clock in a zone — how a user would check the answer. */
function localOf(iso: string, tz: string): string {
	const p = wallPartsInZone(new Date(iso), tz);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

describe("timezone validation", () => {
	it("accepts IANA zones and UTC", () => {
		expect(isValidTimeZone("Australia/Melbourne")).toBe(true);
		expect(isValidTimeZone("UTC")).toBe(true);
		expect(isValidTimeZone("America/New_York")).toBe(true);
	});

	it("rejects anything the runtime does not know", () => {
		// A typo'd zone quietly meaning UTC is precisely the lie this exists to prevent.
		expect(isValidTimeZone("Australia/Melbourn")).toBe(false);
		expect(isValidTimeZone("AEST")).toBe(false);
		expect(isValidTimeZone("")).toBe(false);
		expect(isValidTimeZone(undefined)).toBe(false);
		expect(isValidTimeZone(42)).toBe(false);
	});
});

describe("zone offsets", () => {
	it("tracks the southern-hemisphere DST swing", () => {
		// Melbourne is +10 in July (standard) and +11 in January (daylight).
		expect(zoneOffsetMs(new Date("2026-07-01T00:00:00Z"), "Australia/Melbourne")).toBe(10 * 3_600_000);
		expect(zoneOffsetMs(new Date("2026-01-01T00:00:00Z"), "Australia/Melbourne")).toBe(11 * 3_600_000);
	});

	it("is zero for UTC", () => {
		expect(zoneOffsetMs(new Date("2026-07-01T00:00:00Z"), "UTC")).toBe(0);
	});
});

describe("resolveWallTime", () => {
	it("round-trips an ordinary wall time", () => {
		const wall = Date.UTC(2026, 6, 12, 8, 0); // 2026-07-12 08:00 local
		const { instant, exact } = resolveWallTime(wall, "Australia/Melbourne");
		expect(exact).toBe(true);
		expect(new Date(instant).toISOString()).toBe("2026-07-11T22:00:00.000Z"); // 08:00 +10
	});

	it("reports a spring-forward gap as inexact rather than pretending", () => {
		// 2026-10-04, Melbourne clocks jump 02:00 → 03:00. 02:30 never happens that day.
		const wall = Date.UTC(2026, 9, 4, 2, 30);
		const { exact } = resolveWallTime(wall, "Australia/Melbourne");
		expect(exact).toBe(false);
	});
});

describe("nextCronInstant", () => {
	const fields = cronFields("0 8 * * *");

	it("matches the wall clock in the requested zone", () => {
		const from = new Date("2026-07-12T00:00:00Z"); // 10:00 local, already past 08:00
		const next = nextCronInstant(fields, from, "Australia/Melbourne");
		expect(next).not.toBeNull();
		expect(localOf(new Date(next as number).toISOString(), "Australia/Melbourne")).toBe("2026-07-13 08:00");
	});

	it("holds 08:00 LOCAL across the DST boundary — the UTC instant moves, the clock time does not", () => {
		// This is the entire point of #18. A fixed UTC cron would have drifted to 09:00 local.
		// Melbourne enters daylight time on 2026-10-04 (+10 → +11). One `from` either side, each
		// early in its local morning so the answer is that same day's 08:00.
		const beforeDst = nextCronInstant(fields, new Date("2026-10-02T20:00:00Z"), "Australia/Melbourne") as number;
		const afterDst = nextCronInstant(fields, new Date("2026-10-04T19:00:00Z"), "Australia/Melbourne") as number;
		expect(localOf(new Date(beforeDst).toISOString(), "Australia/Melbourne")).toBe("2026-10-03 08:00");
		expect(localOf(new Date(afterDst).toISOString(), "Australia/Melbourne")).toBe("2026-10-05 08:00");
		// +10 before, +11 after: the same wall clock, two different UTC instants.
		expect(new Date(beforeDst).toISOString()).toBe("2026-10-02T22:00:00.000Z");
		expect(new Date(afterDst).toISOString()).toBe("2026-10-04T21:00:00.000Z");
	});

	it("does NOT skip a day when the scheduled wall time falls in the spring-forward gap", () => {
		// A daily digest silently missing once a year reads as a broken agent, so a gap places
		// the run at the nearest real instant instead of dropping it.
		const gapFields = cronFields("30 2 * * *");
		const next = nextCronInstant(gapFields, new Date("2026-10-03T10:00:00Z"), "Australia/Melbourne") as number;
		expect(next).not.toBeNull();
		// Still 4 October — placed just after the jump (03:30) rather than pushed to the 5th.
		expect(localOf(new Date(next).toISOString(), "Australia/Melbourne")).toBe("2026-10-04 03:30");
	});

	it("fires ONCE, not twice, on the fall-back day when the wall time repeats", () => {
		// 2026-04-05 Melbourne: 03:00 → 02:00, so 02:30 happens twice.
		const dupFields = cronFields("30 2 * * *");
		const first = nextCronInstant(dupFields, new Date("2026-04-04T12:00:00Z"), "Australia/Melbourne") as number;
		const second = nextCronInstant(dupFields, new Date(first), "Australia/Melbourne") as number;
		// The next run after the ambiguous one is the FOLLOWING day, not the second 02:30.
		expect(localOf(new Date(second).toISOString(), "Australia/Melbourne")).toBe("2026-04-06 02:30");
	});

	it("behaves exactly like the old UTC scheduler when the zone is UTC", () => {
		const next = nextCronInstant(cronFields("0 8 * * *"), new Date("2026-07-12T02:03:00Z"), "UTC") as number;
		expect(new Date(next).toISOString()).toBe("2026-07-12T08:00:00.000Z");
	});

	it("returns null when no minute in a year matches", () => {
		expect(nextCronInstant(cronFields("0 0 31 2 *"), new Date("2026-01-01T00:00:00Z"), "UTC")).toBeNull();
	});

	it("always returns an instant strictly in the future", () => {
		const from = new Date("2026-07-12T08:00:00Z");
		const next = nextCronInstant(cronFields("0 8 * * *"), from, "UTC") as number;
		expect(next).toBeGreaterThan(from.getTime());
	});

	it("matches a weekday given as either 0 or 7 for Sunday", () => {
		expect(matchesCronField("7", 0)).toBe(true);
		expect(matchesCronField("0", 0)).toBe(true);
		expect(matchesCronField("*", 5)).toBe(true);
		expect(matchesCronField("3", 4)).toBe(false);
	});
});
