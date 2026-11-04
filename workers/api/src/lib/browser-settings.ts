import { browserWebsiteAccessValue, BROWSER_WEBSITE_ACCESS_MIN_CLI, type BrowserWebsiteAccess } from "./browser-website-policy.js";
/** Agent browser choices, resolved independently; unset fields retain their workflow defaults (#1431). */
import type { Env } from "../types.js";
import { browserModeDenial, browserModeValue, BROWSER_MODE_MIN_CLI, type BrowserMode } from "./browser-mode.js";
import { patchInstanceConfigFields, readInstanceConfigPair } from "./instance-config.js";

export const BROWSER_SETTINGS_MIN_CLI = "0.4.198";
export const BROWSER_ENGINES = ["chrome", "msedge", "chromium", "firefox", "webkit"] as const;
export type BrowserEngine = (typeof BROWSER_ENGINES)[number];
export type BrowserProfilePolicy = "persistent" | "ephemeral";
export const browserEngineValue = (value: unknown): BrowserEngine | null => BROWSER_ENGINES.includes(value as BrowserEngine) ? value as BrowserEngine : null;
export const browserProfilePolicyValue = (value: unknown): BrowserProfilePolicy | null => value === "persistent" || value === "ephemeral" ? value : null;
export const BROWSER_SETTINGS_EXPLAINED = "Each field inherits independently from the agent. Unset engine keeps the workflow's browser selection; an explicit engine never falls back to another browser. Unset profile keeps the workflow default: isolated research is fresh each run, application profiles persist, and default profiles retain their existing behavior. Persistent remembers this agent's state; ephemeral starts fresh each run. Explicit browser selection uses its own managed profile and does not import everyday Chrome data. Changes apply to the next session; active runs keep their launch settings. Browser and profile choices need CLI 0.4.198 or newer. Website access requires CLI 0.4.209: allow_all opens HTTP(S) sites without asking; allowlist permits only exact configured hosts; ask_once remembers owner-approved hosts for this agent. It does not authorize submission or release credentials. Unset website access preserves the workflow's legacy policy.";
export interface BrowserSettings { mode: BrowserMode | null; engine: BrowserEngine | null; profile: BrowserProfilePolicy | null; websiteAccess: BrowserWebsiteAccess | null }
export type BrowserSettingsPatch = Partial<BrowserSettings>;
const KEYS = { mode: "browserMode", engine: "browserEngine", profile: "browserProfilePolicy", websiteAccess: "browserWebsiteAccess" } as const;
const readFields = (config: Record<string, unknown>): BrowserSettings => ({ mode: browserModeValue(config.browserMode), engine: browserEngineValue(config.browserEngine), profile: browserProfilePolicyValue(config.browserProfilePolicy), websiteAccess: browserWebsiteAccessValue(config.browserWebsiteAccess) });

export function browserSettingsDenial(caps: { browserMode?: unknown; browserEngine?: unknown; browserProfilePolicy?: unknown; browserWebsiteAccess?: unknown }): string | null {
	return browserModeDenial(caps)
		?? (caps.browserEngine != null && !browserEngineValue(caps.browserEngine) ? `capabilities.browserEngine must be ${BROWSER_ENGINES.join(", ")}, or null to inherit.` : null)
		?? (caps.browserWebsiteAccess != null && !browserWebsiteAccessValue(caps.browserWebsiteAccess) ? 'capabilities.browserWebsiteAccess must contain a mode (allow_all, allowlist, ask_once) and up to 100 bare hostnames in domains, or null to inherit.' : null)
		?? (caps.browserProfilePolicy != null && !browserProfilePolicyValue(caps.browserProfilePolicy) ? 'capabilities.browserProfilePolicy must be "persistent", "ephemeral", or null to inherit.' : null);
}

export function browserSettingsView(config: Record<string, unknown>, agentConfig: Record<string, unknown>) {
	const caps = agentConfig.capabilities && typeof agentConfig.capabilities === "object" ? agentConfig.capabilities as Record<string, unknown> : {};
	for (const source of [config, caps]) if (source.browserWebsiteAccess != null && !browserWebsiteAccessValue(source.browserWebsiteAccess)) throw new Error("Saved website access settings are invalid; correct websiteAccess before running this agent.");
	const overrides = readFields(config);
	const agentDefaults = readFields(caps);
	const effective: BrowserSettings = { mode: overrides.mode ?? agentDefaults.mode, engine: overrides.engine ?? agentDefaults.engine, profile: overrides.profile ?? agentDefaults.profile, websiteAccess: overrides.websiteAccess ?? agentDefaults.websiteAccess };
	const source = (key: keyof BrowserSettings) => overrides[key] ? "instance" as const : agentDefaults[key] ? "agent" as const : "runner" as const;
	return { ...overrides, agentDefaults, effective, sources: { mode: source("mode"), engine: source("engine"), profile: source("profile"), websiteAccess: source("websiteAccess") }, requiredCli: effective.websiteAccess ? BROWSER_WEBSITE_ACCESS_MIN_CLI : effective.engine || effective.profile ? BROWSER_SETTINGS_MIN_CLI : BROWSER_MODE_MIN_CLI, explained: BROWSER_SETTINGS_EXPLAINED };
}

export async function readBrowserSettings(env: Env, instanceId: string, uid: string) {
	const pair = await readInstanceConfigPair(env, instanceId, uid);
	return browserSettingsView(pair?.config ?? {}, pair?.agentConfig ?? {});
}

export function parseBrowserSettings(body: unknown): BrowserSettingsPatch | { error: string } {
	if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Send a browser settings patch containing mode, engine, profile or websiteAccess." };
	const raw = body as Record<string, unknown>;
	if (!Object.keys(raw).length || Object.keys(raw).some((key) => !Object.hasOwn(KEYS, key))) return { error: "Only mode, engine, profile and websiteAccess can be changed. Send at least one field; null clears its override." };
	const out: BrowserSettingsPatch = {};
	for (const key of Object.keys(KEYS) as Array<keyof BrowserSettings>) {
		if (!(key in raw)) continue;
		const valid = key === "mode" ? browserModeValue(raw[key]) : key === "engine" ? browserEngineValue(raw[key]) : key === "websiteAccess" ? browserWebsiteAccessValue(raw[key]) : browserProfilePolicyValue(raw[key]);
		if (raw[key] !== null && valid === null) return { error: `Invalid ${key}. Use ${key === "mode" ? "headed or headless" : key === "engine" ? BROWSER_ENGINES.join(", ") : key === "websiteAccess" ? "{ mode: allow_all | allowlist | ask_once, domains: up to 100 exact hostnames }" : "persistent or ephemeral"}, or null to inherit.` };
		Object.assign(out, { [key]: valid });
	}
	return out;
}

/** One atomic patch: omitted fields and unrelated settings survive; null clears only that override. */
export async function writeBrowserSettings(env: Env, instanceId: string, uid: string, patch: BrowserSettingsPatch): Promise<void> {
	const stored = Object.fromEntries(Object.entries(patch).map(([key, value]) => [KEYS[key as keyof BrowserSettings], value]));
	await patchInstanceConfigFields(env, instanceId, uid, stored);
}
