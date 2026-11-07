/**
 * Keep the Jobs app's tailored-application ledger in step with PAGS (#1586).
 *
 * The owner reviews tailored material in jobs.proappstore.online. PAGS stays the working copy (the
 * Runner uploads its files and the submit gate checks their hashes); this only mirrors it, through
 * Jobs `save_tailored_application` / `set_tailored_status` (jobs#19), called by the platform and
 * not the model, under the TAILOR instance's own MCP grant (lib/jobs-app.ts).
 *
 * Desired state, not events: `jobs_synced_key` records the "<tailoring run>|<status>" last mirrored, and
 * any application whose current state differs is (re)synced — inline when it changes, and by the
 * per-minute sweep after a failure, backed off. Failures are recorded on the row and surfaced in
 * pipeline health; nothing here throws into tailoring or submission.
 */
import type { Env } from "../types.js";
import { callJobsTool } from "./jobs-app.js";
import { clipMarked } from "./clip-marked.js";
import { PORTABLE_DOCUMENTS_MIN_CLI } from "./local-artifact/document-contract.js";
import { loadCloudDocuments } from "./local-artifact/cloud-documents.js";
import { getOwnedApplication, type JobApplication } from "./local-artifact/store.js";
import type { LocalArtifactFile, LocalArtifactLead } from "./local-artifact/contract.js";

export const JOBS_SYNC_RETRY_MS = 15 * 60_000;
const SWEEP_WINDOW_MS = 14 * 24 * 60 * 60_000;
/** PAGS status -> Jobs status. `materials_ready` is a (re)save, which keeps Jobs' own status. */
const JOBS_STATUS = { submitted: "submitted", failed: "failed", archived: "archived" } as const;

type SyncableStatus = "materials_ready" | keyof typeof JOBS_STATUS;
const isSyncable = (s: string): s is SyncableStatus => s === "materials_ready" || s in JOBS_STATUS;

/** The state to mirror, or null when there is nothing tailored to mirror. */
export function desiredJobsKey(app: Pick<JobApplication, "status" | "tailoringRunId" | "resumeArtifact" | "coverLetterArtifact">): string | null {
	if (!isSyncable(app.status) || !app.tailoringRunId || (!app.resumeArtifact && !app.coverLetterArtifact)) return null;
	return `${app.tailoringRunId}|${app.status}`;
}

const decode = (base64: string) => new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
const fileName = (f: LocalArtifactFile | null) => (f ? (f.cloud?.name ?? f.path.split(/[\\/]/).pop() ?? "") : "") || undefined;

/** The owner's answers for this application (latest per question), applied or not. */
async function ownerAnswers(env: Env, userId: string, applicationId: string): Promise<Array<{ question: string; answer: string }>> {
	const { results } = await env.DB.prepare("SELECT question, answer FROM owner_decisions WHERE user_id = ?1 AND scope = ?2 AND answered_at IS NOT NULL AND answer IS NOT NULL ORDER BY answered_at ASC, rowid ASC")
		.bind(userId, applicationId)
		.all<{ question: string; answer: string }>();
	const latest = new Map<string, string>();
	for (const r of results ?? []) latest.set(r.question, r.answer);
	return [...latest].map(([question, answer]) => ({ question, answer }));
}

async function saveArgs(env: Env, userId: string, app: JobApplication): Promise<Record<string, unknown>> {
	const lead = (app.lead ?? {}) as Partial<LocalArtifactLead>;
	const docs = (await loadCloudDocuments(env, userId, app, PORTABLE_DOCUMENTS_MIN_CLI)) ?? [];
	const text = (role: string) => {
		const d = docs.find((x) => x.role === role);
		return d ? decode(d.contentBase64) : undefined;
	};
	return {
		external_id: app.id,
		source_url: lead.leadUrl ?? lead.lead?.url ?? "",
		title: lead.lead?.title || "Untitled role",
		company_name: lead.lead?.company || "Unknown company",
		...(lead.lead?.location ? { location: lead.lead.location } : {}),
		...(text("resume") ? { resume_md: text("resume") } : {}),
		...(text("cover_letter") ? { cover_letter_md: text("cover_letter") } : {}),
		answers: JSON.stringify(await ownerAnswers(env, userId, app.id)),
		...(fileName(app.resumeArtifact) ? { resume_file_name: fileName(app.resumeArtifact) } : {}),
		...(fileName(app.coverLetterArtifact) ? { cover_letter_file_name: fileName(app.coverLetterArtifact) } : {}),
	};
}

async function record(env: Env, id: string, patch: { key?: string; error: string | null }, now: number): Promise<void> {
	await env.DB.prepare("UPDATE job_applications SET jobs_synced_key = COALESCE(?1, jobs_synced_key), jobs_sync_error = ?2, jobs_sync_at = ?3 WHERE id = ?4")
		.bind(patch.key ?? null, patch.error, now, id)
		.run();
}

/** Mirror one application to Jobs if its state differs from what was last mirrored. Never throws. */
export async function syncApplicationToJobs(env: Env, userId: string, applicationId: string, now = Date.now()): Promise<void> {
	try {
		const app = await getOwnedApplication(env, userId, applicationId);
		const key = app && desiredJobsKey(app);
		if (!app || !key) return;
		const prior = (await env.DB.prepare("SELECT jobs_synced_key AS k FROM job_applications WHERE id = ?1").bind(app.id).first<{ k: string | null }>())?.k ?? null;
		if (prior === key) return;
		const who = { userId, instanceId: app.instanceId };
		const fail = (step: string, out: { reason: string; detail: string }) => record(env, app.id, { error: clipMarked(`${out.reason === "no_grant" ? "no_grant" : step}: ${out.detail}`, 400) }, now);
		const saved = await callJobsTool(env, who, "save_tailored_application", await saveArgs(env, userId, app));
		if (!saved.ok) return void (await fail("save_tailored_application", saved));
		// A re-save keeps Jobs' status, so only a move AWAY from a recorded end state (a retried fill) or into one needs a status call.
		const status = app.status === "materials_ready" ? (prior && !prior.endsWith("|materials_ready") ? "tailored" : null) : JOBS_STATUS[app.status as keyof typeof JOBS_STATUS];
		if (status) {
			const submittedAt = app.status === "submitted" && app.submittedAt ? Date.parse(app.submittedAt) : NaN;
			const note = app.status === "archived" ? app.archiveReason : app.status === "failed" ? "The application run failed." : null;
			const set = await callJobsTool(env, who, "set_tailored_status", {
				external_id: app.id,
				status,
				...(note ? { note } : {}),
				...(Number.isFinite(submittedAt) ? { submitted_at: submittedAt } : {}),
			});
			if (!set.ok) return void (await fail("set_tailored_status", set));
		}
		await record(env, app.id, { key, error: null }, now);
	} catch (e) {
		await record(env, applicationId, { error: clipMarked(`sync: ${e instanceof Error ? e.message : String(e)}`, 400) }, now).catch(() => undefined);
	}
}

/** Per-minute backstop: retry applications whose mirrored state is behind, at most every 15 minutes each. */
export async function syncPendingToJobs(env: Env, now = Date.now(), limit = 10): Promise<number> {
	const { results } = await env.DB.prepare(
		`SELECT id, user_id FROM job_applications
		  WHERE status IN ('materials_ready', 'submitted', 'failed', 'archived') AND tailoring_run_id IS NOT NULL
		    AND (resume_artifact IS NOT NULL OR cover_letter_artifact IS NOT NULL)
		    AND COALESCE(jobs_synced_key, '') != tailoring_run_id || '|' || status
		    AND updated_at >= ?1 AND (jobs_sync_at IS NULL OR jobs_sync_at <= ?2)
		  ORDER BY updated_at DESC LIMIT ?3`,
	)
		.bind(now - SWEEP_WINDOW_MS, now - JOBS_SYNC_RETRY_MS, limit)
		.all<{ id: string; user_id: string }>();
	for (const r of results ?? []) await syncApplicationToJobs(env, r.user_id, r.id, now);
	return results?.length ?? 0;
}
