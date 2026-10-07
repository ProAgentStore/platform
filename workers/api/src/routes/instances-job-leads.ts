/** Explicit Job Search Scout lead triage plus its durable application handoff (#955). */
import type { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { deliverEvent } from "../lib/connections.js";
import { JOB_LEAD_APPLY_EVENT, type JobLeadApplyEvent } from "../lib/job-lead-triage.js";
import type { Env } from "../types.js";
import { requireOwnedInstance } from "./instances-runtime.js";

type TriageResponse = {
	record?: unknown;
	action?: string;
	transitioned?: boolean;
	event?: JobLeadApplyEvent | null;
	error?: string;
};

export function registerJobLeadRoutes(router: Hono<{ Bindings: Env }>): void {
	router.post("/:instanceId/job-leads/:recordId/triage", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const body = await c.req.json().catch(() => ({}));
		const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
		const doResponse = await stub.fetch(
			new Request(`https://agent/job-leads/${encodeURIComponent(c.req.param("recordId"))}/triage`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
		);
		const result = (await doResponse.json()) as TriageResponse;
		if (!doResponse.ok) return c.json(result, doResponse.status as 400);

		// `event` is persisted with the lead by the DO before this point. Repeating this explicit
		// action after a timeout intentionally replays the same stable event into the connection
		// outbox; its idempotency key collapses it. No generic record update reaches deliverEvent.
		let delivery: unknown = null;
		if (result.event?.eventType === JOB_LEAD_APPLY_EVENT) {
			delivery = await deliverEvent(c.env, instanceId, session.uid, JOB_LEAD_APPLY_EVENT, [result.event], {
				traceId: result.event.eventId,
			});
		}
		return c.json({ ...result, delivery });
	});
}
