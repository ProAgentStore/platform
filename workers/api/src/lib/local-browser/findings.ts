/**
 * Saving a local browser run's findings into the instance's collection — after the owner says so (#946).
 *
 * A run returns CANDIDATES. Nothing reaches the collection until the owner saves a finding, and a
 * finding whose key already exists there is reported as a duplicate first (#947: "surfaced before
 * collection write"); saving it anyway is a second, explicit choice.
 *
 * The key is the collection mapping's `keyField` — a field the finding carries, or one of its own
 * `url`/`title` — defaulting to `url`, which is what makes two findings the same thing for research.
 */
import { HttpError } from "../auth.js";
import type { Env } from "../../types.js";
import type { LocalBrowserFinding } from "./contract.js";
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
				detail: { runId: run.id, findingId: `${run.id}#${index}`, findingIndex: index, decision: review.decision, ...(review.collection ? { collection: review.collection } : {}), ...(review.recordId ? { recordId: review.recordId } : {}), ...(review.duplicateOf ? { duplicateOf: review.duplicateOf } : {}) },
			},
		],
		now,
	);
	return (await getLocalBrowserRun(env, instanceId, uid, run.id)) ?? run;
}
