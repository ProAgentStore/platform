import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import LocalBrowserProfileFields from "./LocalBrowserProfileFields";

const CHECKBOX = "I allow research in my signed-in profile";
const instanceSet = { launchPath: "managed" as const, sources: { mode: "runner" as const, engine: "instance" as const, profile: "runner" as const } };
const agentSet = { launchPath: "managed" as const, sources: { mode: "runner" as const, engine: "agent" as const, profile: "runner" as const } };
const legacy = { launchPath: "legacy" as const, sources: { mode: "runner" as const, engine: "runner" as const, profile: "runner" as const } };
const render = (launch: Parameters<typeof LocalBrowserProfileFields>[0]["launch"], browserProfile = "default") =>
	renderToStaticMarkup(createElement(MemoryRouter, null, createElement(LocalBrowserProfileFields, { instanceId: "inst-1", browserProfile, profileAllowed: false, launch, onProfile: () => {}, onConsent: () => {} })));

describe("own-profile choice on the managed launch path (#1603)", () => {
	it("warns and withholds the consent checkbox when the owner set a browser or profile", () => {
		const html = render(instanceSet);
		expect(html).toContain("Your own profile is not used while a browser or profile is set in Browser settings");
		expect(html).toContain("Open Browser settings");
		expect(html).toContain('href="/instances/inst-1/settings?subtab=browser"');
		expect(html).not.toContain(CHECKBOX);
	});
	it("uses the agent-default wording when only the agent's defaults make it managed", () => {
		const html = render(agentSet);
		expect(html).toContain("Your own profile is not used while this agent&#x27;s default browser or profile applies");
		expect(html).not.toContain(CHECKBOX);
	});
	it("keeps the consent checkbox and no warning on the legacy path", () => {
		const html = render(legacy);
		expect(html).toContain(CHECKBOX);
		expect(html).not.toContain("Your own profile is not used");
	});
	it("behaves as before while the browser settings load or fail", () => {
		const html = render(null);
		expect(html).toContain(CHECKBOX);
		expect(html).not.toContain("Your own profile is not used");
	});
});
