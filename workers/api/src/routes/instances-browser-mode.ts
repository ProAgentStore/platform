import type { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { parseBrowserMode, readBrowserMode, writeBrowserMode } from "../lib/browser-mode.js";
import { logEvent } from "../lib/events.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

export function registerBrowserModeRoutes(router: Hono<{ Bindings: Env }>): void {
	router.get("/:instanceId/browser-mode", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		return c.json(await readBrowserMode(c.env, instanceId, session.uid));
	});
	router.put("/:instanceId/browser-mode", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const parsed = parseBrowserMode(await c.req.json().catch(() => null));
		if ("error" in parsed) throw new HttpError(400, parsed.error);
		await writeBrowserMode(c.env, instanceId, session.uid, parsed.mode);
		await logEvent(c.env, { source: "tool", event: "browser_mode.changed", message: `browser mode set to ${parsed.mode ?? "inherit"}`, userId: session.uid, instanceId, level: "info", context: parsed }).catch(() => undefined);
		return c.json(await readBrowserMode(c.env, instanceId, session.uid));
	});
}
