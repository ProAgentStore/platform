// GET /v1/board/projection — every card of every agent the owner has, in the same four lanes as one agent's board (#1698).
// Aggregation only: the rule is lib/board-projection.ts (`readAllAgentsProjection` calls the per-instance read), so the All Agents
// board and an agent's own board cannot classify differently. Owner-scoped; read-only.
import { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { BOARD_LANE_IDS, BOARD_LANE_TITLES, readAllAgentsProjection } from "../lib/board-projection.js";
import type { Env } from "../types.js";

export const boardAllRoutes = new Hono<{ Bindings: Env }>();

boardAllRoutes.get("/board/projection", async (c) => {
	const session = await requireUser(c);
	const { agents, truncated } = await readAllAgentsProjection(c.env, session.uid);
	return c.json({ lanes: BOARD_LANE_IDS.map((id) => ({ id, title: BOARD_LANE_TITLES[id] })), agents, truncated });
});
