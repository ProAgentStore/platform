/**
 * The Applications control surface (#958) for the console — a thin owner-scoped shell over
 * `lib/applications/control.ts`. The typed MCP application tools (`workers/mcp/src/instance-tools/
 * applications.ts`) call these same routes, so a decision made in the console and one made over MCP
 * land the same transition and the same audit row.
 */
import type { Context, Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { QUEUE_STATUSES, type QueueStatus, applicationQueue, applicationTrace, getQueueItem, parseActionInput, performApplicationAction } from "../lib/applications/control.js";
import type { Env } from "../types.js";
import { requireOwnedInstance } from "./instances-runtime.js";

type C = Context<{ Bindings: Env }>;

async function owned(c: C): Promise<{ uid: string; instanceId: string }> {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId") ?? "";
	await requireOwnedInstance(c.env, instanceId, session.uid);
	return { uid: session.uid, instanceId };
}

export function registerApplicationsRoutes(router: Hono<{ Bindings: Env }>): void {
	router.get("/:instanceId/application-queue", async (c) => {
		const { uid, instanceId } = await owned(c);
		const status = c.req.query("status");
		if (status && !(QUEUE_STATUSES as readonly string[]).includes(status)) return c.json({ error: `status must be one of ${QUEUE_STATUSES.join(", ")}` }, 400);
		const sort = c.req.query("sort") === "title" ? "title" : "updated";
		return c.json(await applicationQueue(c.env, uid, instanceId, { status: status as QueueStatus | undefined, sort }));
	});

	router.get("/:instanceId/application-queue/item", async (c) => {
		const { uid, instanceId } = await owned(c);
		const { item } = await getQueueItem(c.env, uid, instanceId, { applicationId: c.req.query("application_id"), scoutInstanceId: c.req.query("scout_instance_id"), recordId: c.req.query("record_id") });
		return c.json({ item });
	});

	/** One typed action: `{action, application_id | scout_instance_id+record_id, expected_status, expected_version?, …}`. */
	router.post("/:instanceId/application-queue/actions", async (c) => {
		const { uid, instanceId } = await owned(c);
		return c.json(await performApplicationAction(c.env, uid, instanceId, parseActionInput(await c.req.json().catch(() => null))));
	});

	router.get("/:instanceId/application-queue/:applicationId/trace", async (c) => {
		const { uid, instanceId } = await owned(c);
		return c.json(await applicationTrace(c.env, uid, instanceId, c.req.param("applicationId")));
	});
}
