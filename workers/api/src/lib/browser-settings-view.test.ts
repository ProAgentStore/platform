/** `launchPath` mirrors the runner's managed test (#1603). */
import { describe, expect, it } from "vitest";
import { browserSettingsView } from "./browser-settings.js";

const caps = (c: Record<string, unknown>) => ({ capabilities: c });
describe("browserSettingsView launchPath", () => {
	it.each([
		["engine only", { browserEngine: "chrome" }, {}, "managed"],
		["profile only", { browserProfilePolicy: "ephemeral" }, {}, "managed"],
		["both", { browserEngine: "chrome", browserProfilePolicy: "persistent" }, {}, "managed"],
		["neither", {}, {}, "legacy"],
		["mode only", { browserMode: "headless" }, {}, "legacy"],
		["engine from the agent default", {}, { browserEngine: "firefox" }, "managed"],
	])("%s", (_name, config, agent, expected) => {
		const view = browserSettingsView(config, caps(agent));
		expect(view.launchPath).toBe(expected);
		if (_name === "engine from the agent default") expect(view.sources.engine).toBe("agent");
	});
});
