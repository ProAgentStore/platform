import { describe, expect, it } from "vitest";
import { browserSettingsHeaders } from "./browser-settings.js";
import { routeRefusal } from "./route-policy.js";

describe("browser launch settings relay (#1431)", () => {
	it.each(["chrome", "msedge", "chromium", "firefox", "webkit"])("forwards %s with independent mode and profile policy", (browserEngine) => {
		expect(browserSettingsHeaders({ browserEngine, browserMode: "headed", browserProfilePolicy: "ephemeral" })).toEqual({ "X-PAGS-Browser-Engine": browserEngine, "X-PAGS-Browser-Mode": "headed", "X-PAGS-Browser-Profile-Policy": "ephemeral" });
	});
	it("leaves unset settings absent", () => expect(browserSettingsHeaders({})).toEqual({}));
	it.each([{ browserEngine: "safari" }, { browserEngine: ["firefox"] }, { browserProfilePolicy: "personal" }, { browserMode: "hidden" }])("rejects malformed settings instead of launching the fallback", (settings) => expect(() => browserSettingsHeaders(settings)).toThrow(/Invalid/));
	it("permits read-only session inspection for local browser research", () => expect(routeRefusal({ runtime: "local_browser" }, "/browser/session")).toBeNull());
});
