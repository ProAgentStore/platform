/**
 * The owner's browser-screenshot switch (#1064): one per instance, covering every browser run that
 * instance makes — legacy workflow tasks (`runtime_task`), local browser research
 * (`local_browser_run`) and Application Runner fills (`local_apply_run`).
 *
 * ON by default, which is the behaviour #1063 shipped: a frame per browser step, form controls
 * blurred first on the local paths, kept owner-only for 30 days. OFF means no frame is taken, pulled,
 * stored or shown for a run started while it is off. The value is FIXED when a run starts (the run
 * records it), so turning the switch mid-run never changes a run partway through.
 *
 * Off is enforced three times, each independent of the others:
 *   1. the runner is told (`screenshots:false` / `screenshot:false`) and takes no frame;
 *   2. the cloud does not pull frames for an off run — an older runner that ignores the flag may
 *      still hold frames in memory, and they are never fetched;
 *   3. `putBrowserArtifact` refuses to store a frame for a subject whose run recorded off.
 *
 * Turning it off deletes nothing already stored: earlier frames expire on their own retention.
 */
import type { Env } from "../types.js";
import { patchInstanceConfig, readInstanceConfigPair } from "./instance-config.js";

export const BROWSER_SCREENSHOTS_KEY = "browserScreenshots";

/** Why a run has no frames, as the run and the audit record it. Never anything sensitive. */
export const SCREENSHOTS_OFF_REASON = "owner_setting";

export interface BrowserScreenshotsSetting {
	enabled: boolean;
}

/** What the owner is told the switch does, shown beside it (console, API, MCP). */
export const BROWSER_SCREENSHOTS_EXPLAINED =
	"When on, every browser step this agent takes is captured as a small screenshot so you can replay the run: form fields are blurred before each frame, frames are visible only to you, and they are deleted after 30 days. When off, no screenshots are taken, pulled or stored for runs started while it is off; earlier screenshots are kept until they expire.";

/** Read the switch from an instance's config blob. Absent or malformed = ON (the shipped default). */
export function readBrowserScreenshots(config: unknown): BrowserScreenshotsSetting {
	const raw = config && typeof config === "object" ? (config as Record<string, unknown>)[BROWSER_SCREENSHOTS_KEY] : undefined;
	return { enabled: !(raw && typeof raw === "object" && (raw as Record<string, unknown>).enabled === false) };
}

/** The switch for one instance, as a run starting now must honour it. A config that cannot be read is ON. */
export async function browserScreenshotsEnabled(env: Env, instanceId: string, uid: string): Promise<boolean> {
	const pair = await readInstanceConfigPair(env, instanceId, uid).catch(() => null);
	return readBrowserScreenshots(pair?.config).enabled;
}

/** Validate a PUT body: exactly `{enabled: boolean}`. */
export function parseBrowserScreenshots(body: unknown): BrowserScreenshotsSetting | { error: string } {
	const b = (body && typeof body === "object" ? body : null) as Record<string, unknown> | null;
	if (!b || typeof b.enabled !== "boolean") return { error: "Send {\"enabled\": true|false}." };
	const extra = Object.keys(b).filter((k) => k !== "enabled");
	if (extra.length) return { error: `Unknown field(s): ${extra.join(", ")}. Only "enabled" can be set.` };
	return { enabled: b.enabled };
}

export async function writeBrowserScreenshots(env: Env, instanceId: string, uid: string, setting: BrowserScreenshotsSetting): Promise<void> {
	await patchInstanceConfig(env, instanceId, uid, BROWSER_SCREENSHOTS_KEY, { enabled: setting.enabled });
}
