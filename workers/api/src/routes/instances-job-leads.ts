/** Explicit Job Search Scout lead triage plus its durable application handoff (#955). */
import type { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { capabilitiesForInstance } from "../lib/agent-capabilities.js";
import { deliverEvent } from "../lib/connections.js";
import { listLeadVerifications, verifyLeadNow } from "../lib/job-lead-browser-verification.js";
import { intakeManualJobUrl } from "../lib/manual-job-url-intake.js";
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

/**
 * A job Scout, as the application pipeline reads one (#1056): a local browser, or an enabled lead-approval edge.
 * Owner-selected intake writes leads ONLY here — never into an arbitrary instance's collections.
 */
async function requireJobScout(env: Env, instanceId: string, userId: string): Promise<void> {
	if ((await capabilitiesForInstance(env, instanceId, userId))?.runtime === "local_browser") return;
	const edge = await env.DB.prepare("SELECT 1 FROM agent_connections WHERE user_id = ?1 AND source_instance_id = ?2 AND event_type = ?3 AND enabled = 1 LIMIT 1")
		.bind(userId, instanceId, JOB_LEAD_APPLY_EVENT)
		.first();
	if (!edge) throw new HttpError(409, "This instance is not a Job Search Scout, so it holds no job leads to add to.");
}

export function registerJobLeadRoutes(router: Hono<{ Bindings: Env }>): void {
	/** Browser verification of this Scout's Gmail leads (#1030): each lead's state, and every attempt's receipt. */
	router.get("/:instanceId/job-leads/browser-verifications", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		return c.json(await listLeadVerifications(c.env, instanceId, session.uid, Number(c.req.query("limit")) || 50));
	});

	/** Verify a waiting lead now instead of at its next turn — the same dispatch the cron makes. */
	router.post("/:instanceId/job-leads/:recordId/browser-verification", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const out = await verifyLeadNow(c.env, instanceId, session.uid, c.req.param("recordId"));
		return "error" in out ? c.json({ error: out.error }, out.status) : c.json(out);
	});

	/**
	 * Owner-selected job URL intake (#1056): ONE pasted public posting of an allowlisted provider becomes a lead
	 * awaiting browser verification, behind the Scout's site consent — never a handoff, never a submit. 422 with
	 * a reason category (never the URL) when it is not a canonical provider posting; `dry_run` writes nothing.
	 */
	router.post("/:instanceId/job-leads/manual-url", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		await requireJobScout(c.env, instanceId, session.uid);
		const body = (await c.req.json().catch(() => ({}))) as { url?: unknown; dry_run?: unknown; dryRun?: unknown };
		if (typeof body.url !== "string" || !body.url.trim()) throw new HttpError(400, "url (a public job posting URL) is required.");
		const out = await intakeManualJobUrl(c.env, { instanceId, userId: session.uid, url: body.url, dryRun: body.dry_run === true || body.dryRun === true });
		return out.ok ? c.json(out, out.duplicate || out.dryRun ? 200 : 201) : c.json({ error: `Not a canonical job posting URL: ${out.reason}.`, reason: out.reason, receipt: out.receipt }, 422);
	});

	router.post("/:instanceId/job-leads/:recordId/triage", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		const body = await c.req.json().catch(() => ({}));
		const out = await runJobLeadTriage(c.env, instanceId, session.uid, c.req.param("recordId"), body);
		return c.json(out.result, out.status as 400);
	});
}
