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
export const BROWSER_SETTINGS_EXPLAINED = "Each field inherits independently from the agent. Unset engine keeps the workflow's browser selection; an explicit engine never falls back to another browser. Unset profile keeps the workflow default: isolated research is fresh each run, application profiles persist, and default profiles retain their existing behavior. Persistent remembers this agent's state; ephemeral starts fresh each run. Explicit browser selection uses its own managed profile and does not import everyday Chrome data. Changes apply to the next session; active runs keep their launch settings. Browser and profile choices need CLI 0.4.198 or newer.";
export interface BrowserSettings { mode: BrowserMode | null; engine: BrowserEngine | null; profile: BrowserProfilePolicy | null }
export type BrowserSettingsPatch = Partial<BrowserSettings>;
const KEYS = { mode: "browserMode", engine: "browserEngine", profile: "browserProfilePolicy" } as const;
const readFields = (config: Record<string, unknown>): BrowserSettings => ({ mode: browserModeValue(config.browserMode), engine: browserEngineValue(config.browserEngine), profile: browserProfilePolicyValue(config.browserProfilePolicy) });

export function browserSettingsDenial(caps: { browserMode?: unknown; browserEngine?: unknown; browserProfilePolicy?: unknown }): string | null {
	return browserModeDenial(caps)
		?? (caps.browserEngine != null && !browserEngineValue(caps.browserEngine) ? `capabilities.browserEngine must be ${BROWSER_ENGINES.join(", ")}, or null to inherit.` : null)
		?? (caps.browserProfilePolicy != null && !browserProfilePolicyValue(caps.browserProfilePolicy) ? 'capabilities.browserProfilePolicy must be "persistent", "ephemeral", or null to inherit.' : null);
}

export function browserSettingsView(config: Record<string, unknown>, agentConfig: Record<string, unknown>) {
	const caps = agentConfig.capabilities && typeof agentConfig.capabilities === "object" ? agentConfig.capabilities as Record<string, unknown> : {};
	const overrides = readFields(config);
	const agentDefaults = readFields(caps);
	const effective: BrowserSettings = { mode: overrides.mode ?? agentDefaults.mode, engine: overrides.engine ?? agentDefaults.engine, profile: overrides.profile ?? agentDefaults.profile };
	const source = (key: keyof BrowserSettings) => overrides[key] ? "instance" as const : agentDefaults[key] ? "agent" as const : "runner" as const;
	return { ...overrides, agentDefaults, effective, sources: { mode: source("mode"), engine: source("engine"), profile: source("profile") }, requiredCli: effective.engine || effective.profile ? BROWSER_SETTINGS_MIN_CLI : BROWSER_MODE_MIN_CLI, explained: BROWSER_SETTINGS_EXPLAINED };
}

export async function readBrowserSettings(env: Env, instanceId: string, uid: string) {
	const pair = await readInstanceConfigPair(env, instanceId, uid);
	return browserSettingsView(pair?.config ?? {}, pair?.agentConfig ?? {});
}

export function parseBrowserSettings(body: unknown): BrowserSettingsPatch | { error: string } {
	if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Send a browser settings patch containing mode, engine, or profile." };
	const raw = body as Record<string, unknown>;
	if (!Object.keys(raw).length || Object.keys(raw).some((key) => !Object.hasOwn(KEYS, key))) return { error: "Only mode, engine and profile can be changed. Send at least one field; null clears its override." };
	const out: BrowserSettingsPatch = {};
	for (const key of Object.keys(KEYS) as Array<keyof BrowserSettings>) {
		if (!(key in raw)) continue;
		const valid = key === "mode" ? browserModeValue(raw[key]) : key === "engine" ? browserEngineValue(raw[key]) : browserProfilePolicyValue(raw[key]);
		if (raw[key] !== null && valid === null) return { error: `Invalid ${key}. Use ${key === "mode" ? "headed or headless" : key === "engine" ? BROWSER_ENGINES.join(", ") : "persistent or ephemeral"}, or null to inherit.` };
		Object.assign(out, { [key]: valid });
	}
	return out;
}

/** One atomic patch: omitted fields and unrelated settings survive; null clears only that override. */
export async function writeBrowserSettings(env: Env, instanceId: string, uid: string, patch: BrowserSettingsPatch): Promise<void> {
	const stored = Object.fromEntries(Object.entries(patch).map(([key, value]) => [KEYS[key as keyof BrowserSettings], value]));
	await patchInstanceConfigFields(env, instanceId, uid, stored);
}
