/**
 * Keep the owner's CV app (cv.proappstore.online) holding every tailored resume, cover letter and answer
 * set (#1624 phase 1, proappstore-online/cv#1).
 *
 * The same desired-state mirror as the Jobs one (lib/jobs-tailored.ts), with its own sync columns so the
 * two never block each other: `cv_synced_key` records the "<tailoring run>|<status>" last mirrored, and an
 * application whose current state differs is (re)synced inline when it changes and by the per-minute sweep
 * after a failure. Calls are CV `save_document` / `set_document_status`, made by the platform under the
 * TAILOR instance's own MCP grant (lib/jobs-app.ts). PAGS stays the working copy: the Runner still uploads
 * the sha-pinned Instance Files; CV is the owner's record. Nothing here throws into tailoring or submission.
 */
import type { Env } from "../types.js";
import { callAppTool, CV_MCP_URL } from "./jobs-app.js";
import { clipMarked } from "./clip-marked.js";
import { desiredJobsKey, fileName, JOBS_STATUS, JOBS_SYNC_RETRY_MS, ownerAnswers, tailoredTexts } from "./jobs-tailored.js";
import { getOwnedApplication, getTailorRun, type JobApplication } from "./local-artifact/store.js";
import { cvProvenance } from "./local-artifact/cv-sources.js";
import type { LocalArtifactLead } from "./local-artifact/contract.js";

const SWEEP_WINDOW_MS = 14 * 24 * 60 * 60_000;

/** One save_document call per document the application has: resume, cover letter, and the owner's answers. */
async function documents(env: Env, userId: string, app: JobApplication): Promise<Array<Record<string, unknown>>> {
	const lead = (app.lead ?? {}) as Partial<LocalArtifactLead>;
	const url = lead.leadUrl ?? lead.lead?.url ?? "";
	// A run built from the CV book (#1624 phase 2) records which revision and playbook produced these documents.
	const run = app.tailoringRunId ? await getTailorRun(env, app.instanceId, userId, app.tailoringRunId).catch(() => null) : null;
	const from = cvProvenance(run?.policy.uploadedSources);
	const common = {
		external_id: app.id,
		company: lead.lead?.company || "Unknown company",
		position: lead.lead?.title || "Untitled role",
		...(/^https?:\/\//.test(url) ? { job_url: url } : {}),
		...(from ? { book_revision: from.bookRevision, ...(from.playbookKind ? { playbook_kind: from.playbookKind } : {}), ...(from.region ? { region: from.region } : {}) } : {}),
	};
	const { resume, coverLetter } = await tailoredTexts(env, userId, app);
	const answers = await ownerAnswers(env, userId, app.id);
	const named = (f: JobApplication["resumeArtifact"]) => (fileName(f) ? { file_name: fileName(f) } : {});
	return [
		...(resume ? [{ ...common, kind: "resume", content_md: resume, ...named(app.resumeArtifact) }] : []),
		...(coverLetter ? [{ ...common, kind: "cover_letter", content_md: coverLetter, ...named(app.coverLetterArtifact) }] : []),
		...(answers.length ? [{ ...common, kind: "answers", content_md: answers.map((a) => `**${a.question}**\n\n${a.answer}`).join("\n\n") }] : []),
	];
}

async function record(env: Env, id: string, patch: { key?: string; error: string | null }, now: number): Promise<void> {
	await env.DB.prepare("UPDATE job_applications SET cv_synced_key = COALESCE(?1, cv_synced_key), cv_sync_error = ?2, cv_sync_at = ?3 WHERE id = ?4")
		.bind(patch.key ?? null, patch.error, now, id)
		.run();
}

/** Mirror one application to CV if its state differs from what was last mirrored. Never throws. */
export async function syncApplicationToCv(env: Env, userId: string, applicationId: string, now = Date.now()): Promise<void> {
	try {
		const app = await getOwnedApplication(env, userId, applicationId);
		const key = app && desiredJobsKey(app);
		if (!app || !key) return;
		const prior = (await env.DB.prepare("SELECT cv_synced_key AS k FROM job_applications WHERE id = ?1").bind(app.id).first<{ k: string | null }>())?.k ?? null;
		if (prior === key) return;
		const who = { userId, instanceId: app.instanceId };
		const fail = (step: string, out: { reason: string; detail: string }) => record(env, app.id, { error: clipMarked(`${out.reason === "failed" ? step : out.reason}: ${out.detail}`, 400) }, now);
		for (const doc of await documents(env, userId, app)) {
			const saved = await callAppTool(env, who, CV_MCP_URL, "save_document", doc);
			if (!saved.ok) return void (await fail("save_document", saved));
		}
		// A re-save keeps CV's status, so only a move AWAY from a recorded end state (a retried fill) or into one needs a status call.
		const status = app.status === "materials_ready" ? (prior && !prior.endsWith("|materials_ready") ? "tailored" : null) : JOBS_STATUS[app.status as keyof typeof JOBS_STATUS];
		if (status) {
			const submittedAt = app.status === "submitted" && app.submittedAt ? Date.parse(app.submittedAt) : NaN;
			const note = app.status === "archived" ? app.archiveReason : app.status === "failed" ? "The application run failed." : null;
			const set = await callAppTool(env, who, CV_MCP_URL, "set_document_status", {
				external_id: app.id,
				status,
				...(note ? { note } : {}),
				...(Number.isFinite(submittedAt) ? { submitted_at: submittedAt } : {}),
			});
			if (!set.ok) return void (await fail("set_document_status", set));
		}
		await record(env, app.id, { key, error: null }, now);
	} catch (e) {
		await record(env, applicationId, { error: clipMarked(`sync: ${e instanceof Error ? e.message : String(e)}`, 400) }, now).catch(() => undefined);
	}
}

/** Per-minute backstop: retry applications whose CV copy is behind, at most every 15 minutes each. */
export async function syncPendingToCv(env: Env, now = Date.now(), limit = 10): Promise<number> {
	const { results } = await env.DB.prepare(
		`SELECT id, user_id FROM job_applications
		  WHERE status IN ('materials_ready', 'submitted', 'failed', 'archived') AND tailoring_run_id IS NOT NULL
		    AND (resume_artifact IS NOT NULL OR cover_letter_artifact IS NOT NULL)
		    AND COALESCE(cv_synced_key, '') != tailoring_run_id || '|' || status
		    AND updated_at >= ?1 AND (cv_sync_at IS NULL OR cv_sync_at <= ?2)
		  ORDER BY updated_at DESC LIMIT ?3`,
	)
		.bind(now - SWEEP_WINDOW_MS, now - JOBS_SYNC_RETRY_MS, limit)
		.all<{ id: string; user_id: string }>();
	for (const r of results ?? []) await syncApplicationToCv(env, r.user_id, r.id, now);
	return results?.length ?? 0;
}
