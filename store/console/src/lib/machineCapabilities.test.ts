import { describe, expect, it } from "vitest";
import { browserLine, resourceLine, supportLine } from "./machineCapabilities";

describe("machine capability wording (#1312)", () => {
	it("says a launching engine launches", () => {
		expect(browserLine("webkit", { supported: true, probed: true })).toEqual({ text: "webkit: launches", tone: "ok" });
	});
	it("says a probed failure does not launch, with the reason", () => {
		expect(browserLine("webkit", { supported: false, probed: true, reason: "webkit failed to launch on macOS 14.5" })).toEqual({ text: "webkit: does not launch — webkit failed to launch on macOS 14.5", tone: "bad" });
	});
	it("shows the tiny laptop's unprobed WebKit/Chromium as unsupported, from the OS rule", () => {
		const r = browserLine("chromium", { supported: false, probed: false, reason: "chromium is not supported: macOS 12.7.6 is incompatible with Playwright 1.58.2 — Playwright dropped…" });
		expect(r.tone).toBe("bad");
		expect(r.text).toMatch(/^chromium: unsupported — .*macOS 12\.7\.6/);
	});
	it("says not probed, not unsupported, when nothing is known either way", () => {
		expect(browserLine("firefox", { supported: false, probed: false, reason: "firefox was not probed on this machine" })).toEqual({ text: "firefox: not probed", tone: "muted" });
	});
	it("words support flags and resources", () => {
		expect(supportLine("Docker", false)).toBe("Docker: not available");
		expect(resourceLine({ cpuCount: 4, memoryGb: 8, diskGb: null })).toBe("4 cores · 8 GB memory");
		expect(resourceLine({ cpuCount: null, memoryGb: null, diskGb: null })).toBe("not reported");
	});
});
