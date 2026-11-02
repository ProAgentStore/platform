/** Browser visibility belongs to an agent, with an owner override for each instance. */
import type { Env } from "../types.js";
import { patchInstanceConfig, readInstanceConfigPair } from "./instance-config.js";

export const BROWSER_MODE_MIN_CLI = "0.4.197";
export type BrowserMode = "headed" | "headless";
export const browserModeValue = (value: unknown): BrowserMode | null => value === "headed" || value === "headless" ? value : null;
export const BROWSER_MODE_EXPLAINED = "Visible (headed) opens a browser window on the runner's desktop; headless runs without a window. This instance overrides the agent default. With neither set, the runner launch default applies. Explicit modes require CLI 0.4.197 or newer. Changes apply to the next browser session; active runs keep their mode.";

export function browserModeDenial(caps: { browserMode?: unknown }): string | null {
	return caps.browserMode != null && !browserModeValue(caps.browserMode) ? 'capabilities.browserMode must be "headed", "headless", or null to inherit the runner default.' : null;
}

export function browserModeView(config: Record<string, unknown>, agentConfig: Record<string, unknown>) {
	const caps = agentConfig.capabilities as { browserMode?: unknown } | undefined;
	const mode = browserModeValue(config.browserMode);
	const agentDefault = browserModeValue(caps?.browserMode);
	return { mode, agentDefault, effective: mode ?? agentDefault, source: mode ? "instance" as const : agentDefault ? "agent" as const : "runner" as const, explained: BROWSER_MODE_EXPLAINED, requiredCli: BROWSER_MODE_MIN_CLI };
}

export async function readBrowserMode(env: Env, instanceId: string, uid: string) {
	const pair = await readInstanceConfigPair(env, instanceId, uid);
	return browserModeView(pair?.config ?? {}, pair?.agentConfig ?? {});
}

export function parseBrowserMode(body: unknown): { mode: BrowserMode | null } | { error: string } {
	if (!body || typeof body !== "object" || Array.isArray(body)) return { error: 'Send {"mode":"headed"|"headless"|null}.' };
	const b = body as Record<string, unknown>;
	if (Object.keys(b).some((key) => key !== "mode") || !("mode" in b) || (b.mode !== null && !browserModeValue(b.mode))) return { error: 'Only mode may be set: "headed", "headless", or null to inherit the agent default.' };
	return { mode: browserModeValue(b.mode) };
}

export async function writeBrowserMode(env: Env, instanceId: string, uid: string, mode: BrowserMode | null): Promise<void> {
	await patchInstanceConfig(env, instanceId, uid, "browserMode", mode);
}
