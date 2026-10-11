/**
 * The controller's AI-provider recovery settings, per instance (#907) — an Advanced setting.
 *
 * `GET` answers the effective values (stored overrides on the documented defaults), the bounds and
 * the defaults, so a client can render the control without restating either. `PUT` takes a patch:
 * whole seconds inside the bounds, known keys only; `null` returns a key to its default. A value out of
 * range is refused (400), never clamped silently — a setting that quietly does not apply is the
 * hard-coded value with extra steps.
 */
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import {
	CONTROLLER_AI_BACKOFF_MS,
	CONTROLLER_AI_BOUNDS,
	CONTROLLER_AI_DEFAULTS,
	CONTROLLER_AI_MAX_ATTEMPTS,
	readControllerAiSettings,
	sanitizeControllerAiSettings,
	writeControllerAiSettings,
} from "../lib/controller-ai-recovery.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

export const controllerAiSettingsRoutes = new Hono<{ Bindings: Env }>();

function view(stored: Record<string, number>) {
	return {
		effective: { ...CONTROLLER_AI_DEFAULTS, ...stored },
		overrides: stored,
		defaults: CONTROLLER_AI_DEFAULTS,
		bounds: CONTROLLER_AI_BOUNDS,
		retry: { maxAttempts: CONTROLLER_AI_MAX_ATTEMPTS, backoffMs: CONTROLLER_AI_BACKOFF_MS },
		scope: "The controller's own AI-provider requests (the Pilot, the Loop and the Co-pilot) — not the coding CLI or the runner.",
	};
}

controllerAiSettingsRoutes.get("/:id/controller-ai", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("id");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	return c.json(view(await readControllerAiSettings(c.env, instanceId, session.uid)));
});

controllerAiSettingsRoutes.put("/:id/controller-ai", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("id");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const checked = sanitizeControllerAiSettings(await c.req.json().catch(() => null));
	if (!checked.ok) throw new HttpError(400, checked.error);
	return c.json(view(await writeControllerAiSettings(c.env, instanceId, session.uid, checked.patch)));
});
