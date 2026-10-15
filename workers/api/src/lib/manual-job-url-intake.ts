/**
 * Owner-selected job URL intake (#1056): the owner pastes ONE public job posting, and it enters the existing
 * pipeline exactly as a found lead would — never around it.
 *
 * - Only an allowlisted provider's canonical posting (`validateManualJobUrl`); the pasted URL is never stored.
 * - Idempotent per owner and posting: the `created` receipt is claimed FIRST under a unique index, so two
 *   pastes racing cannot both create; the second, into any of the owner's Scouts, gets the first one's lead.
 * - The lead is written only through the Scout's job-lead create-or-get (work_key dedupe) — no generic
 *   collection write — and only into an instance the route has checked IS a job Scout.
 * - It is stored `awaiting_browser_verification`, never `unverified`: browser verification, behind the Scout's
 *   #1049 site policy and per-site consent, is the only way it becomes `new` with `verification.state: live`,
 *   and triage refuses Apply until then. Nothing is handed to the Tailor or Runner (`handoff: "none"`), and the
 *   Runner's final-submit approval is untouched.
 */
import type { Env } from "../types.js";
import { enqueueBrowserVerification } from "./job-lead-queue.js";
import { type JobLeadLifecycleEntry, workKeyForLead } from "./job-lead-triage.js";
import { type ManualUrlRejectionReason, validateManualJobUrl } from "./manual-job-url.js";

export interface IntakeReceipt {
	id: string;
	instanceId: string;
	outcome: "created" | "duplicate" | "rejected";
	canonicalUrl: string | null;
	provider: string | null;
	leadId: string | null;
	rejectionReason: ManualUrlRejectionReason | null;
	rejectionHost: string | null;
	createdAt: string;
}

export type ManualUrlIntakeResult =
	| { ok: true; dryRun: boolean; duplicate: boolean; receipt: IntakeReceipt | null; canonicalUrl: string; provider: string; leadId: string | null; instanceId: string; verificationState: string | null; handoff: "none" }
	| { ok: false; reason: ManualUrlRejectionReason; receipt: IntakeReceipt | null };

const asReceipt = (r: Record<string, unknown>): IntakeReceipt => ({
	id: String(r.id),
	instanceId: String(r.instance_id),
	outcome: r.outcome as IntakeReceipt["outcome"],
	canonicalUrl: (r.canonical_url as string | null) ?? null,
	provider: (r.provider as string | null) ?? null,
	leadId: (r.lead_id as string | null) ?? null,
	rejectionReason: (r.rejection_reason as ManualUrlRejectionReason | null) ?? null,
	rejectionHost: (r.rejection_host as string | null) ?? null,
	createdAt: String(r.created_at),
});

async function receipt(env: Pick<Env, "DB">, id: string): Promise<IntakeReceipt> {
	return asReceipt((await env.DB.prepare("SELECT * FROM job_lead_intake_receipts WHERE id = ?1").bind(id).first<Record<string, unknown>>()) as Record<string, unknown>);
}

/** The owner's first accepted intake of this posting, wherever it went. */
const firstIntake = (env: Pick<Env, "DB">, userId: string, canonicalUrl: string) =>
	env.DB.prepare("SELECT * FROM job_lead_intake_receipts WHERE user_id = ?1 AND canonical_url = ?2 AND outcome = 'created'").bind(userId, canonicalUrl).first<Record<string, unknown>>();

/** The current verification state of a lead, when it has a row. */
async function verificationStateOf(env: Pick<Env, "DB">, instanceId: string, leadId: string | null): Promise<string | null> {
	if (!leadId) return null;
	const row = await env.DB.prepare("SELECT state FROM job_lead_browser_verifications WHERE instance_id = ?1 AND lead_id = ?2").bind(instanceId, leadId).first<{ state: string }>();
	return row?.state ?? null;
}

/** The caller has checked the instance is the owner's job Scout (`routes/instances-job-leads.ts`). */
export async function intakeManualJobUrl(env: Env, input: { instanceId: string; userId: string; url: string; dryRun?: boolean }): Promise<ManualUrlIntakeResult> {
	const { instanceId, userId } = input;
	const checked = validateManualJobUrl(input.url);
	if (!checked.ok) {
		if (input.dryRun) return { ok: false, reason: checked.reason, receipt: null };
		const id = crypto.randomUUID();
		await env.DB.prepare("INSERT INTO job_lead_intake_receipts (id, user_id, instance_id, outcome, rejection_reason, rejection_host) VALUES (?1, ?2, ?3, 'rejected', ?4, ?5)")
			.bind(id, userId, instanceId, checked.reason, checked.host)
			.run();
		return { ok: false, reason: checked.reason, receipt: await receipt(env, id) };
	}
	const { canonicalUrl, provider } = checked;
	/** `leadInstance`: where the lead lives — the first intake's Scout, for a duplicate pasted into another one. */
	const answer = (r: IntakeReceipt | null, duplicate: boolean, leadId: string | null, leadInstance: string, state: string | null, dryRun = false): ManualUrlIntakeResult => ({
		ok: true, dryRun, duplicate, receipt: r, canonicalUrl, provider, leadId, instanceId: leadInstance, verificationState: state, handoff: "none",
	});

	const prior = await firstIntake(env, userId, canonicalUrl);
	if (input.dryRun) {
		const p = prior ? asReceipt(prior) : null;
		return answer(null, !!p, p?.leadId ?? null, p?.instanceId ?? instanceId, p ? await verificationStateOf(env, p.instanceId, p.leadId) : null, true);
	}
	// Claim the owner's one `created` receipt for this posting before anything is written (unique index).
	const id = crypto.randomUUID();
	const claimed = (await env.DB.prepare("INSERT INTO job_lead_intake_receipts (id, user_id, instance_id, canonical_url, provider, outcome) VALUES (?1, ?2, ?3, ?4, ?5, 'created') ON CONFLICT DO NOTHING")
		.bind(id, userId, instanceId, canonicalUrl, provider)
		.run()).meta?.changes;
	if (!claimed) {
		const first = asReceipt((await firstIntake(env, userId, canonicalUrl)) as Record<string, unknown>);
		await env.DB.prepare("INSERT INTO job_lead_intake_receipts (id, user_id, instance_id, canonical_url, provider, lead_id, outcome) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'duplicate')")
			.bind(id, userId, instanceId, canonicalUrl, provider, first.leadId)
			.run();
		return answer(await receipt(env, id), true, first.leadId, first.instanceId, await verificationStateOf(env, first.instanceId, first.leadId));
	}

	const at = new Date().toISOString();
	const intake: JobLeadLifecycleEntry = { from: null, to: "awaiting_browser_verification", action: "intake", version: 0, at, note: "owner_selected" };
	const data = {
		url: canonicalUrl,
		title: null,
		company: null,
		source: "manual_url",
		source_domain: new URL(canonicalUrl).hostname,
		intake: { kind: "owner_selected", receipt_id: id, at },
		status: "awaiting_browser_verification",
		lifecycle_version: 0,
		lifecycle: [intake],
		verification: { state: "awaiting_browser_verification", source: "manual_url", checked_at: null, canonical_job_url: canonicalUrl, active_apply_url: null, reason: "owner_selected_requires_browser_verification", evidence: null, attempts: 0 },
	};
	let lead: { id?: string; created?: boolean };
	try {
		const res = await env.AGENT.get(env.AGENT.idFromName(instanceId)).fetch(
			new Request("https://agent/collections/job_leads/records", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data }) }),
		);
		if (!res.ok) throw new Error(`The Scout could not store the lead (HTTP ${res.status}).`);
		lead = (await res.json()) as { id?: string; created?: boolean };
		if (typeof lead.id !== "string") throw new Error("The Scout stored no lead id.");
	} catch (e) {
		// Release the claim: nothing was created, so a retry must be able to create it.
		await env.DB.prepare("DELETE FROM job_lead_intake_receipts WHERE id = ?1").bind(id).run();
		throw e;
	}
	// The Scout already held this job (found in mail, or an intake before receipts existed): it keeps its own
	// lifecycle untouched, and this receipt says so rather than claiming a creation.
	if (lead.created === false) {
		await env.DB.prepare("UPDATE job_lead_intake_receipts SET outcome = 'duplicate', lead_id = ?2 WHERE id = ?1").bind(id, lead.id).run();
		return answer(await receipt(env, id), true, lead.id, instanceId, await verificationStateOf(env, instanceId, lead.id));
	}
	await env.DB.prepare("UPDATE job_lead_intake_receipts SET lead_id = ?2 WHERE id = ?1").bind(id, lead.id).run();
	// Through the Scout's #1049 site policy and per-site consent, like every lead the server cannot verify itself.
	await enqueueBrowserVerification(env, { instanceId, userId, leadId: lead.id, workKey: workKeyForLead(data), canonicalUrl, expectedTitle: null, expectedCompany: null, reason: "owner_selected" });
	return answer(await receipt(env, id), false, lead.id, instanceId, await verificationStateOf(env, instanceId, lead.id));
}
