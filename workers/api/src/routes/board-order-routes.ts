// `POST /:instanceId/board/order` (#1097) — place a card in its column: board order is run order.
//
// A helper module for the reason `instances-lifecycle.ts` is one: `instances-tasks.ts`, where the
// board's other writes live, is pinned by the #302 ratchet. The rule and the placement are
// `lib/board-order.ts` and `lib/board-reorder.ts`.

import type { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { parseBoardPlace, reorderBoardItem } from "../lib/board-reorder.js";
import type { Env } from "../types.js";
import { requireOwnedInstance } from "./instances-runtime.js";

export function registerBoardOrderRoutes(router: Hono<{ Bindings: Env }>): void {
	/** `{jobKey, before? | after? | to: "top" | "bottom"}` → the column, in its new order. */
	router.post("/:instanceId/board/order", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const jobKey = typeof body.jobKey === "string" ? body.jobKey : "";
		if (!jobKey) return c.json({ error: "jobKey required" }, 400);
		const place = parseBoardPlace(body);
		if ("error" in place) return c.json({ error: place.error }, 400);
		const { column, items } = await reorderBoardItem(c.env, instanceId, session.uid, jobKey, place);
		return c.json({ column: { id: column.id, title: column.title }, items });
	});
}
