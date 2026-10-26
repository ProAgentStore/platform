import { describe, expect, it } from "vitest";
import { DRIVER_RESUME_POLICY } from "./coding-failure.js";
import { AUTO_RESUME_WINDOW_MS, durationText, PROBE_BACKOFF_MS, probeDelayMs, probeGiveUpText, probeScheduleText, resumeDelayMs } from "./retry-policy.js";

const H = 3_600_000;

describe("the backoff ladders (#1356)", () => {
	it("re-checks a held key after 5 min, 15 min, 1 h, then every 6 h", () => {
		expect([0, 1, 2, 3, 4, 9].map(probeDelayMs)).toEqual([5 * 60_000, 5 * 60_000, 15 * 60_000, H, 6 * H, 6 * H]);
	});
	it("retries a deferred continue after 1, 2, 4… minutes, capped at an hour", () => {
		expect([1, 2, 3, 20].map(resumeDelayMs)).toEqual([60_000, 120_000, 240_000, H]);
	});
	it("says the schedule in words built from the same constants", () => {
		expect(probeScheduleText()).toBe("5 min, 15 min, 1 h, then every 6 h");
		expect(probeGiveUpText()).toBe("7 days");
		expect(durationText(24 * H)).toBe("1 day");
		expect(PROBE_BACKOFF_MS.map(durationText).join(" ")).toBe("5 min 15 min 1 h 6 h");
	});
	it("the sentences the owner reads carry that text, so a changed number changes them", () => {
		const why = DRIVER_RESUME_POLICY.provider_credentials.why;
		expect(why).toContain(`re-checked after ${probeScheduleText()}`);
		expect(why).toContain(`stopped within the last ${durationText(AUTO_RESUME_WINDOW_MS)}`);
	});
});
