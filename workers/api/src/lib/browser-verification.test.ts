/** Browser verification settings (#1031): an owner turns a DECLARED capability on, and nothing is clamped. */
import { describe, expect, it } from "vitest";
import { BROWSER_VERIFICATION_DEFAULTS, mergeBrowserVerification, resolveBrowserVerification, WAIT_LIMIT_MINUTES } from "./browser-verification.js";
import { type BrowserRuntimeCandidate, selectBrowserRuntime } from "./browser-verification-runtimes.js";

describe("mergeBrowserVerification", () => {
	it("applies a patch over the stored settings, leaving absent fields alone", () => {
		const out = mergeBrowserVerification({ fallback: "mark_unverifiable" }, { enabled: true, takeover: "never" }, true);
		expect(out).toEqual({ settings: { ...BROWSER_VERIFICATION_DEFAULTS, enabled: true, takeover: "never", fallback: "mark_unverifiable" } });
	});

	it("cannot turn verification ON for an agent that does not declare a local browser — the capability is the template's", () => {
		const out = mergeBrowserVerification({}, { enabled: true }, false);
		expect(out).toEqual({ error: expect.stringMatching(/does not declare a local browser.*only turns a declared one on/) });
		// …but can always turn it off, or change other fields while it is off.
		expect(mergeBrowserVerification({ enabled: true }, { enabled: false }, false)).toMatchObject({ settings: { enabled: false } });
		expect(mergeBrowserVerification({}, { fallback: "wait" }, false)).toMatchObject({ settings: { enabled: false } });
	});

	it("refuses an out-of-range or mistyped value with the reason, never clamping it", () => {
		expect(mergeBrowserVerification({}, { waitLimitMinutes: WAIT_LIMIT_MINUTES.max + 1 }, true)).toEqual({ error: expect.stringMatching(/from 1 to 1440/) });
		expect(mergeBrowserVerification({}, { waitLimitMinutes: 2.5 }, true)).toHaveProperty("error");
		expect(mergeBrowserVerification({}, { runtime: "cloud" }, true)).toEqual({ error: expect.stringMatching(/runtime must be one of pinned, any_eligible/) });
		expect(mergeBrowserVerification({}, { allowMobile: "yes" }, true)).toHaveProperty("error");
		expect(mergeBrowserVerification({}, { notify: true }, true)).toEqual({ error: expect.stringMatching(/Unknown field\(s\): notify/) });
		expect(mergeBrowserVerification({}, null, true)).toHaveProperty("error");
	});

	it("reads malformed stored values as defaults, field by field", () => {
		expect(resolveBrowserVerification({ enabled: "yes", runtime: "any_eligible", waitLimitMinutes: 99_999 })).toEqual({ ...BROWSER_VERIFICATION_DEFAULTS, runtime: "any_eligible" });
		expect(resolveBrowserVerification(undefined)).toEqual(BROWSER_VERIFICATION_DEFAULTS);
	});
});

describe("selectBrowserRuntime", () => {
	const c = (node: string, pinned: boolean, eligible: boolean): BrowserRuntimeCandidate => ({
		node,
		pinned,
		eligible,
		attached: eligible,
		heartbeat: { lastSeenAt: null, fresh: true },
		health: { state: eligible ? "ok" : "timeout" },
		runnerVersion: "0.4.114",
	});

	it("pinned uses only the pinned machine, and only when it is eligible", () => {
		expect(selectBrowserRuntime([c("a", true, true), c("b", false, true)], "pinned")?.node).toBe("a");
		expect(selectBrowserRuntime([c("a", true, false), c("b", false, true)], "pinned")).toBeNull();
		expect(selectBrowserRuntime([c("b", false, true)], "pinned")).toBeNull();
	});

	it("any_eligible prefers the pinned machine, else the first eligible one", () => {
		expect(selectBrowserRuntime([c("b", false, true), c("a", true, true)], "any_eligible")?.node).toBe("a");
		expect(selectBrowserRuntime([c("a", true, false), c("b", false, true)], "any_eligible")?.node).toBe("b");
		expect(selectBrowserRuntime([c("a", true, false)], "any_eligible")).toBeNull();
	});
});
