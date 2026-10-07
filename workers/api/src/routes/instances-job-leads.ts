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

/**
 * One explicit triage decision on one Scout lead — the ONLY path that emits the apply handoff.
 * The route below and the Applications control surface (#958) both call this, so a decision made
 * from the Data tab, the Applications tab, `triage_job_lead` or `triage_application` is the same
 * DO transition and the same outbox delivery. The caller has already checked ownership.
 */
export async function runJobLeadTriage(env: Env, instanceId: string, uid: string, recordId: string, body: unknown): Promise<{ status: number; result: TriageResponse & { delivery?: unknown } }> {
	const stub = env.AGENT.get(env.AGENT.idFromName(instanceId));
	const doResponse = await stub.fetch(
		new Request(`https://agent/job-leads/${encodeURIComponent(recordId)}/triage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			// The source instance is the authenticated route's, never the caller's to choose (#955).
			body: JSON.stringify({ ...(body && typeof body === "object" ? body : {}), source_instance_id: instanceId }),
		}),
	);
	const result = (await doResponse.json()) as TriageResponse;
	if (!doResponse.ok) return { status: doResponse.status, result };

	// `event` is persisted with the lead by the DO before this point. Repeating this explicit
	// action after a timeout intentionally replays the same stable event into the connection
	// outbox; its idempotency key collapses it. No generic record update reaches deliverEvent.
	let delivery: unknown = null;
	if (result.event?.eventType === JOB_LEAD_APPLY_EVENT) {
		delivery = await deliverEvent(env, instanceId, uid, JOB_LEAD_APPLY_EVENT, [result.event], {
			traceId: result.event.eventId,
		});
	}
	return { status: 200, result: { ...result, delivery } };
}

export function registerJobLeadRoutes(router: Hono<{ Bindings: Env }>): void {
	router.post("/:instanceId/job-leads/:recordId/triage", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const body = await c.req.json().catch(() => ({}));
		const out = await runJobLeadTriage(c.env, instanceId, session.uid, c.req.param("recordId"), body);
		return c.json(out.result, out.status as 400);
	});
}
