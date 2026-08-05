// A pipeline run as a generic board record (#207A).
//
// A pipeline run wrote `pipeline_runs` and nothing else, so a pipeline agent — the Lead Finder, the
// Outreach drafter, the Site Builder — was invisible to a supervisor and to the unified board, even
// while actively running. Same fix as #206, second domain: the domain WRITES a generic record; the
// supervisor keeps reading only platform records.
//
// This is the architectural test the ticket named. `subordinate_status` picks these cards up with
// NO supervision-side change at all — supervision never learns what a pipeline is.
import { closeWorkCards, upsertWorkCard } from "./work-card.js";
import type { Env } from "../types.js";

/** Stable per-run card id, so open and close address the same row. */
export const pipelineCardId = (runId: string): string => `prun-${runId}`;

/**
 * Board status for a run.
 *
 * `interrupted` maps to `cancelled` rather than passing through: `interrupted` is the pipeline
 * vocabulary's own word, and no default board column claims it, so it would fall through to the
 * catchAll (or to nothing, since DEFAULT_BOARD_COLUMNS has no catchAll) and read as uncategorised.
 */
export function pipelineCardStatus(runStatus: string): string {
	return runStatus === "interrupted" ? "cancelled" : runStatus;
}

export function pipelineRunTaskRecord(opts: {
	runId: string;
	pipeline: string;
	trigger: string;
	status: string;
	now: string;
	detail?: string;
}): Record<string, unknown> {
	const status = pipelineCardStatus(opts.status);
	return {
		id: pipelineCardId(opts.runId),
		type: "pipeline.run",
		status,
		title: `Pipeline: ${opts.pipeline}`.slice(0, 200),
		subtitle: opts.trigger,
		...(opts.detail ? { description: opts.detail.slice(0, 300) } : {}),
		createdAt: opts.now,
		updatedAt: opts.now,
		...(status === "running" ? {} : { completedAt: opts.now }),
	};
}

export async function upsertPipelineRunCard(
	env: Env,
	opts: { instanceId: string; userId: string; runId: string; pipeline: string; trigger: string; status: string; detail?: string },
): Promise<void> {
	const task = pipelineRunTaskRecord({ ...opts, now: new Date().toISOString() });
	await upsertWorkCard(env, { instanceId: opts.instanceId, userId: opts.userId, id: pipelineCardId(opts.runId), task });
}

/**
 * Close a run's card without needing its instance/user.
 *
 * `closeRun` is given only a runId — the owner lives on the row. Rather than make every caller
 * thread identity through, read it back from the run being closed. One extra read on a path that
 * already writes, and it keeps the choke point where the run's OWN lifecycle is (four close sites
 * in `workflows/pipeline-run.ts` alone; wiring each one is how #206's stranded cards happen).
 */
export async function closePipelineRunCard(env: Env, runId: string, status: string, detail?: string): Promise<void> {
	const row = await env.DB.prepare("SELECT user_id, instance_id, pipeline, trigger FROM pipeline_runs WHERE run_id = ?1")
		.bind(runId)
		.first<{ user_id: string; instance_id: string; pipeline: string; trigger: string }>()
		.catch(() => null);
	if (!row) return;
	// A full upsert, not a status patch: unlike a coding session's bulk close, this path HAS the
	// detail (the counts summary / failure reason), and that is the most useful thing on the card.
	if (detail) {
		await upsertPipelineRunCard(env, {
			instanceId: row.instance_id,
			userId: row.user_id,
			runId,
			pipeline: row.pipeline,
			trigger: row.trigger,
			status,
			detail,
		});
		return;
	}
	await closeWorkCards(env, row.instance_id, row.user_id, [pipelineCardId(runId)], pipelineCardStatus(status));
}
