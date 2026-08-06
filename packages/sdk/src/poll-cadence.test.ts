import { describe, it, expect } from "vitest";
import { resolvePollTier, resolvePollMs, shouldRefreshOnResume } from "./poll-cadence.js";

const cadence = { activeMs: 4000, passiveMs: 30000 };

describe("resolvePollTier", () => {
	it("is active while work is running", () => {
		expect(resolvePollTier({ hidden: false, busy: true })).toBe("active");
	});

	it("stays active in a hidden tab while work is running", () => {
		// Load-bearing: the Coder Loop and the post-delegation watcher advance off
		// these polls. Halting a busy background tab would stall real work.
		expect(resolvePollTier({ hidden: true, busy: true })).toBe("active");
	});

	it("is passive when visible with nothing running", () => {
		expect(resolvePollTier({ hidden: false, busy: false })).toBe("passive");
	});

	it("is halted only when hidden AND idle", () => {
		expect(resolvePollTier({ hidden: true, busy: false })).toBe("halted");
	});
});

describe("resolvePollMs", () => {
	it("uses the active interval when busy", () => {
		expect(resolvePollMs(cadence, { hidden: false, busy: true })).toBe(4000);
		expect(resolvePollMs(cadence, { hidden: true, busy: true })).toBe(4000);
	});

	it("uses the passive interval when visible and idle", () => {
		expect(resolvePollMs(cadence, { hidden: false, busy: false })).toBe(30000);
	});

	it("returns 0 — suppressed — when halted", () => {
		expect(resolvePollMs(cadence, { hidden: true, busy: false })).toBe(0);
	});

	it("suppresses rather than free-running on a nonsense interval", () => {
		// setInterval(fn, 0) / setInterval(fn, NaN) both become a tight loop.
		expect(resolvePollMs({ activeMs: 0, passiveMs: 0 }, { hidden: false, busy: true })).toBe(0);
		expect(resolvePollMs({ activeMs: -1, passiveMs: 5 }, { hidden: false, busy: true })).toBe(0);
		expect(resolvePollMs({ activeMs: Number.NaN, passiveMs: 5 }, { hidden: false, busy: true })).toBe(0);
	});

	it("lets a call site opt out of the passive tier entirely", () => {
		expect(resolvePollMs({ activeMs: 1500, passiveMs: 0 }, { hidden: false, busy: false })).toBe(0);
	});
});

describe("shouldRefreshOnResume", () => {
	it("refreshes when a hidden tab comes back", () => {
		expect(shouldRefreshOnResume("halted", "passive")).toBe(true);
		expect(shouldRefreshOnResume("halted", "active")).toBe(true);
	});

	it("refreshes when an idle surface starts working", () => {
		expect(shouldRefreshOnResume("passive", "active")).toBe(true);
	});

	it("does not refresh when slowing down", () => {
		expect(shouldRefreshOnResume("active", "passive")).toBe(false);
		expect(shouldRefreshOnResume("passive", "halted")).toBe(false);
		expect(shouldRefreshOnResume("active", "halted")).toBe(false);
	});

	it("does not refresh when the tier is unchanged", () => {
		for (const t of ["active", "passive", "halted"] as const) {
			expect(shouldRefreshOnResume(t, t)).toBe(false);
		}
	});

	it("does not double-fetch on first mount", () => {
		// Every call site already does its own initial load in a useEffect.
		expect(shouldRefreshOnResume(null, "active")).toBe(false);
		expect(shouldRefreshOnResume(null, "passive")).toBe(false);
	});
});
