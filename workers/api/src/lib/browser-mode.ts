/** Browser visibility belongs to an agent, with an owner override for each instance. */
import { compareVersions } from "./machine-capability-compat.js";
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

/** Only browser-bearing dispatches read the setting. The cloud supplies it, never model input. */
export function browserModePath(path: string, body?: unknown): boolean {
	const route = path.split("?")[0] ?? path;
	const type = body && typeof body === "object" ? (body as { type?: unknown }).type : undefined;
	return /^\/tasks\/[^/]+\/approve$/.test(route) || /^\/(?:browser|local-browser|local-apply|takeover)(?:\/|$)/.test(route)
		|| (route === "/tasks" && ["browser.open", "browser.task", "job.apply_agent", "local_browser.research", "local_browser.apply"].includes(String(type)));
}

/** Starts need support; observing, completing, or resuming an existing run must remain possible. */
function startsBrowserSession(path: string, body?: unknown): boolean {
	const route = (path.split("?")[0] ?? path).replace(/\/$/, "");
	if (route === "/tasks") return browserModePath(route, body);
	if (/^\/tasks\/[^/]+\/approve$/.test(route)) return true;
	if (["/local-browser/run", "/local-apply/run", "/local-apply/preflight", "/local-apply/sign-in", "/local-apply/reconciliation/run"].includes(route)) return true;
	const taskId = body && typeof body === "object" ? (body as { taskId?: unknown }).taskId : undefined;
	return /^\/browser\/(act|snapshot)$/.test(route) && !(typeof taskId === "string" && taskId.length > 0);
}

/** Old runners ignore this wire field. Refuse explicit configuration before it can silently lose. */
export async function browserModeForDispatch(env: Env, instanceId: string, uid: string, path: string, node?: string | null, registeredVersion?: string | null, body?: unknown): Promise<BrowserMode | null> {
	if (!browserModePath(path, body)) return null;
	const mode = (await readBrowserMode(env, instanceId, uid)).effective;
	if (!mode) return null;
	if (!startsBrowserSession(path, body)) return mode;
	const approval = /^\/tasks\/([^/]+)\/approve$/.exec(path.split("?")[0] ?? path);
	if (approval) {
		const task = await env.DB.prepare("SELECT type FROM instance_runtime_tasks WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3").bind(decodeURIComponent(approval[1]), instanceId, uid).first<{ type: string }>();
		if (task && task.type !== "browser.open") return mode;
	}

	let version = registeredVersion;
	if (version === undefined) {
		const row = await (node
			? env.DB.prepare("SELECT runner_version FROM instance_runtime_nodes WHERE instance_id = ?1 AND user_id = ?2 AND runner_node = ?3").bind(instanceId, uid, node)
			: env.DB.prepare("SELECT runner_version FROM instance_runtimes WHERE instance_id = ?1 AND user_id = ?2").bind(instanceId, uid)
		).first<{ runner_version: string | null }>();
		version = row?.runner_version;
	}
	if (!version || !/^v?\d+\.\d+\.\d+(?:[-+].*)?$/.test(version.trim()) || compareVersions(version.trim(), BROWSER_MODE_MIN_CLI) < 0) {
		throw new Error(`Browser mode ${mode} requires CLI ${BROWSER_MODE_MIN_CLI} or newer on ${node || "this instance's runner"}; registered version is ${version || "unknown"}. Update the runner before starting a browser session, or clear the explicit browser mode to use its launch default.`);
	}
	return mode;
}
