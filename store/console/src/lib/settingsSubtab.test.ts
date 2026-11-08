import { describe, expect, it } from "vitest";
import {
	searchWithSettingsSubtab,
	SETTINGS_SUBTABS,
	settingsSubtabFromSearch,
	showsSettingsSubtab,
	visibleSettingsSubtabs,
} from "./settingsSubtab";

const GMAIL_SCOUT = { runtime: "local_browser", surfaces: ["chat", "settings"] };
const CODING = { runtime: "coding", surfaces: ["coding"] };
const CLOUD_CHAT = { runtime: null, surfaces: ["chat"] };
const q = (s: string) => new URLSearchParams(s);

describe("which Settings sub-tabs an instance shows (#1589)", () => {
	it("a Gmail Scout shows all six, in order", () => {
		expect(visibleSettingsSubtabs(GMAIL_SCOUT)).toEqual(["agent", "browser", "automation", "notifications", "instructions", "general"]);
	});
	it("a coding agent shows five, no Browser", () => {
		expect(visibleSettingsSubtabs(CODING)).toEqual(["agent", "automation", "notifications", "instructions", "general"]);
	});
	it("a cloud-only chat agent shows five, no Browser", () => {
		expect(visibleSettingsSubtabs(CLOUD_CHAT)).toEqual(["agent", "automation", "notifications", "instructions", "general"]);
	});
	it("the legacy apply agent and the other browser runtimes get Browser", () => {
		expect(showsSettingsSubtab({ runtime: null, surfaces: ["apply"] }, "browser")).toBe(true);
		for (const runtime of ["browser", "local_apply"]) expect(showsSettingsSubtab({ runtime, surfaces: [] }, "browser"), runtime).toBe(true);
	});
	it("Agent is first, General last", () => {
		expect(SETTINGS_SUBTABS[0]).toBe("agent");
		expect(SETTINGS_SUBTABS[SETTINGS_SUBTABS.length - 1]).toBe("general");
	});
});

describe("settingsSubtabFromSearch", () => {
	it("parses every shown sub-tab", () => {
		for (const id of SETTINGS_SUBTABS) expect(settingsSubtabFromSearch(q(`subtab=${id}`), GMAIL_SCOUT)).toBe(id);
	});
	it("falls back to Agent for no param, an unknown value and a sub-tab not shown", () => {
		expect(settingsSubtabFromSearch(q(""), GMAIL_SCOUT)).toBe("agent");
		expect(settingsSubtabFromSearch(q("subtab=nope"), GMAIL_SCOUT)).toBe("agent");
		expect(settingsSubtabFromSearch(q("subtab=Browser"), GMAIL_SCOUT)).toBe("agent");
		expect(settingsSubtabFromSearch(q("subtab=browser"), CODING)).toBe("agent");
	});
});

describe("searchWithSettingsSubtab", () => {
	it("keeps focus= while setting the sub-tab", () => {
		const next = searchWithSettingsSubtab(q("focus=permissions&subtab=agent"), "general");
		expect(next.get("subtab")).toBe("general");
		expect(next.get("focus")).toBe("permissions");
	});
});
