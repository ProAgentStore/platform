import type { WebsiteAccessSettings } from "./websiteAccess";
export type BrowserMode = "headed" | "headless";
export type BrowserEngine = "chrome" | "msedge" | "chromium" | "firefox" | "webkit";
export type BrowserProfilePolicy = "persistent" | "ephemeral";
export interface BrowserSettings {
	mode: BrowserMode | null;
	engine: BrowserEngine | null;
	profile: BrowserProfilePolicy | null;
	websiteAccess?: WebsiteAccessSettings | null;
}
export type BrowserSettingKey = "mode" | "engine" | "profile";
export type BrowserSettingSource = "instance" | "agent" | "runner";
export interface BrowserSettingsView extends BrowserSettings {
	agentDefaults: BrowserSettings;
	effective: BrowserSettings;
	sources: Record<BrowserSettingKey, BrowserSettingSource> & { websiteAccess?: BrowserSettingSource };
	requiredCli: string;
	explained: string;
}
export interface BrowserCapabilities {
	browserMode?: BrowserMode | null;
	browserEngine?: BrowserEngine | null;
	browserProfilePolicy?: BrowserProfilePolicy | null;
	browserWebsiteAccess?: WebsiteAccessSettings | null;
}
export const BROWSER_FIELDS = [
	{ key: "mode", label: "Browser mode", options: [["headed", "Visible browser"], ["headless", "Headless browser"]] },
	{ key: "engine", label: "Browser", options: [["chrome", "Installed Google Chrome"], ["msedge", "Installed Microsoft Edge"], ["chromium", "Playwright Chromium"], ["firefox", "Playwright Firefox"], ["webkit", "Playwright WebKit"]] },
	{ key: "profile", label: "Browser profile", options: [["persistent", "Persistent — remember this agent's logins"], ["ephemeral", "Ephemeral — fresh profile for each run"]] },
] as const;

export function browserSettingLabel(key: BrowserSettingKey, value: BrowserSettings[BrowserSettingKey]): string {
	return BROWSER_FIELDS.find((field) => field.key === key)?.options.find(([option]) => option === value)?.[1] ?? (key === "profile" ? "Workflow default" : "Runner default");
}

export const BROWSER_SETTING_SOURCE_LABELS: Record<BrowserSettingSource, string> = { instance: "instance override", agent: "from agent", runner: "runner default" };

export function browserCapabilitiesPatch(patch: Partial<BrowserSettings>): Partial<BrowserCapabilities> {
	return {
		...("mode" in patch ? { browserMode: patch.mode } : {}),
		...("engine" in patch ? { browserEngine: patch.engine } : {}),
		...("profile" in patch ? { browserProfilePolicy: patch.profile } : {}),
		...("websiteAccess" in patch ? { browserWebsiteAccess: patch.websiteAccess } : {}),
	};
}
