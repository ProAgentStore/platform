/** The one-application Runner exception for #1010's intentionally paused handoff. */
import { capabilitiesForInstance } from "../agent-capabilities.js";
import type { JobApplication } from "../local-artifact/store.js";
import type { Env } from "../../types.js";

type Pipeline = { scouts: string[]; tailors: string[]; runners: string[] };

/**
 * A paused edge never joins the general pipeline. Its durable receipt can only add the Runner
 * that owns this owner's exact application, reviewed artifacts and existing fill run.
 */
async function receiptRunner(env: Env, uid: string, app: JobApplication): Promise<string | null> {
	if (!app.fillRunId) return null;
	const resume = app.resumeArtifact?.sha256?.toLowerCase();
	const cover = app.coverLetterArtifact?.sha256?.toLowerCase();
	if (!resume || !cover) return null;
	const { results } = await env.DB.prepare(
		`SELECT destination_runner_instance_id, resume_sha256, cover_letter_sha256
		   FROM application_material_transfers
		  WHERE user_id = ?1 AND source_application_id = ?2 AND source_tailor_instance_id = ?3
		  ORDER BY created_at DESC`,
	)
		.bind(uid, app.id, app.instanceId)
		.all<{ destination_runner_instance_id: string; resume_sha256: string; cover_letter_sha256: string }>();
	for (const receipt of results ?? []) {
		if (receipt.resume_sha256.toLowerCase() !== resume || receipt.cover_letter_sha256.toLowerCase() !== cover) continue;
		if ((await capabilitiesForInstance(env, receipt.destination_runner_instance_id, uid))?.runtime !== "local_apply") continue;
		const run = await env.DB.prepare(
			"SELECT id FROM local_apply_runs WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3 AND application_id = ?4",
		)
			.bind(app.fillRunId, receipt.destination_runner_instance_id, uid, app.id)
			.first<{ id: string }>();
		if (run) return receipt.destination_runner_instance_id;
	}
	return null;
}

/** Augment one application's enabled-edge pipeline without changing the paused connection. */
export async function pipelineForTargetedTransfer(env: Env, uid: string, pipeline: Pipeline, app: JobApplication): Promise<Pipeline> {
	const runner = await receiptRunner(env, uid, app);
	return runner && !pipeline.runners.includes(runner) ? { ...pipeline, runners: [...pipeline.runners, runner] } : pipeline;
}
