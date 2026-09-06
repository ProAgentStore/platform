import { afterEach, describe, expect, it, vi } from "vitest";
import { keyUsageLabel } from "./keyUsage";

const NOW = new Date("2026-09-07T12:00:00.000Z");

afterEach(() => {
	vi.useRealTimers();
});

/** Freeze the clock and return a stamp `secondsAgo` in the past, in D1's zone-less shape. */
function d1Stamp(secondsAgo: number): string {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	return new Date(NOW.getTime() - secondsAgo * 1000).toISOString().replace("T", " ").slice(0, 19);
}

describe("keyUsageLabel", () => {
	it("says nothing for a provider with no stored key", () => {
		// "never used" beside "Not set" would be a claim about a key that does not exist.
		expect(keyUsageLabel({ hasKey: false, lastUsedAt: null })).toBeNull();
		expect(keyUsageLabel({ hasKey: false })).toBeNull();
	});

	it("marks a stored-but-untouched key as never used, with its own tone", () => {
		// The whole point of #780: this is the state that answers "PAGS holds this key — is it
		// the one being spent?". It must not be a blank or an empty timestamp.
		expect(keyUsageLabel({ hasKey: true, lastUsedAt: null })).toEqual({ text: "never used", tone: "never" });
		expect(keyUsageLabel({ hasKey: true })).toEqual({ text: "never used", tone: "never" });
		expect(keyUsageLabel({ hasKey: true, lastUsedAt: "" })).toEqual({ text: "never used", tone: "never" });
	});

	it("reads D1's zone-less UTC stamp as UTC, not local time", () => {
		// `datetime('now')` writes `YYYY-MM-DD HH:MM:SS` with no marker. Parsed as local time, a
		// key used seconds ago reports as hours stale — which reads as an idle key.
		expect(keyUsageLabel({ hasKey: true, lastUsedAt: d1Stamp(120) })).toEqual({
			text: "last used 2m ago",
			tone: "used",
		});
	});

	it("carries the used tone across every band", () => {
		expect(keyUsageLabel({ hasKey: true, lastUsedAt: d1Stamp(30) })?.text).toBe("last used 30s ago");
		expect(keyUsageLabel({ hasKey: true, lastUsedAt: d1Stamp(7200) })?.text).toBe("last used 2h ago");
		expect(keyUsageLabel({ hasKey: true, lastUsedAt: d1Stamp(3 * 86_400) })?.text).toBe("last used 3d ago");
	});

	it("keeps an unparseable stamp on the used side of the line", () => {
		// A stamp we cannot format is still a stamp the platform WROTE. Degrading it to "never
		// used" would invert the one bit this panel exists to report.
		expect(keyUsageLabel({ hasKey: true, lastUsedAt: "not-a-date" })).toEqual({
			text: "used, time unknown",
			tone: "used",
		});
	});
});
