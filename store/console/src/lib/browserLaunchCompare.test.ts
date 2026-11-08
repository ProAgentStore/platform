import { describe, expect, it } from "vitest";
import { launchDiffersFromSettings } from "./browserLaunchCompare";

const effective = { engine: "chrome", mode: "headless", profile: "persistent" } as const;
const launch = { engine: "chrome", mode: "headless", profilePolicy: "persistent" };

describe("launchDiffersFromSettings (#1590)", () => {
	it("is false when the launch is what the settings say", () => {
		expect(launchDiffersFromSettings(effective, launch)).toBe(false);
	});
	it("is true when the engine, the mode or the profile policy differs", () => {
		expect(launchDiffersFromSettings(effective, { ...launch, engine: "firefox" })).toBe(true);
		expect(launchDiffersFromSettings(effective, { ...launch, mode: "headed" })).toBe(true);
		expect(launchDiffersFromSettings(effective, { ...launch, profilePolicy: "ephemeral" })).toBe(true);
	});
	it("is false with no receipt: nothing to differ from", () => {
		expect(launchDiffersFromSettings(effective, null)).toBe(false);
		expect(launchDiffersFromSettings(effective, undefined)).toBe(false);
	});
	it("a setting left to the runner default (null) never differs", () => {
		expect(launchDiffersFromSettings({ engine: null, mode: null, profile: null }, { engine: "webkit", mode: "headed", profilePolicy: "ephemeral" })).toBe(false);
		expect(launchDiffersFromSettings({ ...effective, engine: null }, { ...launch, engine: "webkit" })).toBe(false);
	});
});
