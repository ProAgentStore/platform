import { describe, expect, it } from "vitest";
import { HttpError } from "./auth.js";
import { nextRunAt, normalizeSchedule, publicWebhookUrl } from "./triggers.js";

describe("trigger schedules", () => {
	it("normalizes supported interval schedules", () => {
		expect(normalizeSchedule("@hourly")).toBe("@hourly");
		expect(normalizeSchedule("every 15 minutes")).toBe("every 15 minutes");
		expect(normalizeSchedule("every 2 hours")).toBe("every 120 minutes");
	});

	it("rejects too-frequent schedules", () => {
		expect(() => normalizeSchedule("every 1 minute")).toThrow(HttpError);
	});

	it("computes the next run for aliases and intervals", () => {
		const base = new Date("2026-07-12T02:03:22.000Z");
		expect(nextRunAt("@hourly", base)).toBe("2026-07-12T03:03:00.000Z");
		expect(nextRunAt("every 15 minutes", base)).toBe("2026-07-12T02:18:00.000Z");
		expect(nextRunAt("@daily", base)).toBe("2026-07-13T00:00:00.000Z");
	});

	it("computes simple five-field cron schedules", () => {
		const base = new Date("2026-07-12T02:03:22.000Z");
		expect(nextRunAt("5 * * * *", base)).toBe("2026-07-12T02:05:00.000Z");
		expect(nextRunAt("0 8 * * *", base)).toBe("2026-07-12T08:00:00.000Z");
	});

	it("formats public webhook URLs without duplicate slashes", () => {
		expect(publicWebhookUrl("https://api.example.com/", "abc")).toBe("https://api.example.com/v1/triggers/webhook/abc");
	});
});
