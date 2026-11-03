import { screenshotBlurRunnerProblem, taskScreenshotSettings } from "./browser-screenshots.js";
import type { Env } from "../types.js";
import { compareVersions } from "./machine-capability-compat.js";
import { readBrowserSettings } from "./browser-settings.js";
import type { BrowserMode } from "./browser-mode.js";
import type { BrowserEngine, BrowserProfilePolicy } from "./browser-settings.js";

export interface BrowserDispatchSettings { browserMode?: BrowserMode; browserEngine?: BrowserEngine; browserProfilePolicy?: BrowserProfilePolicy }

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
export async function browserSettingsForDispatch(env: Env, instanceId: string, uid: string, path: string, node?: string | null, registeredVersion?: string | null, body?: unknown): Promise<BrowserDispatchSettings> {
	if (!browserModePath(path, body)) return {};
	const approval = /^\/tasks\/([^/]+)\/approve$/.exec(path.split("?")[0] ?? path);
	const approvalTask = approval ? await env.DB.prepare("SELECT type, payload FROM instance_runtime_tasks WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3").bind(decodeURIComponent(approval[1]), instanceId, uid).first<{ type: string; payload?: string }>() : null;
	let approvalInput: Record<string, unknown> = {};
	if (approvalTask?.type === "browser.open" && approvalTask.payload) {
		try { approvalInput = (JSON.parse(approvalTask.payload) as { input?: Record<string, unknown> }).input ?? {}; } catch { /* Legacy defaults remain blurred. */ }
	}
	// The run's frozen owner value, never re-read from a setting that may change mid-run.
	const captureBody = body && typeof body === "object" ? body as Record<string, unknown> : {};
	const captureInput = approval ? approvalInput : captureBody.input && typeof captureBody.input === "object" ? captureBody.input as Record<string, unknown> : {};
	const capturePolicy = captureBody.policy && typeof captureBody.policy === "object" ? captureBody.policy as Record<string, unknown> : {};
	const wantsUnblurred = captureBody.blurFormFields === false || captureInput.blurFormFields === false || capturePolicy.blurFormFields === false;
	const captureEnabled = captureBody.screenshot !== false && captureInput.screenshots !== false && capturePolicy.screenshots !== false;
	const existingHandoff = path === "/browser/handoff" && typeof captureBody.taskId === "string" ? await taskScreenshotSettings(env, instanceId, uid, captureBody.taskId) : null;
	if ((startsBrowserSession(path, body) || (path === "/browser/handoff" && !existingHandoff)) && captureEnabled && wantsUnblurred) {
		const version = registeredVersion === undefined ? await browserRunnerVersion(env, instanceId, uid, node) : registeredVersion;
		const problem = screenshotBlurRunnerProblem(false, version, node);
		if (problem) throw new Error(problem);
	}
	const settings = await readBrowserSettings(env, instanceId, uid);
	const { mode, engine, profile } = settings.effective;
	const wire: BrowserDispatchSettings = { ...(mode ? { browserMode: mode } : {}), ...(engine ? { browserEngine: engine } : {}), ...(profile ? { browserProfilePolicy: profile } : {}) };
	if (!mode && !engine && !profile) return wire;
	if (!startsBrowserSession(path, body)) return wire;
	if (approvalTask && approvalTask.type !== "browser.open") return wire;

	const version = registeredVersion === undefined ? await browserRunnerVersion(env, instanceId, uid, node) : registeredVersion;
	if (!version || !/^v?\d+\.\d+\.\d+(?:[-+].*)?$/.test(version.trim()) || compareVersions(version.trim(), settings.requiredCli) < 0) {
		throw new Error(`Browser ${engine || profile ? "settings" : `mode ${mode}`} requires CLI ${settings.requiredCli} or newer on ${node || "this instance's runner"}; registered version is ${version || "unknown"}. Update the runner before starting a browser session, or clear the explicit browser settings to use its launch default.`);
	}
	return wire;
}

export async function browserRunnerVersion(env: Env, instanceId: string, uid: string, node?: string | null): Promise<string | null> {
	const row = await (node
		? env.DB.prepare("SELECT runner_version FROM instance_runtime_nodes WHERE instance_id = ?1 AND user_id = ?2 AND runner_node = ?3").bind(instanceId, uid, node)
		: env.DB.prepare("SELECT runner_version FROM instance_runtimes WHERE instance_id = ?1 AND user_id = ?2").bind(instanceId, uid)
	).first<{ runner_version: string | null }>();
	return row?.runner_version ?? null;
}
