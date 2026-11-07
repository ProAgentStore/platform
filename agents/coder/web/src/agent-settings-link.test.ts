import { describe, expect, it } from "vitest";
import { agentSettingsPath } from "./agent-settings-link";

describe("the coder header's Agent settings button", () => {
	it("opens Settings on the Agent sub-tab and escapes the id", () => {
		expect(agentSettingsPath("inst-1")).toBe("/instances/inst-1/settings?subtab=agent");
		expect(agentSettingsPath("a/b")).toBe("/instances/a%2Fb/settings?subtab=agent");
	});
});
