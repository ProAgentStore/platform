/**
 * Saving a local browser run's findings into the instance's collection — after the owner says so (#946).
 *
 * A run returns CANDIDATES. In a general research collection nothing is written until the owner saves a
 * finding (a Job Search Scout's `job_leads` is the exception: the run writes them itself, see
 * `persistJobLeadFindings` below, #1096), and a
 * finding whose key already exists there is reported as a duplicate first (#947: "surfaced before
 * collection write"); saving it anyway is a second, explicit choice.
 *
 * The key is the collection mapping's `keyField` — a field the finding carries, or one of its own
 * `url`/`title` — defaulting to `url`, which is what makes two findings the same thing for research.
 */
import { HttpError } from "../auth.js";
import type { Env } from "../../types.js";
import type { LocalBrowserFinding } from "./contract.js";
import { readBrowserVerification } from "../browser-verification.js";
import { appliedWorkKeys, enqueueBrowserVerification } from "../job-lead-queue.js";
import { JOB_LEAD_COLLECTION, workKeyForLead } from "../job-lead-triage.js";
import { syncScanCard } from "./scan-board.js";
import { type FindingReview, type LocalBrowserRun, appendLocalBrowserEvents, consentIdForHost, getLocalBrowserRun, listDomainConsent, setFindingReview } from "./store.js";

export type FindingAction = "save" | "skip";

/** The value that identifies this finding in the collection, or null when it has none. */
export function findingKey(finding: LocalBrowserFinding, keyField: string): string | number | boolean | null {
	if (keyField in finding.fields) return finding.fields[keyField];
	if (keyField === "url" || keyField === "title" || keyField === "evidence") return finding[keyField];
	return null;
}

/** The record a saved finding becomes. Provenance rides along so a supervisor can trace it back. */
export function findingRecord(finding: LocalBrowserFinding, runId: string): Record<string, unknown> {
	return { ...finding.fields, title: finding.title, url: finding.url, evidence: finding.evidence, sourceRunId: runId };
}

function hostOf(url: string): string | null {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
}

function agentStub(env: Env, instanceId: string) {
	return env.AGENT.get(env.AGENT.idFromName(instanceId));
}

/** The id of a record already holding this key, or null. A missing collection holds nothing. */
async function existingRecord(env: Env, instanceId: string, collection: string, keyField: string, value: string | number | boolean): Promise<string | null> {
	const where = encodeURIComponent(JSON.stringify({ [keyField]: value }));
	const res = await agentStub(env, instanceId).fetch(new Request(`https://agent/collections/${encodeURIComponent(collection)}/records?where=${where}&limit=1`));
	if (!res.ok) return null;
	const body = (await res.json().catch(() => ({}))) as { records?: Array<{ id?: string }> };
	return body.records?.[0]?.id ?? null;
}

/**
 * Save or skip finding `index` of a finished run. `force` saves a finding already reported as a
 * duplicate. Returns the run with its updated reviews.
 */
export async function reviewFinding(env: Env, instanceId: string, uid: string, run: LocalBrowserRun, index: number, action: FindingAction, force = false, now = Date.now()): Promise<LocalBrowserRun> {
	const finding = run.result?.findings?.[index];
	if (!finding) throw new HttpError(404, `This run has no finding ${index}`);
	const prior = run.findingReviews[String(index)];
	if (prior?.decision === "saved") throw new HttpError(409, `Finding ${index} is already saved to ${prior.collection ?? "the collection"}`);
	let review: FindingReview;
	if (action === "skip") {
		review = { decision: "skipped", at: now };
	} else {
		const mapping = run.policy.collection;
		if (!mapping) throw new HttpError(409, "No results collection is set for this agent. Choose one in Settings → Local browser research, then save the finding.");
		const keyField = mapping.keyField ?? "url";
		const key = findingKey(finding, keyField);
		const duplicateOf = key !== null && !force ? await existingRecord(env, instanceId, mapping.name, keyField, key) : null;
		if (duplicateOf) {
			review = { decision: "duplicate", collection: mapping.name, duplicateOf, at: now };
		} else {
			const res = await agentStub(env, instanceId).fetch(
				new Request(`https://agent/collections/${encodeURIComponent(mapping.name)}/records`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: findingRecord(finding, run.id) }) }),
			);
			const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
			if (!res.ok || !body.id) throw new HttpError(502, `The finding could not be saved to ${mapping.name}: ${body.error ?? `HTTP ${res.status}`}`);
			review = { decision: "saved", collection: mapping.name, recordId: body.id, at: now };
		}
	}
	await recordReview(env, instanceId, uid, run, index, finding, review, now);
	const reviewed = (await getLocalBrowserRun(env, instanceId, uid, run.id)) ?? run;
	// The card's lead counts are the owner's decisions, so they move when a decision is made (#980).
	await syncScanCard(env, instanceId, uid, reviewed);
	return reviewed;
}

/** Store one finding's decision and put it on the run's own trace (#947) — the same for owner and platform. */
async function recordReview(env: Env, instanceId: string, uid: string, run: LocalBrowserRun, index: number, finding: LocalBrowserFinding, review: FindingReview, now: number): Promise<void> {
	await setFindingReview(env, instanceId, uid, run.id, index, review);
	// The supervisor's storage decision, on the run's own trace (#947) — with the owner's decision
	// that let the run onto the finding's site, when one did.
	const host = hostOf(finding.url);
	const consentId = host ? consentIdForHost(await listDomainConsent(env, instanceId, uid, now), host) : null;
	await appendLocalBrowserEvents(
		env,
		instanceId,
		uid,
		run.id,
		[
			{
				type: "review.decision",
				at: new Date(now).toISOString(),
				url: finding.url,
				...(host ? { domain: host } : {}),
				...(consentId ? { consentId } : {}),
				detail: {
					runId: run.id,
					findingId: `${run.id}#${index}`,
					findingIndex: index,
					decision: review.decision,
					...(review.collection ? { collection: review.collection } : {}),
					...(review.recordId ? { recordId: review.recordId } : {}),
					...(review.duplicateOf ? { duplicateOf: review.duplicateOf } : {}),
					...(review.reason ? { reason: review.reason } : {}),
					...(review.basis ? { basis: review.basis } : {}),
				},
			},
		],
		now,
	);
}

/**
 * Fields the job-lead lifecycle owns (status, triage, the apply handoff, application write-back,
 * verification, identity). A finding's `fields` are the CLI's reading of a page, and before #1096 an owner
 * looked at them before they were saved; written automatically, none of these may come from a page.
 */
const LIFECYCLE_FIELD = /^(status|lifecycle(_version)?|verification|work_key|intake|triage_.*|apply_.*|application_.*|defer_until|source_domain|sourceRunId)$/;

function leadFieldsOf(record: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(record).filter(([k]) => !LIFECYCLE_FIELD.test(k) || k === "sourceRunId"));
}

/**
 * A Job Search Scout's research run writes what it found into the job-lead pipeline itself (#1096).
 *
 * #946 made every finding wait for the owner to save it, which is right for a general research
 * collection — but for `job_leads` it meant a scan that found 26 matching jobs produced no lead at all
 * (run 1a01120e: `added 0, pending 26`), so nothing ever reached triage, the Tailor or the Runner. A
 * Scout's findings are now written when the run completes, exactly as the Gmail and manual-URL intakes
 * write theirs: through the Scout DO's create-or-get (one lead per work key), deduped first by the
 * mapping's key field, never over a job that already has an application.
 *
 *   browser verification OFF → `new`, triageable at once; `verification.state: research_observed`
 *                              (seen by this run's browser, not proven to have a live apply path)
 *   browser verification ON  → `awaiting_browser_verification`, AND queued in
 *                              job_lead_browser_verifications, so it becomes `new` only when verified
 *
 * Every finding ends with a decision on the run (saved / duplicate / skipped with a reason). One the
 * Scout could not store stays UNREVIEWED — still on the run, saveable with review_local_browser_finding —
 * and the scan's outcome says so; nothing is dropped. Other collections keep #946's owner review.
 * Idempotent: a finding already decided is never written twice.
 */
export async function persistJobLeadFindings(env: Env, instanceId: string, uid: string, run: LocalBrowserRun, now = Date.now()): Promise<LocalBrowserRun> {
	const mapping = run.policy.collection;
	const findings = run.result?.findings ?? [];
	if (run.status !== "completed" || mapping?.name !== JOB_LEAD_COLLECTION || !findings.length) return run;
	const keyField = mapping.keyField ?? "url";
	const verify = (await readBrowserVerification(env, instanceId, uid)).settings.enabled;
	const applied = await appliedWorkKeys(env, uid);
	const at = new Date(now).toISOString();
	for (const [index, finding] of findings.entries()) {
		if (run.findingReviews[String(index)]) continue;
		let review: FindingReview;
		const base = leadFieldsOf(findingRecord(finding, run.id));
		const workKey = workKeyForLead(base);
		const key = findingKey(finding, keyField);
		const duplicateOf = key !== null ? await existingRecord(env, instanceId, mapping.name, keyField, key) : null;
		if (duplicateOf) review = { decision: "duplicate", collection: mapping.name, duplicateOf, basis: "auto", at: now };
		else if (!workKey) review = { decision: "skipped", reason: "no_work_key", basis: "auto", at: now };
		else if (applied.has(workKey)) review = { decision: "skipped", reason: "prior_application", basis: "auto", at: now };
		else {
			const status = verify ? "awaiting_browser_verification" : "new";
			const data = {
				...base,
				source: typeof base.source === "string" && base.source ? base.source : "local_browser",
				source_domain: hostOf(finding.url),
				work_key: workKey,
				status,
				lifecycle_version: 0,
				lifecycle: [{ from: null, to: status, action: "intake", version: 0, at, note: "local_browser_research" }],
				intake: { kind: "local_browser_research", run_id: run.id, finding_index: index, at },
				verification: verify
					? { state: "awaiting_browser_verification", source: "local_browser_research", checked_at: null, canonical_job_url: finding.url, active_apply_url: null, reason: "browser_verification_on", evidence: null, attempts: 0 }
					: { state: "research_observed", source: "local_browser_research", checked_at: at, canonical_job_url: finding.url, active_apply_url: null, reason: "seen_by_research_run", evidence: null },
			};
			let stored: { id?: string; created?: boolean; error?: string };
			try {
				const res = await agentStub(env, instanceId).fetch(
					new Request(`https://agent/collections/${encodeURIComponent(mapping.name)}/records`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data }) }),
				);
				stored = (await res.json().catch(() => ({}))) as typeof stored;
				if (!res.ok || typeof stored.id !== "string") continue; // left unreviewed: still on the run, saveable by hand
			} catch {
				continue;
			}
			if (stored.created === false) review = { decision: "duplicate", collection: mapping.name, duplicateOf: stored.id, basis: "auto", at: now };
			else {
				review = { decision: "saved", collection: mapping.name, recordId: stored.id, basis: "auto", at: now };
				if (verify) {
					await enqueueBrowserVerification(env, {
						instanceId, userId: uid, leadId: stored.id as string, workKey, canonicalUrl: finding.url,
						expectedTitle: finding.title || null, expectedCompany: typeof finding.fields.company === "string" ? finding.fields.company : null, reason: "local_browser_research",
					}, now);
				}
			}
		}
		await recordReview(env, instanceId, uid, run, index, finding, review, now);
	}
	return (await getLocalBrowserRun(env, instanceId, uid, run.id)) ?? run;
}
