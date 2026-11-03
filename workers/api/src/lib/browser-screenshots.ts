import { compareVersions } from "./machine-capability-compat.js";
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
import { mergeInstanceConfigObject, readInstanceConfigPair } from "./instance-config.js";

export const BROWSER_SCREENSHOTS_KEY = "browserScreenshots";

/** Why a run has no frames, as the run and the audit record it. Never anything sensitive. */
export const SCREENSHOTS_OFF_REASON = "owner_setting";

export interface BrowserScreenshotsSetting {
	enabled: boolean;
	blurFormFields: boolean;
}

/** What the owner is told the switch does, shown beside it (console, API, MCP). */
export const BROWSER_SCREENSHOTS_EXPLAINED =
	"When on, every browser step this agent takes is captured as a small screenshot so you can replay the run: form fields are blurred by default, frames are visible only to you, and they are deleted after 30 days. Turn off form-field blurring to keep ordinary rendered values visible; native password bullets and credential text redaction remain. Both choices are fixed when a run starts; changes affect future runs. Unblurred screenshots require CLI 0.4.199 or newer. When off, no screenshots are taken, pulled or stored for runs started while it is off; earlier screenshots are kept until they expire.";

/** Read the switch from an instance's config blob. Absent or malformed = ON (the shipped default). */
export function readBrowserScreenshots(config: unknown): BrowserScreenshotsSetting {
	const raw = config && typeof config === "object" ? (config as Record<string, unknown>)[BROWSER_SCREENSHOTS_KEY] : undefined;
	const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
	return { enabled: value.enabled !== false, blurFormFields: value.blurFormFields !== false };
}

/** Defaults retain blurring if the setting cannot be read. */
export async function browserScreenshotSettings(env: Env, instanceId: string, uid: string): Promise<BrowserScreenshotsSetting> {
	const pair = await readInstanceConfigPair(env, instanceId, uid).catch(() => null);
	return readBrowserScreenshots(pair?.config);
}

export async function browserScreenshotsEnabled(env: Env, instanceId: string, uid: string): Promise<boolean> {
	return (await browserScreenshotSettings(env, instanceId, uid)).enabled;
}

/** Independent partial update; omitted controls keep their saved values. */
export function parseBrowserScreenshots(body: unknown): Partial<BrowserScreenshotsSetting> | { error: string } {
	const b = (body && typeof body === "object" && !Array.isArray(body) ? body : null) as Record<string, unknown> | null;
	if (!b || !Object.keys(b).length) return { error: "Send enabled and/or blurFormFields as booleans." };
	const extra = Object.keys(b).filter((k) => k !== "enabled" && k !== "blurFormFields");
	if (extra.length) return { error: `Unknown field(s): ${extra.join(", ")}. Only enabled and blurFormFields can be set.` };
	const patch: Partial<BrowserScreenshotsSetting> = {};
	for (const key of ["enabled", "blurFormFields"] as const) {
		if (!(key in b)) continue;
		if (typeof b[key] !== "boolean") return { error: `${key} must be a boolean.` };
		patch[key] = b[key];
	}
	return patch;
}

export async function writeBrowserScreenshots(env: Env, instanceId: string, uid: string, setting: Partial<BrowserScreenshotsSetting>): Promise<void> {
	await mergeInstanceConfigObject(env, instanceId, uid, BROWSER_SCREENSHOTS_KEY, setting);
}

export const SCREENSHOT_BLUR_MIN_CLI = "0.4.199";
export function screenshotBlurRunnerProblem(blurFormFields: unknown, version: string | null | undefined, node?: string | null): string | null {
	if (blurFormFields !== false) return null;
	if (version && /^v?\d+\.\d+\.\d+(?:[-+].*)?$/.test(version.trim()) && compareVersions(version.trim(), SCREENSHOT_BLUR_MIN_CLI) >= 0) return null;
	return `Unblurred screenshots require CLI ${SCREENSHOT_BLUR_MIN_CLI} or newer on ${node || "this instance's runner"}; registered version is ${version || "unknown"}. Update the runner or turn form-field blurring on before starting a new run.`;
}

/** Generic task callers cannot override the saved owner's capture policy with task input. */
export async function withTaskScreenshotSettings(env: Env, instanceId: string, uid: string, body: { type: string; input?: unknown }): Promise<unknown> {
	if (!["browser.open", "browser.task", "job.apply_agent", "local_browser.research", "local_browser.apply"].includes(String(body.type))) return body;
	const settings = await browserScreenshotSettings(env, instanceId, uid);
	const input = body.input && typeof body.input === "object" ? body.input as Record<string, unknown> : {};
	const policy = input.policy && typeof input.policy === "object" ? input.policy as Record<string, unknown> : {};
	return { ...body, input: { ...input, screenshots: settings.enabled, blurFormFields: settings.blurFormFields, ...(String(body.type).startsWith("local_browser.") ? { policy: { ...policy, screenshots: settings.enabled, blurFormFields: settings.blurFormFields } } : {}) } };
}

/** Existing task inputs are the frozen policy, including legacy defaults. Owner-scoped. */
export async function taskScreenshotSettings(env: Env, instanceId: string, uid: string, taskId: string): Promise<BrowserScreenshotsSetting | null> {
	const row = await env.DB.prepare("SELECT payload FROM instance_runtime_tasks WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3").bind(taskId, instanceId, uid).first<{ payload: string }>();
	if (!row) return null;
	try {
		const input = (JSON.parse(row.payload) as { input?: Record<string, unknown> }).input;
		return { enabled: input?.screenshots !== false, blurFormFields: input?.blurFormFields !== false };
	} catch { return { enabled: true, blurFormFields: true }; }
}

/** Ad-hoc actions use owner settings; continuations retain their task's frozen policy. */
export async function withBrowserCaptureSettings(env: Env, instanceId: string, uid: string, path: string, body: unknown): Promise<unknown> {
	if (!/^\/browser\/(act|handoff)$/.test(path.split("?")[0] ?? path)) return body;
	const b = body && typeof body === "object" ? body as Record<string, unknown> : {};
	// Workflows stamp this after spreading the model action. Existing tasks keep that frozen value.
	if (typeof b.taskId === "string" && b.taskId && typeof b.blurFormFields === "boolean") return body;
	const frozen = typeof b.taskId === "string" && b.taskId ? await taskScreenshotSettings(env, instanceId, uid, b.taskId) : null;
	const setting = frozen ?? await browserScreenshotSettings(env, instanceId, uid);
	const patch = { ...(frozen || !setting.blurFormFields || "blurFormFields" in b ? { blurFormFields: setting.blurFormFields } : {}), ...(frozen ? { screenshot: setting.enabled } : !setting.enabled ? { screenshot: false } : {}) };
	return Object.keys(patch).length ? { ...b, ...patch } : body;
}
