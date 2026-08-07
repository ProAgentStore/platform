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

	it("says machine login when neither credential was present — and that the payer is unknown", () => {
		// It is the MOST COMMON resolution (what the default `auto` mode produces) and the one
		// where the reader can least tell which account is paying. Naming only the mechanism left
		// them to assume either answer (#343/#346).
		const label = engineAuthBadge(report({ resolved: "machine-login" }))?.label;
		expect(label).toMatch(/machine/i);
		expect(label).toMatch(/unknown/i);
	});

	it("carries the API's positive note, so the ordinary case says something", () => {
		expect(engineAuthBadge(report({ note: "Running on your Claude subscription — no per-token charge." }))?.note).toMatch(/no per-token charge/);
	});

	it("degrades to no note against an API that predates it", () => {
		expect(engineAuthBadge(report())?.note).toBeNull();
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
