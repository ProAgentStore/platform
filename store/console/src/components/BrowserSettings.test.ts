import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrowserModeSettings } from "../tabs/settings/BrowserModeSection";
import { browserCapabilitiesPatch, type BrowserSettingsView } from "../lib/browserSettings";
import { BrowserLaunchDetails, type BrowserLaunchReceipt } from "./BrowserSessionReceipt";

const view = (overrides: Partial<BrowserSettingsView> = {}) => renderToStaticMarkup(createElement(BrowserModeSettings, {
	data: { mode: null, engine: null, profile: null, agentDefaults: { mode: null, engine: null, profile: null }, effective: { mode: null, engine: null, profile: null }, launchPath: "legacy", sources: { mode: "runner", engine: "runner", profile: "runner" }, requiredCli: "0.4.196", explained: "Browser settings.", ...overrides },
	saving: false, message: "", onChange: () => undefined,
}));

describe("browser settings distinguish inherited, configured and actual state", () => {
	it("does not invent a browser or profile when their default is not configured", () => {
		const html = view();
		expect(html).toContain("Effective setting: Runner default (runner default)");
		expect(html).toContain("Effective setting: Workflow default (chosen by workflow)");
		expect(html).toContain('selected="">Use agent default (Workflow default)</option>');
	});
	it("shows per-field inheritance and overrides independently", () => {
		const html = view({ engine: "firefox", agentDefaults: { mode: "headed", engine: "chrome", profile: "persistent" }, effective: { mode: "headed", engine: "firefox", profile: "persistent" }, sources: { mode: "agent", engine: "instance", profile: "agent" } });
		expect(html).toContain("Effective setting: Visible browser (from agent)");
		expect(html).toContain("Effective setting: Playwright Firefox (instance override)");
		expect(html).toContain('<option value="firefox" selected="">Playwright Firefox</option>');
		expect(html).toContain("Use agent default (Installed Google Chrome)");
		expect(html).toContain("current tasks continue unchanged");
	});
	it("names Playwright WebKit accurately and explains profile isolation", () => {
		const html = view();
		expect(html).toContain("Playwright WebKit is not the Safari application");
		expect(html).toContain("clean, dedicated profile");
		expect(html).toContain("your previous profile is kept");
	});
	it("patches exactly the changed template capability, including clearing inheritance", () => {
		expect(browserCapabilitiesPatch({ engine: "firefox" })).toEqual({ browserEngine: "firefox" });
		expect(browserCapabilitiesPatch({ profile: null })).toEqual({ browserProfilePolicy: null });
		expect(browserCapabilitiesPatch({ mode: "headed", profile: "ephemeral" })).toEqual({ browserMode: "headed", browserProfilePolicy: "ephemeral" });
	});
	it("does not manufacture actual launch evidence from a saved choice", () => {
		const html = renderToStaticMarkup(createElement(BrowserLaunchDetails, { launch: null }));
		expect(html).toContain("No browser launch has been reported");
		expect(html).toContain("Saved settings do not confirm");
	});
	it("renders the actual closed browser and its version/profile independently", () => {
		const launch: BrowserLaunchReceipt = { engine: "firefox", browserType: "firefox", channel: null, version: "140.0", executable: "/playwright/firefox", mode: "headless", profilePolicy: "ephemeral", profileId: "instance-1/run-1", transport: "playwright", launchedAt: "2026-11-03T01:00:00Z", active: false };
		const html = renderToStaticMarkup(createElement(BrowserLaunchDetails, { launch }));
		expect(html).toContain("Playwright Firefox (140.0)");
		expect(html).toContain("Closed");
		expect(html).toContain("Headless browser");
		expect(html).toContain("instance-1/run-1");
	});
});

describe("website access belongs to the agent browser settings", () => {
	it("offers all three choices and shows an inherited exact-host list separately from browser mode", () => {
		const html = view({ websiteAccess: null, agentDefaults: { mode: null, engine: null, profile: null, websiteAccess: { mode: "allowlist", domains: ["jobs.example.com"] } }, effective: { mode: null, engine: null, profile: null, websiteAccess: { mode: "allowlist", domains: ["jobs.example.com"] } }, sources: { mode: "runner", engine: "runner", profile: "runner", websiteAccess: "agent" } });
		for (const label of ["Allow all websites", "Only listed websites", "Ask once for each new website", "Use agent default (Only listed websites)", "Effective access: Only listed websites (from agent)"]) expect(html).toContain(label);
		expect(html).not.toContain("Save website list");
	});
	it("an explicit list is editable and has no implied subdomain wildcard", () => {
		const html = view({ websiteAccess: { mode: "allowlist", domains: ["jobs.example.com", "login.example.com"] } });
		expect(html).toContain("Save website list");
		expect(html).toContain("jobs.example.com\nlogin.example.com");
		expect(html).toContain("separate websites");
	});
});
