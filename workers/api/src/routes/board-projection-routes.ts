// `GET /:instanceId/board/projection` (#1698) — the shared card projection of actual execution, in four lanes.
//
// A helper module for the reason `board-order-routes.ts` is one: `instances-tasks.ts`, where the board's other routes live, is pinned
// by the #302 ratchet. The rule is `lib/board-projection.ts` (the one classifier every board shares) and identity is
// `lib/board-identity.ts`.

import type { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { BOARD_LANE_IDS, BOARD_LANE_TITLES, readBoardProjection } from "../lib/board-projection.js";
import type { Env } from "../types.js";
import { requireOwnedInstance } from "./instances-runtime.js";

export function registerBoardProjectionRoutes(router: Hono<{ Bindings: Env }>): void {
	/**
	 * One card per resumable coding session or real application / scan attempt, plus every accepted objective that has no session
	 * yet, each in one of queued / in_progress / blocked / done. Owner- and instance-scoped and read-only; a GitHub issue is never an input.
	 */
	router.get("/:instanceId/board/projection", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const cards = await readBoardProjection(c.env, instanceId, session.uid);
		return c.json({ lanes: BOARD_LANE_IDS.map((id) => ({ id, title: BOARD_LANE_TITLES[id] })), cards });
	});
}
