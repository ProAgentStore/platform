import type { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { readActionLog } from "../lib/task-action-log.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

/**
 * A board card's action log (#1108) — every step the agent took on that card, oldest first, for
 * every task type (coding, application Tailor/Runner, browser). `?cursor=` is the previous reply's
 * `nextCursor` (more history) or its `tail` (only what is new since — how a live view polls);
 * `?limit=` 1–50, default 20. Owner-only: another owner's card, or a card not on this instance, is 404.
 */
export function registerTaskActionRoutes(router: Hono<{ Bindings: Env }>): void {
	router.get("/:instanceId/tasks/:taskId/actions", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const page = await readActionLog(c.env, { instanceId, userId: session.uid, taskId: c.req.param("taskId"), cursor: c.req.query("cursor") ?? null, limit: Number(c.req.query("limit")) || undefined });
		if ("error" in page) {
			if (page.error === "bad_cursor") throw new HttpError(400, "`cursor` is not one this log returned — pass a reply's `nextCursor` or `tail`, or omit it to start at the beginning.");
			throw new HttpError(404, "No such card on this instance.");
		}
		return c.json(page);
	});
}
