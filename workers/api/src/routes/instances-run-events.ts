/**
 * The run-event feed (#579) — what a client reads to learn a run ended, instead of re-polling run state.
 *
 * Owner-scoped twice over: `requireOwnedInstance` first, then `listRunEvents` filters by BOTH the
 * owner and the instance. `since` is the `seq` of the last event already seen (exclusive); the
 * response's `nextCursor` is what to send next, and equals `since` when nothing new has arrived.
 */
import { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { listRunEvents } from "../lib/run-events.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

export const runEventRoutes = new Hono<{ Bindings: Env }>();

/** GET /v1/instances/:instanceId/run-events?since=<seq>&limit=<n> — this instance's run.finished / run.stalled events, oldest first. */
runEventRoutes.get("/:instanceId/run-events", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const since = Number(c.req.query("since") ?? 0);
	const limit = Number(c.req.query("limit") ?? 50);
	if (!Number.isFinite(since) || since < 0) return c.json({ error: "since must be a non-negative event seq" }, 400);
	return c.json(await listRunEvents(c.env, session.uid, instanceId, { since, limit: Number.isFinite(limit) ? limit : 50 }));
});
