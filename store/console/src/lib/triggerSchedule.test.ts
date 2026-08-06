import { describe, expect, it } from "vitest";
import {
	buildSchedule,
	countdownTo,
	DEFAULT_SCHEDULE_DRAFT,
	describeSchedule,
	formatRun,
	parseScheduleToDraft,
	scheduleUsesWallClock,
	type ScheduleDraft,
} from "./triggerSchedule";

const draft = (over: Partial<ScheduleDraft> = {}): ScheduleDraft => ({ ...DEFAULT_SCHEDULE_DRAFT, ...over });

describe("buildSchedule", () => {
	it("builds the presets into expressions the API already accepts", () => {
		expect(buildSchedule(draft({ mode: "hourly" }))).toEqual({ schedule: "@hourly" });
		expect(buildSchedule(draft({ mode: "daily", time: "08:00" }))).toEqual({ schedule: "0 8 * * *" });
		expect(buildSchedule(draft({ mode: "daily", time: "17:45" }))).toEqual({ schedule: "45 17 * * *" });
		expect(buildSchedule(draft({ mode: "weekly", time: "09:30", weekday: 3 }))).toEqual({ schedule: "30 9 * * 3" });
		expect(buildSchedule(draft({ mode: "interval", every: "15", unit: "minutes" }))).toEqual({ schedule: "every 15 minutes" });
		expect(buildSchedule(draft({ mode: "interval", every: "2", unit: "hours" }))).toEqual({ schedule: "every 2 hours" });
		expect(buildSchedule(draft({ mode: "cron", cron: " 0 6 * * 1 " }))).toEqual({ schedule: "0 6 * * 1" });
	});

	it("catches the same floors the server enforces, without a round trip", () => {
		expect(buildSchedule(draft({ mode: "interval", every: "1", unit: "minutes" }))).toEqual({ error: "The shortest interval is 5 minutes." });
		expect(buildSchedule(draft({ mode: "interval", every: "900", unit: "hours" }))).toEqual({ error: "The longest interval is 31 days." });
		expect(buildSchedule(draft({ mode: "interval", every: "abc" }))).toEqual({ error: "Enter a whole number of minutes or hours." });
	});

	it("rejects a malformed time rather than guessing one", () => {
		expect(buildSchedule(draft({ mode: "daily", time: "8am" }))).toHaveProperty("error");
		expect(buildSchedule(draft({ mode: "daily", time: "25:00" }))).toHaveProperty("error");
		expect(buildSchedule(draft({ mode: "cron", cron: "  " }))).toEqual({ error: "Enter a cron expression." });
	});
});

describe("parseScheduleToDraft", () => {
	it("round-trips every preset it can build", () => {
		for (const d of [
			draft({ mode: "hourly" }),
			draft({ mode: "daily", time: "08:00" }),
			draft({ mode: "weekly", time: "09:30", weekday: 3 }),
			draft({ mode: "interval", every: "15", unit: "minutes" }),
		]) {
			const built = buildSchedule(d) as { schedule: string };
			const back = parseScheduleToDraft(built.schedule);
			expect(back.mode).toBe(d.mode);
			if (d.mode === "daily" || d.mode === "weekly") expect(back.time).toBe(d.time);
			if (d.mode === "weekly") expect(back.weekday).toBe(d.weekday);
			if (d.mode === "interval") expect(back.every).toBe(d.every);
		}
	});

	it("reads the aliases the API supports", () => {
		expect(parseScheduleToDraft("@daily")).toMatchObject({ mode: "daily", time: "00:00" });
		expect(parseScheduleToDraft("@weekly")).toMatchObject({ mode: "weekly", weekday: 0 });
		expect(parseScheduleToDraft("@hourly")).toMatchObject({ mode: "hourly" });
	});

	it("treats Sunday-as-7 the same as Sunday-as-0", () => {
		expect(parseScheduleToDraft("0 8 * * 7")).toMatchObject({ mode: "weekly", weekday: 0 });
	});

	it("falls back to raw cron for anything the presets cannot express", () => {
		expect(parseScheduleToDraft("0 8 3 6 *")).toMatchObject({ mode: "cron", cron: "0 8 3 6 *" });
	});

	it("survives an empty or missing schedule", () => {
		expect(parseScheduleToDraft(null).mode).toBe(DEFAULT_SCHEDULE_DRAFT.mode);
		expect(parseScheduleToDraft("").mode).toBe(DEFAULT_SCHEDULE_DRAFT.mode);
	});
});

describe("describeSchedule", () => {
	it("names the zone, and says UTC when there is none — the previous silent default", () => {
		expect(describeSchedule("0 8 * * *", "Australia/Melbourne")).toBe("Daily at 08:00 (Australia/Melbourne)");
		expect(describeSchedule("0 8 * * *", null)).toBe("Daily at 08:00 (UTC)");
		expect(describeSchedule("30 9 * * 3", "UTC")).toBe("Every Wednesday at 09:30 (UTC)");
	});

	it("does not attach a zone to an interval, which has no wall clock", () => {
		expect(describeSchedule("every 15 minutes", "Australia/Melbourne")).toBe("Every 15 minutes");
		expect(describeSchedule("@hourly", "Australia/Melbourne")).toBe("Every hour");
	});

	it("marks which schedules a timezone actually affects", () => {
		expect(scheduleUsesWallClock("0 8 * * *")).toBe(true);
		expect(scheduleUsesWallClock("@daily")).toBe(true);
		expect(scheduleUsesWallClock("every 15 minutes")).toBe(false);
		expect(scheduleUsesWallClock("@hourly")).toBe(false);
	});

	it("handles a missing schedule", () => {
		expect(describeSchedule(null)).toBe("No schedule");
	});
});

describe("formatRun", () => {
	it("shows the same instant in the schedule's zone and in UTC", () => {
		const out = formatRun("2026-07-12T22:00:00.000Z", "Australia/Melbourne");
		expect(out.zone).toBe("Australia/Melbourne");
		expect(out.local).toContain("08:00");
		expect(out.utc).toContain("22:00");
	});

	it("treats a missing zone as UTC, so both halves agree", () => {
		const out = formatRun("2026-07-12T22:00:00.000Z", null);
		expect(out.local).toBe(out.utc);
	});

	it("does not throw on a bad instant or a bad zone", () => {
		expect(formatRun("not-a-date", "UTC").local).toBe("—");
		expect(formatRun("2026-07-12T22:00:00.000Z", "Nope/Nowhere").local).toBe("2026-07-12T22:00:00.000Z");
	});
});

describe("countdownTo", () => {
	const now = Date.parse("2026-07-12T00:00:00Z");

	it("reads in the unit a person would use", () => {
		expect(countdownTo("2026-07-12T00:12:00Z", now)).toBe("in 12 min");
		expect(countdownTo("2026-07-12T05:00:00Z", now)).toBe("in 5 h");
		expect(countdownTo("2026-07-16T00:00:00Z", now)).toBe("in 4 days");
	});

	it("says 'due now' rather than a negative number", () => {
		expect(countdownTo("2026-07-11T23:00:00Z", now)).toBe("due now");
	});
});
