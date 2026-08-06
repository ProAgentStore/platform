import { describe, expect, it } from "vitest";
import { engineAuthBadge, type EngineAuthReport } from "./engine-auth-view.js";

const report = (over: Partial<EngineAuthReport> = {}): EngineAuthReport => ({
	mode: "auto",
	resolved: "subscription",
	runtime: "child-process",
	warning: null,
	...over,
});

describe("engineAuthBadge — the money question, in the session header", () => {
	it("shows nothing when there is no report at all", () => {
		expect(engineAuthBadge(null)).toBeNull();
		expect(engineAuthBadge(undefined)).toBeNull();
	});

	it("names the BILL, not the mechanism, when an API key ran", () => {
		expect(engineAuthBadge(report({ resolved: "api-key" }))?.label).toMatch(/per token/i);
	});

	it("says subscription when the subscription ran", () => {
		expect(engineAuthBadge(report({ resolved: "subscription" }))?.label).toMatch(/subscription/i);
	});

	it("says machine login when neither credential was present", () => {
		expect(engineAuthBadge(report({ resolved: "machine-login" }))?.label).toMatch(/machine/i);
	});

	it("still renders when the outcome is UNKNOWN — silence is the bug being fixed", () => {
		const b = engineAuthBadge(report({ resolved: null }));
		expect(b).not.toBeNull();
		expect(b?.label).toMatch(/unknown/i);
		// And it must not quietly present the setting as the outcome.
		expect(b?.label).not.toMatch(/subscription$/i);
	});

	it("goes loud exactly when the API warned, not merely when a key was used", () => {
		// An intentional api-key session is normal, not an alarm.
		expect(engineAuthBadge(report({ mode: "api-key", resolved: "api-key" }))?.tone).toBe("neutral");
		// The documented silent-billing case IS an alarm.
		expect(engineAuthBadge(report({ mode: "subscription", resolved: "api-key", warning: "billing per token" }))?.tone).toBe("warn");
	});

	it("always states the runtime, so the tmux question is answered (#247)", () => {
		expect(engineAuthBadge(report())?.detail).toMatch(/child process/);
		expect(engineAuthBadge(report({ resolved: null }))?.detail).toMatch(/child process/);
	});

	it("reports what was ASKED FOR alongside what happened", () => {
		expect(engineAuthBadge(report({ mode: "subscription" }))?.detail).toMatch(/Set to Claude subscription/);
		expect(engineAuthBadge(report({ mode: "auto" }))?.detail).toMatch(/Set to Automatic/);
		expect(engineAuthBadge(report({ mode: "machine" }))?.detail).toMatch(/Set to This machine's login/);
	});
});
