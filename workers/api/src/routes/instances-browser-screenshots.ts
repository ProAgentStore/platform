/** The owner's browser-screenshot switch, per instance (#1064). See lib/browser-screenshots.ts. */
import type { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { BROWSER_SCREENSHOTS_EXPLAINED, browserScreenshotsEnabled, parseBrowserScreenshots, writeBrowserScreenshots } from "../lib/browser-screenshots.js";
import { logEvent } from "../lib/events.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

export function registerBrowserScreenshotsRoutes(router: Hono<{ Bindings: Env }>): void {
	router.get("/:instanceId/browser-screenshots", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		return c.json({ enabled: await browserScreenshotsEnabled(c.env, instanceId, session.uid), explained: BROWSER_SCREENSHOTS_EXPLAINED });
	});
	router.put("/:instanceId/browser-screenshots", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const parsed = parseBrowserScreenshots(await c.req.json().catch(() => null));
		if ("error" in parsed) throw new HttpError(400, parsed.error);
		await writeBrowserScreenshots(c.env, instanceId, session.uid, parsed);
		// Audit: the decision only — which instance, on or off.
		await logEvent(c.env, { source: "tool", event: "browser_screenshots.changed", message: `browser screenshots turned ${parsed.enabled ? "on" : "off"}`, userId: session.uid, instanceId, level: "info", context: { enabled: parsed.enabled } }).catch(() => undefined);
		return c.json({ enabled: await browserScreenshotsEnabled(c.env, instanceId, session.uid), explained: BROWSER_SCREENSHOTS_EXPLAINED });
	});
}
