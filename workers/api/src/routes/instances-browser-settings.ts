import { clipMarked } from "../lib/clip-marked.js";
import type { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { BROWSER_SETTINGS_MIN_CLI, parseBrowserSettings, readBrowserSettings, writeBrowserSettings } from "../lib/browser-settings.js";
import { browserRunnerVersion } from "../lib/browser-settings-dispatch.js";
import { compareVersions } from "../lib/machine-capability-compat.js";
import { callRunner, getBoundRunnerConn } from "../lib/runner-client.js";
import { logEvent } from "../lib/events.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

export function registerBrowserSettingsRoutes(router: Hono<{ Bindings: Env }>): void {
	router.get("/:instanceId/browser-settings", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		return c.json(await readBrowserSettings(c.env, instanceId, session.uid));
	});
	router.put("/:instanceId/browser-settings", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const parsed = parseBrowserSettings(await c.req.json().catch(() => null));
		if ("error" in parsed) throw new HttpError(400, parsed.error);
		await writeBrowserSettings(c.env, instanceId, session.uid, parsed);
		await logEvent(c.env, { source: "tool", event: "browser_settings.changed", message: "browser settings changed", userId: session.uid, instanceId, level: "info", context: parsed }).catch(() => undefined);
		return c.json(await readBrowserSettings(c.env, instanceId, session.uid));
	});
	// A separate read: inspecting configuration must never contact or launch a browser.
	router.get("/:instanceId/browser-settings/session", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		try {
			const conn = await getBoundRunnerConn(c.env, instanceId, session.uid);
			if (!conn) return c.json({ status: "offline", launch: null, launches: [], detail: "This instance's runner is not connected; no launch evidence is available." });
			const version = await browserRunnerVersion(c.env, instanceId, session.uid, conn.runnerNode);
			if (!version || compareVersions(version, BROWSER_SETTINGS_MIN_CLI) < 0) return c.json({ status: "unsupported", launch: null, launches: [], detail: `Browser launch evidence requires CLI ${BROWSER_SETTINGS_MIN_CLI} or newer; registered version is ${version || "unknown"}.` });
			const receipt = await callRunner<{ launch?: unknown; launches?: unknown[] }>(conn, "/browser/session");
			return c.json({ status: "connected", launch: receipt.launch ?? null, launches: receipt.launches ?? (receipt.launch ? [receipt.launch] : []) });
		} catch (error) {
			return c.json({ status: "unavailable", launch: null, launches: [], detail: error instanceof Error ? clipMarked(error.message, 400) : "The runner's launch evidence could not be read." });
		}
	});
}
