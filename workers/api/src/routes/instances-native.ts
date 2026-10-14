/** The `local_native` runtime's owner routes (#1057). Slice 1: the read-only machine preflight. */
import type { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { nativePreflight } from "../lib/native/preflight.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

export function registerNativeRoutes(router: Hono<{ Bindings: Env }>): void {
	router.get("/:instanceId/native/preflight", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const out = await nativePreflight(c.env, instanceId, session.uid);
		return c.json(out.body, out.status);
	});
}
